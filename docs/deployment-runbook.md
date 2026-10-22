# ChowBot deployment and recovery runbook

Operational steps for the hosted HTTP server (`dist/http.js`) and the recovery CLI
(`dist/cli/recovery.js`). Live ordering (`place_order` and `start_payment`) is **on** by
default in the hosted server; `CHOWBOT_PLACE_ORDER_ENABLED=false` turns both off (kill switch).

Never print secrets. Never pass a credential as a command-line argument
(`docker exec -e TOKEN=…`, `--note "token"`): it lands in shell history and process listings.

---

## 1. Build from a finalized release revision

1. Commit everything that should ship, and tag the release. `docker build .` copies the
   **working tree** (`COPY . .`), so build only from a clean checkout of the tag:
   ```sh
   git status --short            # must print nothing
   git rev-parse HEAD            # record this
   ```
2. Verify the revision (needs `TEST_DATABASE_URL` pointing at a disposable database):
   ```sh
   bun install --frozen-lockfile
   bun run typecheck && bun test && bun run db:check
   ```
   Expect 0 failures and 0 skipped tests (skips mean `TEST_DATABASE_URL` is unset).
3. Build the image and record its digest:
   ```sh
   docker build -t chowbot:<tag> .
   docker image inspect chowbot:<tag> --format '{{.Id}}'
   ```
4. Smoke-test the artifact **from the image** (local only; no Chowdeck traffic, no `.env`):
   ```sh
   id=$(docker create chowbot:<tag>)
   mkdir -p .artifact-check && docker cp "$id":/app/dist .artifact-check/dist && docker rm "$id"
   CHOWBOT_HTTP_ARTIFACT=.artifact-check/dist/http.js bun test tests/http.test.ts -t "built artifact"
   rm -rf .artifact-check
   ```
   The path must be **relative to the repository root**, and the whole `dist/` directory is
   needed (the server reads its icon file at start-up).

## 2. Database backup and migrations

Migrations run automatically at server start-up, **before** the server listens. Drizzle's
migrator takes no lock and has no down-migrations, so:

1. **Take a backup or snapshot** of the production database. Restoring it is the only schema
   rollback.
2. Check the current level (read-only):
   ```sql
   SELECT id, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at;
   ```
   Expected after deploy: 7 rows, the last `created_at` = `1792574113737`
   (`0006_paid_after_release_and_bootstrap`).
3. Requirements: PostgreSQL ≥ 13, and the app's role may create a schema (`drizzle`),
   functions and triggers (migration 0005).
4. **Run exactly one replica** for any deploy that applies migrations. Scale up only after
   step 2's query shows all 7 rows, and the following succeeds:
   ```sql
   SELECT tgname FROM pg_trigger
   WHERE tgrelid = 'order_submission_recoveries'::regclass AND NOT tgisinternal;
   -- order_submission_recoveries_no_update_or_delete, order_submission_recoveries_no_truncate
   ```

## 3. Production environment

| Variable | Set to | Notes |
|---|---|---|
| `DATABASE_URL` | secret | Include `sslmode=verify-full` for a networked database (Bun's default is no TLS). |
| `CHOWBOT_ENCRYPTION_KEY` | secret, 32 bytes base64 | Same value on every replica. **Never rotate or lose it**: stored sessions, quotes and confirmations depend on it. |
| `MCP_SERVER_URL` | public `https://…/mcp` | Tokens are bound to it. The default is localhost. |
| `OAUTH_ISSUER_URL` | optional | Defaults to the origin of `MCP_SERVER_URL`; must be on the same host. |
| `PORT` | optional | Default 2800. |
| `CHOWBOT_SHUTDOWN_GRACE_MS` | optional | Default: Chowdeck request timeout + 10 s (25 s). See §4. |
| `CHOWBOT_PLACE_ORDER_ENABLED` | unset (on), or `false` (off) | Kill switch for `place_order` **and** `start_payment`. Any value other than `true`/`false` turns both off, with a warning. |
| `CHOWBOT_PAYMENT_CHANNEL_METHODS` | unset | Defaults to the captured value, the **empty string**. If set, any other value turns live ordering off. |
| `CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER` | unset | Defaults to the captured `NG`. If set, any other value turns live ordering off. |

`start_payment` follows the same switch and uses the Chowdeck website's own redirect pages
(`https://chowdeck.com/store/ongoing-order?orderId=<id>` and `/store/checkout?status=failed`).

Check the place_order settings without exposing secrets:
```sh
docker exec <container> env | grep -E '^CHOWBOT_(PLACE_ORDER|PAYMENT_CHANNEL|SHUTDOWN)'
```
Some platforms drop variables whose value is empty. Leaving both channel variables unset avoids
this. If only one of them reaches the server, live ordering turns off and start-up logs
"…not both set to the captured values…".

## 4. Probes, shutdown and proxies

- **Liveness:** `GET /healthz` → `200 {"status":"ok"}`. Never touches the database.
- **Readiness:** `GET /readyz` → `200 {"status":"ready"}`, or `503 {"status":"not_ready"}`
  while shutting down or when a 2 s database ping fails.
- **Shutdown:** on `SIGTERM`/`SIGINT` the server stops accepting connections, answers new
  requests on open connections with `503 server_shutting_down`, lets requests in flight
  finish within `CHOWBOT_SHUTDOWN_GRACE_MS`, closes the database pool and exits 0. If the
  grace period expires it exits 1; an order request cut off this way keeps its marker and is
  reported as an unknown outcome (§7.1). **Nothing is ever retried.**
- **The platform stop timeout must exceed the grace period.** `docker stop` waits only
  10 s by default: use `docker stop -t 40` (or `stop_grace_period: 40s` in Compose,
  `terminationGracePeriodSeconds: 40` in Kubernetes).
- **Do not deploy or restart during a controlled order test.**
- **Proxy trust (decision pending).** `trust proxy` is unset, so behind a reverse proxy every
  client appears as the proxy's address, and all users share one rate-limit budget
  (100 requests per minute per instance). express-rate-limit logs
  `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` when this happens. The fix needs the real topology:
  the exact number of proxy hops in front of the app (e.g. `1`), or the proxies' exact
  addresses/CIDRs. Never use `true`: clients could then spoof `X-Forwarded-For` and bypass
  rate limiting. Leave it unchanged until the topology is confirmed.

## 5. Operators

Run the CLI inside the container with an **interactive** shell, not as a job whose output is
collected into logs.

1. **Bootstrap immediately after the first successful start**, before announcing the
   service. Until an operator exists, anyone with database access can bootstrap; afterwards
   bootstrap is closed for good, even if every operator is later disabled.
   ```sh
   docker exec -it <container> bun dist/cli/recovery.js operator add <name>
   ```
   The `cbop_…` credential is printed **once**; only its argon2id hash is stored. Put it in
   the password manager.
2. Confirm (read-only):
   ```sql
   SELECT name, bootstrap, disabled_at, created_at FROM admin_operators;
   -- exactly one row with bootstrap = true
   ```
3. Authenticate, inside the container:
   ```sh
   docker exec -it <container> sh
   export CHOWBOT_OPERATOR=<name>
   read -rs CHOWBOT_OPERATOR_TOKEN; export CHOWBOT_OPERATOR_TOKEN
   bun dist/cli/recovery.js show 00000000-0000-4000-8000-000000000000
   ```
   "No order attempt has that id." means authentication works; "Operator authentication
   failed." means it does not.
4. **Add a second operator** from that authenticated shell:
   `bun dist/cli/recovery.js operator add <second-name>`. Disable a leaver with
   `bun dist/cli/recovery.js operator disable <name>`.

## 6. Verify the registered tools

The authoritative check is an authenticated `tools/list`. Connect an MCP client to
`MCP_SERVER_URL`, sign in through ChowBot's normal OAuth flow, and list tools. With a bearer
token from that client (read it without echoing):
```sh
read -rs TOKEN
curl -s "$MCP_SERVER_URL" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
Expected by default: `place_order`, `start_payment`, `get_order_submission`,
`resolve_order_submission` and `preview_order` present. With the kill switch set to `false`,
`place_order` and `start_payment` are absent.

## 7. Incidents

Read-only overview of attempts holding a cart lock:
```sql
SELECT id, user_id, vendor_id, state, chowdeck_order_id, order_request_started_at,
       payment_started_at, payment_start_state
FROM order_submissions
WHERE lock_released_at IS NULL AND state IN ('submitting', 'created', 'unknown')
ORDER BY created_at;
```

### 7.1 Ambiguous order result ("The order's outcome is unknown")
1. **Never place the order again** and never replay the request. Chowdeck has no
   idempotency, and the cart survives order creation.
2. Ask the user to look for the order in the Chowdeck app. If they find it, they run
   `resolve_order_submission` with `outcome: link_order` and the order id. ChowBot verifies
   it with Chowdeck (same restaurant, created after the attempt), and the attempt becomes
   `created`.
3. Note that an **unpaid** order did not appear in either Chowdeck order list when observed,
   so it may not be findable. If it cannot be found, wait **24 hours** after the order request
   started, then an operator runs `show <attempt-id>`, followed by
   `abandon <attempt-id> --reason user_reported_no_order` (or `user_accepts_duplicate_risk`)
   `--note "<why>" --acknowledge-duplicate-risk`.

### 7.2 Stuck lock
- `submitting` with no order request started is released automatically two minutes after
  the claim, the next time `get_order_submission` runs for that restaurant.
- `submitting` with the order request started, or `unknown`: follow §7.1.
- `created`: follow §7.3.
- Marking an attempt **abandoned** releases its cart lock only. It does **not** cancel,
  refund or change anything on Chowdeck. The attempt keeps its state, order id and evidence.
  For 7 days it stays visible in `get_order_submission`, and `place_order` keeps warning
  about it and asks for an extra acknowledgement. Every abandonment writes an append-only
  audit row:
  ```sql
  SELECT r.created_at, o.name AS operator, r.submission_id, r.reason_code, r.lookup_outcome
  FROM order_submission_recoveries r JOIN admin_operators o ON o.id = r.operator_id
  ORDER BY r.created_at DESC;
  ```

### 7.3 Unpaid order (`created`)
1. Pay with `start_payment`. Every client gets the OPay link in the tool result, only after
   Chowdeck answers the start with a valid https link; it is never offered through URL
   elicitation. If it
   refuses because Chowdeck cannot confirm the order is unpaid, the order could not be read by
   id; report that, as it decides how payment must work. Whether the user can find and pay the
   order in the Chowdeck app instead is **unknown**.
2. `get_order_submission` checks Chowdeck for payment and records it only on authoritative
   evidence (payment status `success` or a `MADE_PAYMENT` timeline step).
3. If the user will not pay: `abandon <attempt-id> --reason user_reported_abandoned`. If the
   order cannot be read from Chowdeck: `--reason order_not_retrievable` (accepted only when
   the read-only lookup actually fails). If Chowdeck shows it paid, `abandon` refuses and
   records the payment instead.
4. A payment Chowdeck confirms within 7 days after abandonment is still recorded, beside the
   attempt.

## 8. Controlled order test, disabling, and rollback

1. **Prerequisites:** the proxy-trust decision (§4); a written plan for how the test order
   will be paid or abandoned (§7.3); a deploy freeze; two working operators.
2. **Enabled by default** (single replica): leave `CHOWBOT_PLACE_ORDER_ENABLED` and the channel
   variables unset. Confirm start-up logs show **no** "live ordering is off" warning, and that §6
   lists `place_order` and `start_payment`.
3. **Disable if needed:** set `CHOWBOT_PLACE_ORDER_ENABLED=false`, restart, and confirm §6 no
   longer lists either tool. Resolve any test attempt with §7.
4. **Rollback boundary:** migrations 0004–0006 first shipped in commit `1db9ad5`. **Never roll
   back to an image older than `1db9ad5`** once they are applied: older code does not
   understand abandoned attempts. An image built from `1db9ad5` itself is schema-compatible,
   and in it `place_order` **cannot** be enabled at all (it treats the captured empty
   `methods` value as missing), so it is a safe kill switch. It predates `/healthz` and
   `/readyz`, so point probes at `/.well-known/oauth-protected-resource/mcp` before rolling
   back to it. Prefer rolling back to the previous tagged release built after it.
