import type { Server as BunServer } from "bun";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { ChowdeckClient } from "../../../lib/client";
import { createKeyring } from "../../../lib/encryption";
import { createDrizzle } from "../../../lib/postgres/database";
import { migrate } from "../../../lib/postgres/migrations";
import { createPostgresStores } from "../../../lib/postgres";
import RecoveryService from "../../../features/recovery/service";
import { createTestDatabase, describePostgres } from "../../helpers/postgres";
import { PostgresOperatorStore, PostgresRecoveryStore } from "../../../lib/postgres/recovery";
import type { Operator } from "../../../lib/recovery";

/*
 * Operator recovery against PostgreSQL. Only Chowdeck is mocked; every
 * lookup is a read (GET) of the attempt's own order.
 */

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;
type Handler = () => Response | Promise<Response>;

const ORDER_ID = 7001326;
const keyring = createKeyring(randomBytes(32));

let database: TestDatabase;
let sql: ReturnType<TestDatabase["connect"]>;
let stores: ReturnType<typeof createPostgresStores>;
let recoveries: PostgresRecoveryStore;
let operators: PostgresOperatorStore;
let operator: Operator;
let chowdeck: BunServer<undefined>;
let received: { method: string; path: string; authorization: string | null }[];
let routes: Map<string, Handler>;
let service: RecoveryService;
let orderIds = ORDER_ID;
let cartIds = 1;

const route = (key: string, handler: Handler) => routes.set(key, handler);

const orderDetail = (orderId: number, overrides: Record<string, unknown> = {}) => () =>
  Response.json({ status: "success", data: { id: orderId, vendor_id: 102555, status: "pending", created_at: new Date().toISOString(), ...overrides } });

const timeline = (actions: string[]) => () => Response.json({ data: actions.map((action) => ({ action })) });

const newUser = async (signedIn = true) => {
  const userId = await stores.users.findOrCreateByPhone(`080${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`);
  if (signedIn) await stores.sessions.set(userId, { token: `secret-token-${userId}`, phone: "x" });
  return userId;
};

/*
 * An attempt as place_order leaves it. created attempts get a fresh order id
 * whose lookup is scripted as unpaid unless the test says otherwise.
 */
const seed = async (state: string, overrides: Record<string, unknown> = {}, userId?: string) => {
  const owner = userId ?? (await newUser());
  const sent = !["quoted", "confirmation_pending"].includes(state) && !(state === "failed");
  const orderId = state === "created" || state === "paid" ? ++orderIds : null;
  const [row] = await sql`INSERT INTO order_submissions ${sql({
    user_id: owner, vendor_id: 102555, cart_id: ++cartIds, fee_id: 99887766, address_binding: "PRIVATE-binding",
    cart_fingerprint: "fingerprint", computed_total: 554000, quote_expires_at: new Date(Date.now() + 300_000), state,
    payment_method_id: 4242, payment_channel_name: "opay", chowdeck_order_id: orderId,
    confirmation_nonce_hash: "PRIVATE-nonce-hash",
    confirmation_consumed_at: state === "quoted" ? null : new Date(),
    order_request_started_at: sent ? new Date(Date.now() - 25 * 3600_000) : null,
    ...(state === "failed" && { failure_reason: "gate_rejected" }),
    ...overrides,
  })} RETURNING *`;
  if (orderId) {
    route(`GET /customer/order/${orderId}`, orderDetail(orderId));
    route(`GET /customer/order/${orderId}/timeline`, timeline(["ORDER_CREATED"]));
  }
  return { ...row, chowdeck_order_id: orderId } as Record<string, unknown> & { id: string; user_id: string; chowdeck_order_id: number | null };
};

const row = async (id: string) => (await sql`SELECT * FROM order_submissions WHERE id = ${id}`)[0];
const audits = async (id: string) => sql`SELECT * FROM order_submission_recoveries WHERE submission_id = ${id}`;

const release = (attemptId: string, overrides: Partial<Parameters<RecoveryService["release"]>[0]> = {}) =>
  service.release({
    operator,
    attemptId,
    reasonCode: "user_accepts_duplicate_risk",
    note: "User confirmed by phone they accept the duplicate-order risk.",
    acknowledgeDuplicateRisk: true,
    ...overrides,
  });

describePostgres("operator recovery (PostgreSQL)", () => {
  beforeAll(async () => {
    database = await createTestDatabase();
    sql = database.connect();
    await migrate(sql);
    stores = createPostgresStores(sql, keyring);
    const db = createDrizzle(sql);
    recoveries = new PostgresRecoveryStore(db);
    operators = new PostgresOperatorStore(db);
    operator = await operators.add("ops-alice", "$argon2id$placeholder-hash");
    chowdeck = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        received.push({ method: req.method, path: url.pathname, authorization: req.headers.get("authorization") });
        const handler = routes.get(`${req.method} ${url.pathname}`);
        return handler ? handler() : Response.json({ message: "unexpected request" }, { status: 500 });
      },
    });
    service = new RecoveryService(
      recoveries,
      stores.orderSubmissions,
      stores.sessions,
      new ChowdeckClient({ baseUrl: chowdeck.url.origin, timeoutMs: 1000 }),
    );
  });

  afterAll(async () => {
    chowdeck.stop(true);
    await database.drop();
  });

  beforeEach(() => {
    received = [];
    routes = new Map();
  });

  describe("releasing a created, unpaid order", () => {
    test("checks Chowdeck read-only, releases only the lock, and appends the audit record", async () => {
      const attempt = await seed("created", {
        resolution: "linked_user_supplied_order", evidence_order_status: "pending", evidence_payment_status: null,
        evidence_checked_at: new Date(),
      });
      const before = await row(attempt.id);

      const outcome = await release(attempt.id, { reasonCode: "user_reported_abandoned" });

      expect(outcome.released).toBe(true);
      expect(received.every((r) => r.method === "GET")).toBe(true);
      expect(received[0]!.authorization).toBe(`Bearer secret-token-${attempt.user_id}`);

      const after = await row(attempt.id);
      expect(after.lock_released_at).toBeInstanceOf(Date);
      expect(after.lock_release_reason).toBe("operator_released");
      for (const column of Object.keys(before)) {
        if (["lock_released_at", "lock_release_reason", "updated_at"].includes(column)) continue;
        expect(after[column]).toEqual(before[column]);
      }

      const [audit] = await audits(attempt.id);
      expect(audit.operator_id).toBe(operator.id);
      expect(audit.user_id).toBe(attempt.user_id);
      expect(audit.reason_code).toBe("user_reported_abandoned");
      expect(audit.note).toBe("User confirmed by phone they accept the duplicate-order risk.");
      expect(audit.duplicate_risk_acknowledged).toBe(true);
      expect(audit.lookup_outcome).toBe("unpaid");
      expect(audit.lookup_order_status).toBe("pending");
      expect(audit.lookup_payment_status).toBeNull();
      expect(audit.attempt_snapshot).toMatchObject({
        id: attempt.id, state: "created", chowdeck_order_id: attempt.chowdeck_order_id,
        resolution: "linked_user_supplied_order", evidence_order_status: "pending",
      });
      expect(audit.attempt_snapshot.order_request_started_at).toBe((before.order_request_started_at as Date).toISOString());
      const snapshot = JSON.stringify(audit.attempt_snapshot);
      expect(snapshot).not.toContain("PRIVATE-");
      expect(snapshot).not.toContain("99887766");
    });

    test("discloses that the order may still be payable, a started payment page may still work, and never claims a cancellation", async () => {
      const attempt = await seed("created", { payment_started_at: new Date(), payment_start_state: "started" });

      const outcome = await release(attempt.id, { reasonCode: "user_reported_cancelled_in_app" });

      expect(outcome.released).toBe(true);
      const [audit] = await audits(attempt.id);
      expect(audit.reason_code).toBe("user_reported_cancelled_in_app");
      expect(audit.disclosure).toContain("Marking this attempt abandoned means ChowBot stops tracking it");
      expect(audit.disclosure).toContain("Abandoned is not cancelled: it does not cancel, refund or change anything on Chowdeck");
      expect(audit.disclosure).toContain(`Chowdeck order ${attempt.chowdeck_order_id} may still exist and may still be payable`);
      expect(audit.disclosure).toContain("A payment page was started for this order (payment start: started) and may still work");
      expect(audit.disclosure).toContain("may duplicate an existing order");
      expect(audit.disclosure).not.toMatch(/\b(was|were|is|has been) cancell?ed\b/i);
      expect(outcome.released && outcome.disclosure).toBe(audit.disclosure);
    });

    test("needs no waiting period", async () => {
      const attempt = await seed("created", { order_request_started_at: new Date() });

      expect((await release(attempt.id)).released).toBe(true);
    });
  });

  describe("the read-only Chowdeck lookup", () => {
    test.each([
      ["the payment status is success", (id: number) => orderDetail(id, { payment: { status: "success" } }), timeline([])],
      ["the timeline shows MADE_PAYMENT", (id: number) => orderDetail(id), timeline(["ORDER_CREATED", "MADE_PAYMENT"])],
    ])("refuses the release and records the payment when %s", async (_, detail, steps) => {
      const attempt = await seed("created");
      route(`GET /customer/order/${attempt.chowdeck_order_id}`, detail(attempt.chowdeck_order_id!));
      route(`GET /customer/order/${attempt.chowdeck_order_id}/timeline`, steps);

      const outcome = await release(attempt.id);

      expect(outcome).toMatchObject({ released: false, reason: "paid" });
      const after = await row(attempt.id);
      expect(after.state).toBe("paid");
      expect(after.resolution).toBe("paid_verified");
      expect(after.lock_released_at).toBeNull();
      expect(await audits(attempt.id)).toHaveLength(0);
    });

    test.each([
      ["a 404", () => Response.json({ message: "Order PRIVATE-upstream-message" }, { status: 404 }), "http 404"],
      ["a server error", () => Response.json({ message: "PRIVATE-upstream-message" }, { status: 503 }), "http 503"],
      ["a malformed response", () => Response.json({ status: "success", data: [] }), "invalid_response"],
    ])("records %s as a failed lookup without the upstream message and keeps the outcome uncertain", async (_, reply, error) => {
      const attempt = await seed("created");
      route(`GET /customer/order/${attempt.chowdeck_order_id}`, reply);

      const outcome = await release(attempt.id, { reasonCode: "order_not_retrievable" });

      expect(outcome).toMatchObject({ released: true, lookup: { outcome: "failed", error } });
      const [audit] = await audits(attempt.id);
      expect(audit.lookup_outcome).toBe("failed");
      expect(audit.lookup_error).toBe(error);
      expect(JSON.stringify(audit)).not.toContain("PRIVATE-upstream-message");
      expect(audit.disclosure).toContain("may still exist and may still be payable");
      expect((await row(audit.submission_id)).state).toBe("created");
    });

    test("records a signed-out user as a failed lookup without contacting Chowdeck", async () => {
      const attempt = await seed("created", {}, await newUser(false));

      const outcome = await release(attempt.id, { reasonCode: "order_not_retrievable" });

      expect(outcome).toMatchObject({ released: true, lookup: { outcome: "failed", error: "not_signed_in" } });
      expect(received).toHaveLength(0);
    });

    test("refuses order_not_retrievable when Chowdeck did return the order", async () => {
      const attempt = await seed("created");

      const outcome = await release(attempt.id, { reasonCode: "order_not_retrievable" });

      expect(outcome).toMatchObject({ released: false, reason: "reason_requires_failed_lookup" });
      expect((await row(attempt.id)).lock_released_at).toBeNull();
    });

    test("is not applicable to an unknown outcome, which has no order id", async () => {
      const attempt = await seed("unknown");

      const outcome = await release(attempt.id, { reasonCode: "user_reported_no_order" });

      expect(outcome).toMatchObject({ released: true, lookup: { outcome: "not_applicable" } });
      expect(received).toHaveLength(0);
      const [audit] = await audits(attempt.id);
      expect(audit.reason_code).toBe("user_reported_no_order");
      expect(audit.disclosure).toContain("An order may or may not exist on Chowdeck for this attempt");
    });
  });

  describe("the 24-hour wait for an unknown outcome", () => {
    test.each([
      ["unknown", "1 second short of", "23 hours 59 minutes 59 seconds", false],
      ["unknown", "exactly", "24 hours", true],
      ["submitting", "1 second short of", "23 hours 59 minutes 59 seconds", false],
      ["submitting", "past", "24 hours 1 second", true],
    ])("an attempt %s %s 24 hours old is released: %p", async (state, _, age, allowed) => {
      const attempt = await seed(state);
      await sql`UPDATE order_submissions SET order_request_started_at = now() - ${age}::interval WHERE id = ${attempt.id}`;

      const outcome = await release(attempt.id, { reasonCode: "user_reported_no_order" });

      expect(outcome.released).toBe(allowed);
      if (!allowed) {
        expect(outcome).toMatchObject({ reason: "wait_not_elapsed" });
        expect((await row(attempt.id)).lock_released_at).toBeNull();
      }
    });

    test("the store enforces it with the database clock even if the caller does not", async () => {
      const attempt = await seed("unknown", { order_request_started_at: new Date() });

      const result = await recoveries.release({
        submissionId: attempt.id, expectedState: "unknown", operatorId: operator.id, reasonCode: "user_reported_no_order",
        note: "Direct store call that skips the service checks.", lookup: { outcome: "not_applicable" },
        disclosure: "x", duplicateRiskAcknowledged: true,
      });

      expect(result).toEqual({ ok: false, reason: "wait_not_elapsed" });
    });
  });

  describe("refusals", () => {
    test.each([
      ["quoted"],
      ["confirmation_pending"],
      ["failed"],
      ["paid"],
    ])("refuses a %s attempt", async (state) => {
      const attempt = await seed(state, state === "confirmation_pending" ? { confirmation_expires_at: new Date(Date.now() + 60_000), confirmation_consumed_at: null } : {});

      expect(await release(attempt.id)).toMatchObject({ released: false, reason: "not_eligible" });
      expect(received).toHaveLength(0);
    });

    test("refuses a submitting attempt whose order request never started", async () => {
      const attempt = await seed("submitting", { order_request_started_at: null });

      expect(await release(attempt.id)).toMatchObject({ released: false, reason: "not_eligible" });
    });

    test("refuses without an explicit duplicate-risk acknowledgement, before any lookup", async () => {
      const attempt = await seed("created");

      expect(await release(attempt.id, { acknowledgeDuplicateRisk: false })).toMatchObject({ released: false, reason: "acknowledgement_required" });
      expect(received).toHaveLength(0);
      expect((await row(attempt.id)).lock_released_at).toBeNull();
    });

    test.each([["", "invalid_note"], ["   short   ", "invalid_note"], ["x".repeat(2001), "invalid_note"]])(
      "refuses the note %#",
      async (note, reason) => {
        const attempt = await seed("created");
        expect(await release(attempt.id, { note })).toMatchObject({ released: false, reason });
      },
    );

    test.each([
      ["created", "user_reported_no_order", "reason_not_allowed"],
      ["unknown", "user_reported_abandoned", "reason_not_allowed"],
      ["unknown", "order_not_retrievable", "reason_not_allowed"],
      ["created", "chowdeck_cancelled", "invalid_reason"],
    ])("refuses a %s attempt released for %s", async (state, reasonCode, reason) => {
      const attempt = await seed(state);

      expect(await release(attempt.id, { reasonCode })).toMatchObject({ released: false, reason });
    });

    test("refuses an unknown id and a second release", async () => {
      const attempt = await seed("created");
      expect((await release(attempt.id)).released).toBe(true);

      expect(await release(attempt.id)).toMatchObject({ released: false, reason: "already_released" });
      expect(await release(crypto.randomUUID())).toMatchObject({ released: false, reason: "not_found" });
      expect(await release("not-a-uuid")).toMatchObject({ released: false, reason: "not_found" });
      expect(await audits(attempt.id)).toHaveLength(1);
    });

    test("refuses when the attempt changed state after the lookup", async () => {
      const attempt = await seed("unknown");

      const result = await recoveries.release({
        submissionId: attempt.id, expectedState: "created", operatorId: operator.id, reasonCode: "user_accepts_duplicate_risk",
        note: "Lookup saw a different state than the row now has.", lookup: { outcome: "not_applicable" },
        disclosure: "x", duplicateRiskAcknowledged: true,
      });

      expect(result).toEqual({ ok: false, reason: "state_changed" });
    });
  });

  describe("atomicity", () => {
    test("concurrent releases of one attempt release it once, with one audit record", async () => {
      const attempt = await seed("created");

      const outcomes = await Promise.all(Array.from({ length: 5 }, () => release(attempt.id)));

      expect(outcomes.filter((o) => o.released)).toHaveLength(1);
      expect(outcomes.filter((o) => !o.released).every((o) => !o.released && o.reason === "already_released")).toBe(true);
      expect(await audits(attempt.id)).toHaveLength(1);
    });

    test("rolls the lock release back when the audit record cannot be written", async () => {
      const attempt = await seed("created");

      await expect(
        recoveries.release({
          submissionId: attempt.id, expectedState: "created", operatorId: crypto.randomUUID(), reasonCode: "user_reported_abandoned",
          note: "Operator id that does not exist breaks the audit insert.", lookup: { outcome: "not_applicable" },
          disclosure: "x", duplicateRiskAcknowledged: true,
        }),
      ).rejects.toThrow();

      expect((await row(attempt.id)).lock_released_at).toBeNull();
      expect(await audits(attempt.id)).toHaveLength(0);
      expect((await release(attempt.id)).released).toBe(true);
    });
  });

  describe("the audit trail", () => {
    const failure = async (statement: PromiseLike<unknown>) => {
      const error = await statement.then(() => undefined, (e: unknown) => e);
      return String((error as { message?: string } | undefined)?.message);
    };

    test("rejects UPDATE, DELETE and TRUNCATE", async () => {
      const attempt = await seed("created");
      await release(attempt.id);

      expect(await failure(sql`UPDATE order_submission_recoveries SET note = 'rewritten history' WHERE submission_id = ${attempt.id}`)).toContain("append-only");
      expect(await failure(sql`DELETE FROM order_submission_recoveries WHERE submission_id = ${attempt.id}`)).toContain("append-only");
      expect(await failure(sql`TRUNCATE order_submission_recoveries`)).toContain("append-only");
      expect(await audits(attempt.id)).toHaveLength(1);
    });

    test("keeps released attempts from being deleted", async () => {
      const attempt = await seed("created");
      await release(attempt.id);

      expect(await failure(sql`DELETE FROM order_submissions WHERE id = ${attempt.id}`)).toContain("order_submission_recoveries_submission_id");
    });

    test("rejects an unacknowledged, unexplained or unrecognised record at the database", async () => {
      const attempt = await seed("created");
      const insert = (overrides: Record<string, unknown>) =>
        sql`INSERT INTO order_submission_recoveries ${sql({
          submission_id: attempt.id, user_id: attempt.user_id, operator_id: operator.id, reason_code: "user_reported_abandoned",
          note: "A note long enough.", attempt_snapshot: {}, lookup_outcome: "not_applicable", duplicate_risk_acknowledged: true,
          disclosure: "x", ...overrides,
        })}`;

      expect(await failure(insert({ duplicate_risk_acknowledged: false }))).toContain("acknowledged_check");
      expect(await failure(insert({ note: "short" }))).toContain("note_check");
      expect(await failure(insert({ reason_code: "chowdeck_cancelled" }))).toContain("reason_check");
      expect(await failure(insert({ lookup_outcome: "failed" }))).toContain("lookup_check");
      expect(await failure(insert({ reason_code: "order_not_retrievable" }))).toContain("lookup_check");
    });
  });
});
