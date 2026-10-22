# ChowBot deployment and recovery runbook

Operational steps for the hosted HTTP server (`dist/http.js`) and the recovery CLI
(`dist/cli/recovery.js`). Live ordering (`place_order`, `start_payment` and `cancel_order`) is
**on** by default in the hosted server; `CHOWBOT_PLACE_ORDER_ENABLED=false` turns all three off
(kill switch).

**Chowdeck is the source of truth.** An order's state (`order_created`,
`payment_link_generated`, `payment_pending`, `payment_confirmed`, `cancelled`, `unknown`) is
always read from Chowdeck's order record (`GET /customer/order/{id}`). ChowBot's database,
a payment-start response, a user's statement or a tool call succeeding is never evidence that
an order is paid or cancelled. When the order cannot be read, the state is `unknown`, which is
not unpaid, paid or cancelled.

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
   Expected after deploy: 8 rows, the last `created_at` = `1792674522099`
   (`0007_promo_and_cancellation`).
3. Requirements: PostgreSQL ≥ 13, and the app's role may create a schema (`drizzle`),
   functions and triggers (migration 0005).
4. **Run exactly one replica** for any deploy that applies migrations. Scale up only after
   step 2's query shows all 8 rows, and the following succeeds:
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
| `CHOWBOT_PLACE_ORDER_ENABLED` | unset (on), or `false` (off) | Kill switch for `place_order`, `start_payment` **and** `cancel_order`. Any value other than `true`/`false` turns them off, with a warning. |
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
Expected by default: `place_order`, `start_payment`, `cancel_order`, `get_order_submission`,
`resolve_order_submission`, `get_checkout_quote`, `list_promo_codes`, `preview_order` and
`track_order` present. With the kill switch set to `false`, `place_order`, `start_payment` and
`cancel_order` are absent.

## 7. Incidents

Read-only overview of attempts holding a cart lock:
```sql
SELECT id, user_id, vendor_id, state, chowdeck_order_id, order_request_started_at,
       payment_started_at, payment_start_state, promo_code, cancel_requested_at,
       cancel_request_state
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
1. Pay with `start_payment`, in two calls. The first sends nothing: it reads the order from
   Chowdeck and returns the total on Chowdeck's order record (`total_price`, with any
   discount) as `confirmed_total`. Only after the user accepts that amount does the second call
   (with `confirmed_total`) re-read the order and start the payment, once. If Chowdeck's total
   changed in between, nothing is started and the new total must be confirmed. Every client
   gets the OPay link in the tool result, only after Chowdeck answers the start with a valid
   https link; it is never offered through URL elicitation. If OPay's `amountInLowerUnits`
   differs from the confirmed total, the result carries a `warning` to show the user.
2. `get_order_submission` reads every order ChowBot placed at the restaurant freshly from
   Chowdeck and records payment or cancellation only on authoritative evidence (payment status
   `success`; a status containing `cancel`). A `MADE_PAYMENT` timeline step is not evidence, as
   Chowdeck lists it on unpaid orders; an unpaid order shows status `abandoned` seconds after
   creation and is still payable.
3. If the user does not want it: `cancel_order` (§7.4). Editing or clearing the cart never
   cancels an order: Chowdeck keeps an order as it was placed, and the cart stays active and
   editable (observed: one cart was reused for six unpaid orders).
4. If cancellation is refused or unavailable and the user will not pay:
   `abandon <attempt-id> --reason user_reported_abandoned`. If the order cannot be read from
   Chowdeck: `--reason order_not_retrievable` (accepted only when the read-only lookup actually
   fails). If Chowdeck shows it paid, `abandon` refuses and records the payment instead.
5. A payment Chowdeck confirms within 7 days after abandonment is still recorded, beside the
   attempt.

### 7.4 Cancelling an unpaid order (`cancel_order`)
1. Only an order ChowBot created and still tracks, and which Chowdeck's order record shows
   unpaid, can be cancelled. A paid order is refused with the options Chowdeck supports
   (ChowBot cannot cancel, change or refund it; the user uses the Chowdeck app). An `unknown`
   reading is refused: nothing is sent when the order cannot be shown unpaid.
2. The first call sends nothing and returns a summary and a confirmation code; the second,
   after the user's explicit yes, commits `cancel_requested_at` and sends
   `POST /customer/order/{id}/cancel` **exactly once**. No payment can be started after the
   marker is set, and a second cancellation is never sent.
3. The order is then read again. Only when Chowdeck's order record shows it cancelled does the
   attempt become `cancelled`, which frees the cart lock. A success answer alone is recorded as
   `cancel_request_state = 'accepted'` and reported as **unconfirmed**; a 4xx as `rejected`; a
   timeout, 5xx, 401 or unexpected body as `unknown`. Never retry: check later with
   `get_order_submission`, which records the cancellation once Chowdeck shows it (also when the
   user cancelled in the app).
4. If a payment link was generated, the summary warns that a payment made after cancelling is
   not handled by ChowBot.

### 7.5 Promo codes
- `list_promo_codes` lists the account's codes (`GET /customer/promo-code`) and discounts
  (`GET /customer/discount`) with ChowBot's reading of validity, expiry, usage and restaurant
  limits. That reading is not a discount.
- A code is applied only in `get_checkout_quote` with `promo_code`: it must be on the account
  (ChowBot does not redeem new codes), and Chowdeck's `POST /customer/discount/apply`, sent once
  with the fresh quote's `fee_id` and `final_delivery_amount`, must return a discount naming that
  code. Only then is the quote orderable; it stores `promo_code` and `promo_discount`, and every
  older unconfirmed quote for the cart is marked `failed` / `superseded`.
- A promo is refused while the user has an unpaid or unresolved order at the restaurant: a code
  cannot be added to an existing order, and ChowBot never creates a second order to apply one.
- `place_order` sends the quote's code; after creation it reads the order and warns when
  Chowdeck's total or listed promo codes differ from what the user confirmed. `start_payment`
  then shows Chowdeck's own total before any payment.

## 8. Controlled order test, disabling, and rollback

Chowdeck behaviour that still needs a controlled live check (with a deliberately unpaid test
order, never a real payment unless planned):
- `POST /customer/order/{id}/cancel`: its body (ChowBot sends none), eligibility, response, and
  which order status a cancelled order shows (ChowBot reads any status containing `cancel`).
- Whether `total_price` on an unpaid order's record already includes a promo discount (the
  observed OPay start charged the discounted amount, 636000 for 701000 minus 65000).
- Whether `promo_codes` on the order record lists an applied code, and whether usage of a
  single-use code is consumed at order creation or at payment (the website created three
  unpaid orders with `5FOR5`, whose maximum usage is 1).
- What the cart shows (`order_id`, `status`) after an order from it is **paid**.
- `GET /customer/order/{id}/live-tracking` during a real delivery: the `rider` and
  `rider_location` fields (only seen as null; `track_order` keeps an allowlist of likely names)
  and the `delivery_status` values.
- Whether a timeline step's `time` is set once that stage is reached (on an unpaid order every
  step had `time: null`; `track_order` never reports a listed step as reached).


1. **Prerequisites:** the proxy-trust decision (§4); a written plan for how the test order
   will be paid or abandoned (§7.3); a deploy freeze; two working operators.
2. **Enabled by default** (single replica): leave `CHOWBOT_PLACE_ORDER_ENABLED` and the channel
   variables unset. Confirm start-up logs show **no** "live ordering is off" warning, and that §6
   lists `place_order` and `start_payment`.
3. **Disable if needed:** set `CHOWBOT_PLACE_ORDER_ENABLED=false`, restart, and confirm §6 no
   longer lists either tool. Resolve any test attempt with §7.
4. **Migration 0007** (promo columns, the `cancelled` state, `superseded` quotes and the
   cancellation marker) is additive. The previous release runs against it, but it neither
   cancels nor reads promo codes: a quote with a promo code saved by this release would be
   placed without the code (quotes expire within five minutes), and a `cancelled` attempt is
   simply not shown.
5. **Rollback boundary:** migrations 0004–0006 first shipped in commit `1db9ad5`. **Never roll
   back to an image older than `1db9ad5`** once they are applied: older code does not
   understand abandoned attempts. An image built from `1db9ad5` itself is schema-compatible,
   and in it `place_order` **cannot** be enabled at all (it treats the captured empty
   `methods` value as missing), so it is a safe kill switch. It predates `/healthz` and
   `/readyz`, so point probes at `/.well-known/oauth-protected-resource/mcp` before rolling
   back to it. Prefer rolling back to the previous tagged release built after it.
