import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createKeyring } from "../../../lib/encryption";
import { migrate } from "../../../lib/postgres/migrations";
import { createPostgresStores } from "../../../lib/postgres";
import { createDrizzle, deleteExpiredRecords } from "../../../lib/postgres/database";
import { PostgresOrderSubmissionStore } from "../../../lib/postgres/order-submissions";
import { createTestDatabase, describePostgres } from "../../helpers/postgres";
import type { NewQuote, OrderSubmissionStore } from "../../../lib/order-submissions";

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

let database: TestDatabase;
let sql: ReturnType<TestDatabase["connect"]>;
let instanceA: OrderSubmissionStore;
let instanceB: OrderSubmissionStore;
let userA: string;
let userB: string;

const keyring = createKeyring(randomBytes(32));
const sha = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/*
 * Values follow the checkout fixtures; they never reach Chowdeck.
 */
const QUOTE: NewQuote = {
  vendorId: 102555,
  cartId: 30742921,
  feeId: 99887766,
  addressId: 918273,
  cartFingerprint: "fingerprint-1",
  computedTotal: 554000,
};

const confirmation = (nonce: string) => ({
  paymentMethodId: 4242,
  paymentChannelName: "opay",
  nonceHash: sha(nonce),
  ttlSeconds: 300,
});

const claimCheck = (nonce: string, overrides: Partial<{ addressId: number; cartFingerprint: string }> = {}) => ({
  nonceHash: sha(nonce),
  addressId: QUOTE.addressId,
  cartFingerprint: QUOTE.cartFingerprint,
  ...overrides,
});

const confirmedQuote = async (
  store: OrderSubmissionStore,
  userId: string,
  nonce: string,
  quote: Partial<NewQuote> = {},
) => {
  const { id } = await store.createQuote(userId, { ...QUOTE, ...quote });
  expect(await store.issueConfirmation(userId, id, confirmation(nonce))).toBe(true);
  return id;
};

const claimedQuote = async (userId: string, nonce: string, quote: Partial<NewQuote> = {}) => {
  const id = await confirmedQuote(instanceA, userId, nonce, quote);
  const claim = await instanceA.claim(userId, id, claimCheck(nonce, { cartFingerprint: quote.cartFingerprint ?? QUOTE.cartFingerprint }));
  expect(claim.ok).toBe(true);
  return id;
};

/*
 * The order request's marker, committed before a request may be sent;
 * outcomes can only be recorded once it is set.
 */
const sent = async (id: string, userId = userA) => {
  expect(await instanceA.markOrderRequestStarted(userId, id)).toBe(true);
};

const PAID_EVIDENCE = { orderStatus: "in_transit", paymentStatus: "success" };

const row = async (id: string) => {
  const [found] = await sql`SELECT * FROM order_submissions WHERE id = ${id}`;
  return found;
};

describePostgres("order submissions (PostgreSQL)", () => {
  beforeAll(async () => {
    database = await createTestDatabase();
    sql = database.connect();
    await migrate(sql);
    const stores = createPostgresStores(sql, keyring);
    userA = await stores.users.findOrCreateByPhone("08000000001");
    userB = await stores.users.findOrCreateByPhone("08000000002");
    instanceA = new PostgresOrderSubmissionStore(createDrizzle(database.connect()), keyring);
    instanceB = new PostgresOrderSubmissionStore(createDrizzle(database.connect()), keyring);
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await sql`DELETE FROM order_submissions`;
  });

  describe("database constraints", () => {
    /*
     * Bun's sql tag is lazy: the query runs only when awaited. Wrapping it in
     * an async function returns a real promise, which expect(...).rejects
     * needs; a bare query object is never executed there.
     */
    const insertRaw = async (fields: Record<string, unknown>) => {
      await sql`INSERT INTO order_submissions ${sql({
        user_id: userA,
        vendor_id: 1,
        cart_id: 1,
        fee_id: 1,
        address_binding: "binding",
        cart_fingerprint: "fp",
        computed_total: 1,
        quote_expires_at: new Date(Date.now() + 300_000),
        state: "quoted",
        ...fields,
      })}`;
    };

    const consumed = { confirmation_consumed_at: new Date() };

    test.each([
      ["an unknown state", { state: "placed" }],
      ["a zero computed total", { computed_total: 0 }],
      ["a non-positive cart id", { cart_id: 0 }],
      ["a non-positive fee id", { fee_id: -1 }],
      ["confirmation_pending without a nonce", { state: "confirmation_pending", payment_method_id: 1, confirmation_expires_at: new Date() }],
      ["a confirmation outliving its quote", { confirmation_expires_at: new Date(Date.now() + 600_000) }],
      ["submitting without a consumed confirmation", { state: "submitting" }],
      ["created without an order id", { state: "created", ...consumed }],
      ["paid without an order id", { state: "paid", ...consumed }],
      ["failed without a reason", { state: "failed" }],
      ["a failure reason on a non-failed row", { failure_reason: "gate_rejected" }],
      ["an unknown failure reason", { state: "failed", failure_reason: "timeout" }],
      ["an unapproved resolution", { resolution: "user_reported_no_order" }],
      ["a released lock without a reason", { lock_released_at: new Date() }],
      ["an unapproved lock release reason", { lock_released_at: new Date(), lock_release_reason: "user_resolution" }],
    ])("reject %s", async (_, fields) => {
      await expect(insertRaw(fields)).rejects.toThrow();
    });

    test("allow only one lock-holding row per user and cart", async () => {
      const requested = { ...consumed, order_request_started_at: new Date() };
      await insertRaw({ state: "submitting", ...consumed });

      await expect(insertRaw({ state: "unknown", ...requested })).rejects.toMatchObject({ errno: "23505" });
      await insertRaw({ state: "failed", failure_reason: "order_rejected", order_request_started_at: new Date() });
      await insertRaw({ state: "paid", chowdeck_order_id: 5, ...requested, lock_released_at: new Date(), lock_release_reason: "cart_changed" });
      await insertRaw({ state: "submitting", ...consumed, cart_id: 2 });
      await insertRaw({ state: "submitting", ...consumed, user_id: userB });
    });

    test("cascade when the user is deleted", async () => {
      const [temp] = await sql`INSERT INTO users (phone_hash) VALUES ('temp-user') RETURNING id`;
      await insertRaw({ user_id: temp.id });

      await sql`DELETE FROM users WHERE id = ${temp.id}`;

      const [{ count }] = await sql`SELECT count(*)::int AS count FROM order_submissions WHERE user_id = ${temp.id}`;
      expect(count).toBe(0);
    });
  });

  describe("quotes and confirmations", () => {
    test("store a quote for five minutes without exposing internal values", async () => {
      const { id, quoteExpiresAt } = await instanceA.createQuote(userA, QUOTE);
      const stored = await row(id);
      const [{ seconds }] = await sql`SELECT extract(epoch FROM quote_expires_at - created_at)::int AS seconds FROM order_submissions WHERE id = ${id}`;

      expect(seconds).toBe(300);
      expect(quoteExpiresAt).toBeInstanceOf(Date);
      expect(stored.state).toBe("quoted");
      expect(Number(stored.fee_id)).toBe(QUOTE.feeId);
      expect(stored.address_binding).toBe(keyring.bindAddress(userA, QUOTE.addressId));
      expect(JSON.stringify(stored)).not.toContain(String(QUOTE.addressId));

      const submission = await instanceA.get(userA, id);
      expect(submission).toMatchObject({ id, state: "quoted", cartId: QUOTE.cartId, computedTotal: QUOTE.computedTotal });
      expect(Object.keys(submission!)).not.toContain("feeId");
      expect(Object.keys(submission!)).not.toContain("addressBinding");
    });

    test("keep each user's records invisible to everyone else", async () => {
      const { id } = await instanceA.createQuote(userA, QUOTE);

      expect(await instanceA.get(userB, id)).toBeUndefined();
      expect(await instanceA.issueConfirmation(userB, id, confirmation("n"))).toBe(false);
      expect(await instanceA.claim(userB, id, claimCheck("n"))).toEqual({ ok: false, reason: "not_found" });
      expect(await instanceA.get(userA, "not-a-uuid")).toBeUndefined();
      expect(await instanceA.get("not-a-uuid", id)).toBeUndefined();
    });

    test("cap a confirmation at the quote's expiry and replace it when reissued", async () => {
      const { id } = await instanceA.createQuote(userA, QUOTE);
      await instanceA.issueConfirmation(userA, id, { ...confirmation("first"), ttlSeconds: 3600 });
      const capped = await row(id);
      expect(capped.confirmation_expires_at.getTime()).toBe(capped.quote_expires_at.getTime());

      await instanceA.issueConfirmation(userA, id, confirmation("second"));

      expect(await instanceA.claim(userA, id, claimCheck("first"))).toEqual({ ok: false, reason: "confirmation_invalid" });
      expect((await instanceA.claim(userA, id, claimCheck("second"))).ok).toBe(true);
    });

    test("refuse to confirm an expired quote", async () => {
      const { id } = await instanceA.createQuote(userA, QUOTE);
      await sql`UPDATE order_submissions SET quote_expires_at = now() - interval '1 second' WHERE id = ${id}`;

      expect(await instanceA.issueConfirmation(userA, id, confirmation("n"))).toBe(false);
    });
  });

  describe("the atomic claim", () => {
    test("moves a confirmed quote to submitting and consumes the nonce", async () => {
      const id = await confirmedQuote(instanceA, userA, "n");

      const claim = await instanceA.claim(userA, id, claimCheck("n"));

      expect(claim).toMatchObject({ ok: true, feeId: QUOTE.feeId, submission: { id, state: "submitting" } });
      expect((await row(id)).confirmation_consumed_at).toBeInstanceOf(Date);
    });

    test.each([
      ["the quote was never confirmed", "not_confirmable"],
      ["the nonce is wrong", "confirmation_invalid"],
      ["the address differs", "address_changed"],
      ["the cart changed since the quote", "cart_changed"],
      ["the quote expired", "expired"],
      ["the confirmation expired", "expired"],
    ])("refuses when %s", async (situation, reason) => {
      const id =
        situation === "the quote was never confirmed"
          ? (await instanceA.createQuote(userA, QUOTE)).id
          : await confirmedQuote(instanceA, userA, "n");
      if (situation === "the quote expired") {
        await sql`UPDATE order_submissions SET quote_expires_at = now() - interval '1 second', confirmation_expires_at = now() - interval '2 seconds' WHERE id = ${id}`;
      }
      if (situation === "the confirmation expired") {
        await sql`UPDATE order_submissions SET confirmation_expires_at = now() - interval '1 second' WHERE id = ${id}`;
      }
      const check =
        situation === "the nonce is wrong"
          ? claimCheck("other")
          : situation === "the address differs"
            ? claimCheck("n", { addressId: 111 })
            : situation === "the cart changed since the quote"
              ? claimCheck("n", { cartFingerprint: "fingerprint-2" })
              : claimCheck("n");

      expect(await instanceA.claim(userA, id, check)).toMatchObject({ ok: false, reason });
      expect((await row(id)).confirmation_consumed_at).toBeNull();
    });

    test("cannot be replayed", async () => {
      const id = await confirmedQuote(instanceA, userA, "n");
      await instanceA.claim(userA, id, claimCheck("n"));

      expect(await instanceA.claim(userA, id, claimCheck("n"))).toEqual({ ok: false, reason: "not_confirmable" });
    });

    test("lets exactly one of two server instances claim the same confirmation", async () => {
      const id = await confirmedQuote(instanceA, userA, "n");

      const results = await Promise.all([
        instanceA.claim(userA, id, claimCheck("n")),
        instanceB.claim(userA, id, claimCheck("n")),
      ]);

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ reason: "not_confirmable" });
    });

    test("lets exactly one of many concurrent quotes for one cart claim it, across instances", async () => {
      const ids = await Promise.all(
        Array.from({ length: 8 }, (_, i) => confirmedQuote(instanceA, userA, `n${i}`)),
      );

      const results = await Promise.all(
        ids.map((id, i) => (i % 2 === 0 ? instanceA : instanceB).claim(userA, id, claimCheck(`n${i}`))),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "cart_locked")).toBe(true);
      const [{ count }] = await sql`SELECT count(*)::int AS count FROM order_submissions WHERE state = 'submitting'`;
      expect(count).toBe(1);
      const [{ consumed }] = await sql`SELECT count(*)::int AS consumed FROM order_submissions WHERE confirmation_consumed_at IS NOT NULL`;
      expect(consumed).toBe(1);
    });
  });

  describe("the cart lock", () => {
    const claimAnother = async (userId = userA, quote: Partial<NewQuote> = {}) => {
      const id = await confirmedQuote(instanceB, userId, "next", quote);
      return instanceB.claim(userId, id, claimCheck("next", { cartFingerprint: quote.cartFingerprint ?? QUOTE.cartFingerprint }));
    };

    test("blocks the cart while a submission is in flight", async () => {
      await claimedQuote(userA, "first");

      expect(await claimAnother()).toEqual({ ok: false, reason: "cart_locked", lockedBy: "submitting" });
    });

    test("keeps the cart locked after an unknown outcome", async () => {
      const id = await claimedQuote(userA, "first");
      await sent(id);
      expect(await instanceA.recordOutcome(userA, id, { kind: "unknown" })).toBe(true);

      expect(await claimAnother()).toEqual({ ok: false, reason: "cart_locked", lockedBy: "unknown" });
    });

    test("keeps the cart locked after an order was created and is unpaid", async () => {
      const id = await claimedQuote(userA, "first");
      await sent(id);
      await instanceA.recordOutcome(userA, id, { kind: "created", chowdeckOrderId: 1326 });

      expect(await claimAnother()).toEqual({ ok: false, reason: "cart_locked", lockedBy: "created" });
      expect(Number((await row(id)).chowdeck_order_id)).toBe(1326);
    });

    test("keeps a paid order's lock while the cart is unchanged", async () => {
      const id = await claimedQuote(userA, "first");
      await sent(id);
      await instanceA.recordOutcome(userA, id, { kind: "created", chowdeckOrderId: 1326 });
      expect(await instanceA.recordPaid(userA, id, PAID_EVIDENCE)).toBe(true);

      expect(await claimAnother()).toEqual({ ok: false, reason: "cart_locked", lockedBy: "paid" });
      expect((await row(id)).lock_released_at).toBeNull();
    });

    test("releases a paid order's lock only for a changed cart, in the same transaction", async () => {
      const id = await claimedQuote(userA, "first");
      await sent(id);
      await instanceA.recordOutcome(userA, id, { kind: "created", chowdeckOrderId: 1326 });
      await instanceA.recordPaid(userA, id, PAID_EVIDENCE);

      const claim = await claimAnother(userA, { cartFingerprint: "fingerprint-2" });

      expect(claim.ok).toBe(true);
      const paid = await row(id);
      expect(paid.state).toBe("paid");
      expect(paid.lock_release_reason).toBe("cart_changed");
      expect(paid.lock_released_at).toBeInstanceOf(Date);
    });

    test("frees the cart after a definite rejection or a failed gate", async () => {
      const rejected = await claimedQuote(userA, "first");
      await sent(rejected);
      await instanceA.recordOutcome(userA, rejected, { kind: "rejected" });
      expect((await claimAnother()).ok).toBe(true);

      await sql`DELETE FROM order_submissions`;
      const gated = await claimedQuote(userA, "first");
      expect(await instanceA.recordGateFailure(userA, gated, "gate_uncertain")).toBe(true);
      expect((await claimAnother()).ok).toBe(true);
    });

    test("does not block a fresh cart or another user", async () => {
      await claimedQuote(userA, "first");

      expect((await claimAnother(userA, { cartId: 30742999 })).ok).toBe(true);
      expect((await claimAnother(userB)).ok).toBe(true);
    });
  });

  describe("state transitions", () => {
    test("only record outcomes for a submission still in flight", async () => {
      const id = await claimedQuote(userA, "first");
      await sent(id);
      await instanceA.recordOutcome(userA, id, { kind: "unknown" });

      expect(await instanceA.recordOutcome(userA, id, { kind: "created", chowdeckOrderId: 1 })).toBe(false);
      expect(await instanceA.recordGateFailure(userA, id, "gate_rejected")).toBe(false);
      expect(await instanceA.recordPaid(userA, id, PAID_EVIDENCE)).toBe(false);
      expect((await row(id)).state).toBe("unknown");
    });

    test("never let another user record an outcome", async () => {
      const id = await claimedQuote(userA, "first");
      await sent(id);

      expect(await instanceA.recordOutcome(userB, id, { kind: "rejected" })).toBe(false);
      expect(await instanceA.recordGateFailure(userB, id, "gate_rejected")).toBe(false);
      expect((await row(id)).state).toBe("submitting");
    });
  });

  describe("the sweep", () => {
    test("removes only stale quotes and old finished records, never locked submissions", async () => {
      const staleQuote = (await instanceA.createQuote(userA, QUOTE)).id;
      const recentExpiredQuote = (await instanceA.createQuote(userA, QUOTE)).id;
      const oldFailed = await claimedQuote(userA, "f1", { cartId: 11 });
      await sent(oldFailed);
      await instanceA.recordOutcome(userA, oldFailed, { kind: "rejected" });
      const recentFailed = await claimedQuote(userA, "f2", { cartId: 12 });
      await sent(recentFailed);
      await instanceA.recordOutcome(userA, recentFailed, { kind: "rejected" });
      const submitting = await claimedQuote(userA, "s", { cartId: 21 });
      const unknown = await claimedQuote(userA, "u", { cartId: 22 });
      await sent(unknown);
      await instanceA.recordOutcome(userA, unknown, { kind: "unknown" });
      const created = await claimedQuote(userA, "c", { cartId: 23 });
      await sent(created);
      await instanceA.recordOutcome(userA, created, { kind: "created", chowdeckOrderId: 9 });
      const paid = await claimedQuote(userA, "p", { cartId: 24 });
      await sent(paid);
      await instanceA.recordOutcome(userA, paid, { kind: "created", chowdeckOrderId: 10 });
      await instanceA.recordPaid(userA, paid, PAID_EVIDENCE);

      await sql`UPDATE order_submissions SET quote_expires_at = now() - interval '2 days', confirmation_expires_at = NULL WHERE id = ${staleQuote}`;
      await sql`UPDATE order_submissions SET quote_expires_at = now() - interval '1 hour' WHERE id = ${recentExpiredQuote}`;
      await sql`
        UPDATE order_submissions
           SET updated_at = now() - interval '31 days', created_at = now() - interval '31 days',
               quote_expires_at = now() - interval '31 days', confirmation_expires_at = now() - interval '31 days'
         WHERE id IN (${oldFailed}, ${submitting}, ${unknown}, ${created}, ${paid})
      `;

      await deleteExpiredRecords(sql);

      const remaining = (await sql`SELECT id FROM order_submissions`).map((r: { id: string }) => r.id);
      expect(remaining).not.toContain(staleQuote);
      expect(remaining).not.toContain(oldFailed);
      expect(remaining).toEqual(
        expect.arrayContaining([recentExpiredQuote, recentFailed, submitting, unknown, created, paid]),
      );
    });
  });

  describe("database failures", () => {
    test("surface as errors rather than silent success", async () => {
      const offline = database.connect();
      const store = new PostgresOrderSubmissionStore(createDrizzle(offline), keyring);
      const id = await confirmedQuote(instanceA, userA, "n");
      await offline.close();

      await expect(store.createQuote(userA, QUOTE)).rejects.toThrow();
      await expect(store.claim(userA, id, claimCheck("n"))).rejects.toThrow();
      expect((await row(id)).state).toBe("confirmation_pending");
    });
  });

  describe("the order-request marker and R1 recovery", () => {
    const backdateClaim = (id: string, minutes = 3) =>
      sql`UPDATE order_submissions SET confirmation_consumed_at = now() - make_interval(mins => ${minutes}) WHERE id = ${id}`;

    test("can be set once, only while submitting, only by the owner", async () => {
      const id = await claimedQuote(userA, "first");

      expect(await instanceA.markOrderRequestStarted(userB, id)).toBe(false);
      expect(await instanceA.markOrderRequestStarted(userA, id)).toBe(true);
      expect(await instanceB.markOrderRequestStarted(userA, id)).toBe(false);
      expect((await row(id)).order_request_started_at).toBeInstanceOf(Date);

      const quoted = (await instanceA.createQuote(userA, { ...QUOTE, cartId: 77 })).id;
      expect(await instanceA.markOrderRequestStarted(userA, quoted)).toBe(false);
    });

    test("recovery releases an unsent claim only after the grace period", async () => {
      const id = await claimedQuote(userA, "first");

      expect(await instanceA.recoverUnsent(userA, QUOTE.cartId)).toBe(0);
      await backdateClaim(id);
      expect(await instanceA.recoverUnsent(userA, QUOTE.cartId)).toBe(1);

      const released = await row(id);
      expect(released.state).toBe("failed");
      expect(released.failure_reason).toBe("not_sent");
      expect(released.order_request_started_at).toBeNull();
      expect((await instanceB.claim(userA, await confirmedQuote(instanceB, userA, "next"), claimCheck("next"))).ok).toBe(true);
    });

    test("recovery never touches a marked request, another user or another cart", async () => {
      const marked = await claimedQuote(userA, "m", { cartId: 501 });
      await sent(marked);
      const otherCart = await claimedQuote(userA, "c", { cartId: 502 });
      const otherUser = await claimedQuote(userB, "u", { cartId: 501 });
      for (const id of [marked, otherCart, otherUser]) await backdateClaim(id, 60);

      expect(await instanceA.recoverUnsent(userA, 501)).toBe(0);
      expect((await row(marked)).state).toBe("submitting");
      expect((await row(otherCart)).state).toBe("submitting");
      expect((await row(otherUser)).state).toBe("submitting");
    });

    test("a late sender cannot mark a request that recovery already released", async () => {
      const id = await claimedQuote(userA, "first");
      await backdateClaim(id);
      await instanceB.recoverUnsent(userA, QUOTE.cartId);

      expect(await instanceA.markOrderRequestStarted(userA, id)).toBe(false);
    });

    test("the gate-failure path can never release a request that was started", async () => {
      const id = await claimedQuote(userA, "first");
      await sent(id);

      expect(await instanceA.recordGateFailure(userA, id, "gate_uncertain")).toBe(false);
      expect((await row(id)).state).toBe("submitting");
    });

    test("outcomes can only be recorded once the request was started", async () => {
      const id = await claimedQuote(userA, "first");

      expect(await instanceA.recordOutcome(userA, id, { kind: "unknown" })).toBe(false);
      expect((await row(id)).state).toBe("submitting");
    });

    test("racing the marker against recovery across two instances always leaves exactly one winner", async () => {
      const tally = { marked: 0, recovered: 0, both: 0, neither: 0, unsafe: 0 };
      for (let i = 0; i < 120; i++) {
        const cartId = 900000 + i;
        const id = await claimedQuote(userA, `race-${i}`, { cartId });
        await backdateClaim(id);
        const [marked, recovered] = await Promise.all(
          i % 2 === 0
            ? [instanceA.markOrderRequestStarted(userA, id), instanceB.recoverUnsent(userA, cartId).then((n) => n === 1)]
            : [instanceB.markOrderRequestStarted(userA, id), instanceA.recoverUnsent(userA, cartId).then((n) => n === 1)],
        );
        if (marked && recovered) tally.both++;
        else if (marked) tally.marked++;
        else if (recovered) tally.recovered++;
        else tally.neither++;
        const after = await row(id);
        const safe = marked
          ? after.state === "submitting" && after.order_request_started_at !== null
          : after.state === "failed" && after.order_request_started_at === null;
        if (!safe) tally.unsafe++;
      }

      expect(tally.both).toBe(0);
      expect(tally.neither).toBe(0);
      expect(tally.unsafe).toBe(0);
      expect(tally.marked + tally.recovered).toBe(120);
    });
  });

  describe("R3 linking and R4 payment evidence", () => {
    const EVIDENCE = { orderStatus: "pending", paymentStatus: "pending" };

    test("links a verified order to an unknown attempt and keeps the lock", async () => {
      const id = await claimedQuote(userA, "first");
      await sent(id);
      await instanceA.recordOutcome(userA, id, { kind: "unknown" });

      expect(await instanceA.linkOrder(userA, id, 1326, EVIDENCE)).toBe("linked");

      const linked = await row(id);
      expect(linked.state).toBe("created");
      expect(Number(linked.chowdeck_order_id)).toBe(1326);
      expect(linked.resolution).toBe("linked_user_supplied_order");
      expect(linked.evidence_payment_status).toBe("pending");
      expect(linked.lock_released_at).toBeNull();
    });

    test("links a started attempt whose outcome was never recorded", async () => {
      const id = await claimedQuote(userA, "first");
      await sent(id);

      expect(await instanceA.linkOrder(userA, id, 1327, EVIDENCE)).toBe("linked");
    });

    test.each([
      ["a claim whose request never started", async () => claimedQuote(userA, "n")],
      ["a quote", async () => (await instanceA.createQuote(userA, QUOTE)).id],
    ])("refuses to link %s", async (_, make) => {
      const id = await make();

      expect(await instanceA.linkOrder(userA, id, 1328, EVIDENCE)).toBe("not_linkable");
    });

    test("refuses another user's attempt and an order already linked elsewhere", async () => {
      const first = await claimedQuote(userA, "f", { cartId: 601 });
      await sent(first);
      const second = await claimedQuote(userA, "s", { cartId: 602 });
      await sent(second);

      expect(await instanceA.linkOrder(userB, first, 1400, EVIDENCE)).toBe("not_linkable");
      expect(await instanceA.linkOrder(userA, first, 1400, EVIDENCE)).toBe("linked");
      expect(await instanceA.linkOrder(userA, second, 1400, EVIDENCE)).toBe("order_already_linked");
      expect((await row(second)).state).toBe("submitting");
    });

    test("records payment evidence without releasing the lock", async () => {
      const id = await claimedQuote(userA, "first");
      await sent(id);
      await instanceA.recordOutcome(userA, id, { kind: "created", chowdeckOrderId: 1500 });

      expect(await instanceA.recordPaid(userA, id, { orderStatus: "in_transit", paymentStatus: "success" })).toBe(true);

      const paid = await row(id);
      expect(paid.state).toBe("paid");
      expect(paid.evidence_payment_status).toBe("success");
      expect(paid.evidence_checked_at).toBeInstanceOf(Date);
      expect(paid.lock_released_at).toBeNull();
    });

    test("lists only this user's lock-holding attempts at a restaurant, newest first", async () => {
      const older = await claimedQuote(userA, "o", { cartId: 701 });
      const newer = await claimedQuote(userA, "n", { cartId: 702 });
      const elsewhere = await claimedQuote(userA, "e", { cartId: 703, vendorId: 555 });
      await claimedQuote(userB, "b", { cartId: 704 });
      const rejected = await claimedQuote(userA, "r", { cartId: 705 });
      await sent(rejected);
      await instanceA.recordOutcome(userA, rejected, { kind: "rejected" });
      await instanceA.createQuote(userA, { ...QUOTE, cartId: 706 });
      await sql`UPDATE order_submissions SET created_at = now() - interval '1 minute' WHERE id = ${older}`;

      const open = await instanceA.listOpen(userA, QUOTE.vendorId);

      expect(open.map((s) => s.id)).toEqual([newer, older]);
      expect(open.map((s) => s.id)).not.toContain(elsewhere);
      expect(open[0]).toMatchObject({ state: "submitting", claimedAt: expect.any(Date), orderRequestStartedAt: null });
    });
  });

  describe("migration 0003 constraints", () => {
    const insertRaw = async (fields: Record<string, unknown>) => {
      await sql`INSERT INTO order_submissions ${sql({
        user_id: userA, vendor_id: 1, cart_id: 1, fee_id: 1, address_binding: "b", cart_fingerprint: "f",
        computed_total: 1, quote_expires_at: new Date(Date.now() + 300_000), state: "quoted", ...fields,
      })}`;
    };
    const consumed = { confirmation_consumed_at: new Date() };
    const marker = { order_request_started_at: new Date() };

    test.each([
      ["a quote carrying the marker", { ...marker }],
      ["an unknown outcome without the marker", { state: "unknown", ...consumed }],
      ["a created order without the marker", { state: "created", chowdeck_order_id: 1, ...consumed }],
      ["a gate failure carrying the marker", { state: "failed", failure_reason: "gate_uncertain", ...marker }],
      ["a never-sent failure carrying the marker", { state: "failed", failure_reason: "not_sent", ...marker }],
      ["an order rejection without the marker", { state: "failed", failure_reason: "order_rejected" }],
    ])("reject %s", async (_, fields) => {
      await expect(insertRaw(fields)).rejects.toThrow();
    });

    test("allow each Chowdeck order on only one attempt", async () => {
      await insertRaw({ state: "created", chowdeck_order_id: 42, ...consumed, ...marker, cart_id: 1 });

      await expect(insertRaw({ state: "created", chowdeck_order_id: 42, ...consumed, ...marker, cart_id: 2 })).rejects.toMatchObject({ errno: "23505" });
    });
  });

  describe("migration 0007: promo codes, superseded quotes and cancellation", () => {
    const createdOrder = async (orderId: number, quote: Partial<NewQuote> = {}) => {
      const id = await claimedQuote(userA, `n-${orderId}`, quote);
      await sent(id);
      expect(await instanceA.recordOutcome(userA, id, { kind: "created", chowdeckOrderId: orderId })).toBe(true);
      return id;
    };
    const CANCELLED = { orderStatus: "cancelled", paymentStatus: null };

    test("stores a quote's promo code and Chowdeck's discount, and none without one", async () => {
      const { id } = await instanceA.createQuote(userA, { ...QUOTE, promo: { code: "5FOR5", discount: 65000 } });
      const { id: plain } = await instanceA.createQuote(userA, { ...QUOTE, cartId: 2 });

      expect(await instanceB.get(userA, id)).toMatchObject({ promoCode: "5FOR5", promoDiscount: 65000 });
      expect(await instanceB.get(userA, plain)).toMatchObject({ promoCode: null, promoDiscount: null });
    });

    test("a new quote supersedes the cart's older unclaimed quotes only", async () => {
      const older = (await instanceA.createQuote(userA, QUOTE)).id;
      const pending = await confirmedQuote(instanceA, userA, "pending");
      const otherCart = (await instanceA.createQuote(userA, { ...QUOTE, cartId: 999 })).id;
      const otherUser = (await instanceA.createQuote(userB, QUOTE)).id;
      const newest = (await instanceA.createQuote(userA, QUOTE)).id;

      expect(await instanceB.supersedeQuotes(userA, QUOTE.cartId, newest)).toBe(2);

      for (const id of [older, pending]) expect(await row(id)).toMatchObject({ state: "failed", failure_reason: "superseded" });
      expect((await row(newest)).state).toBe("quoted");
      expect((await row(otherCart)).state).toBe("quoted");
      expect((await row(otherUser)).state).toBe("quoted");
      expect(await instanceA.issueConfirmation(userA, older, confirmation("again"))).toBe(false);
    });

    test("never supersedes a claimed attempt or an order", async () => {
      const claimed = await claimedQuote(userA, "claimed");
      const newest = (await instanceA.createQuote(userA, QUOTE)).id;

      expect(await instanceA.supersedeQuotes(userA, QUOTE.cartId, newest)).toBe(0);
      expect((await row(claimed)).state).toBe("submitting");
    });

    test("the cancellation marker is set once, only on a created order, and blocks any payment start", async () => {
      const id = await createdOrder(5001);

      expect(await instanceA.markCancelRequested(userA, id, 9999)).toBe(false);
      expect(await instanceB.markCancelRequested(userB, id, 5001)).toBe(false);
      const both = await Promise.all([instanceA.markCancelRequested(userA, id, 5001), instanceB.markCancelRequested(userA, id, 5001)]);
      expect(both.filter(Boolean)).toHaveLength(1);
      expect(await instanceA.markPaymentStarted(userA, id, 5001)).toBe(false);

      expect(await instanceA.recordCancelRequest(userA, id, "accepted")).toBe(true);
      expect(await instanceA.recordCancelRequest(userA, id, "unknown")).toBe(false);
      expect(await row(id)).toMatchObject({ state: "created", cancel_request_state: "accepted" });
      expect((await row(id)).cancel_requested_at).toBeInstanceOf(Date);
    });

    test("refuses a cancellation marker without an order, and allows one after a payment start", async () => {
      const unsent = await claimedQuote(userA, "unsent");
      expect(await instanceA.markCancelRequested(userA, unsent, 1)).toBe(false);

      const paying = await createdOrder(5002, { cartId: 2 });
      expect(await instanceA.markPaymentStarted(userA, paying, 5002)).toBe(true);
      expect(await instanceA.markCancelRequested(userA, paying, 5002)).toBe(true);
    });

    test("a cancellation Chowdeck shows frees the cart lock and records the evidence", async () => {
      const id = await createdOrder(5003);
      const blocked = await confirmedQuote(instanceA, userA, "next");
      expect(await instanceA.claim(userA, blocked, claimCheck("next"))).toMatchObject({ ok: false, reason: "cart_locked" });

      expect(await instanceB.recordCancelled(userA, id, CANCELLED)).toBe(true);
      expect(await row(id)).toMatchObject({ state: "cancelled", resolution: "cancelled_verified", evidence_order_status: "cancelled" });
      expect(await instanceA.listOpen(userA, QUOTE.vendorId)).toHaveLength(0);

      const next = await confirmedQuote(instanceA, userA, "after");
      expect((await instanceA.claim(userA, next, claimCheck("after"))).ok).toBe(true);
    });

    test("never records a cancellation on a paid, abandoned or unsent attempt", async () => {
      const paid = await createdOrder(5004);
      await instanceA.recordPaid(userA, paid, PAID_EVIDENCE);
      expect(await instanceA.recordCancelled(userA, paid, CANCELLED)).toBe(false);

      const released = await createdOrder(5005, { cartId: 3 });
      await sql`UPDATE order_submissions SET lock_released_at = now(), lock_release_reason = 'operator_released' WHERE id = ${released}`;
      expect(await instanceA.recordCancelled(userA, released, CANCELLED)).toBe(false);

      const unsent = await claimedQuote(userA, "unsent", { cartId: 4 });
      expect(await instanceA.recordCancelled(userA, unsent, CANCELLED)).toBe(false);
    });

    describe("constraints", () => {
      const insertRaw = async (fields: Record<string, unknown>) => {
        await sql`INSERT INTO order_submissions ${sql({
          user_id: userA, vendor_id: 1, cart_id: 1, fee_id: 1, address_binding: "b", cart_fingerprint: "f",
          computed_total: 1, quote_expires_at: new Date(Date.now() + 300_000), state: "quoted", ...fields,
        })}`;
      };
      const ordered = { confirmation_consumed_at: new Date(), order_request_started_at: new Date() };

      test.each([
        ["a promo code without its discount", { promo_code: "5FOR5" }],
        ["a discount without its promo code", { promo_discount: 100 }],
        ["a zero discount", { promo_code: "5FOR5", promo_discount: 0 }],
        ["a cancellation marker without an order", { cancel_requested_at: new Date() }],
        ["a cancellation outcome without its marker", { state: "created", chowdeck_order_id: 7, ...ordered, cancel_request_state: "accepted" }],
        ["an unknown cancellation outcome value", { state: "created", chowdeck_order_id: 7, ...ordered, cancel_requested_at: new Date(), cancel_request_state: "maybe" }],
        ["a cancelled attempt without an order", { state: "cancelled", ...ordered }],
        ["a cancelled attempt without the order-request marker", { state: "cancelled", chowdeck_order_id: 7, confirmation_consumed_at: new Date() }],
        ["a superseded quote carrying the marker", { state: "failed", failure_reason: "superseded", order_request_started_at: new Date() }],
      ])("reject %s", async (_, fields) => {
        await expect(insertRaw(fields)).rejects.toThrow();
      });

      test("accept a cancelled order and a superseded quote", async () => {
        await insertRaw({ state: "cancelled", chowdeck_order_id: 8, ...ordered, resolution: "cancelled_verified", cancel_requested_at: new Date(), cancel_request_state: "accepted" });
        await insertRaw({ state: "failed", failure_reason: "superseded", cart_id: 2 });
      });
    });
  });
});
