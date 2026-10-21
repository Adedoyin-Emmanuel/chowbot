import type { Server as BunServer } from "bun";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { ChowdeckClient } from "../../lib/client";
import { createKeyring } from "../../lib/encryption";
import { runRecoveryCli } from "../../cli/recovery";
import { migrate } from "../../lib/postgres/migrations";
import { createPostgresStores } from "../../lib/postgres";
import { createTestDatabase, describePostgres } from "../helpers/postgres";
import { createDrizzle } from "../../lib/postgres/database";
import { PostgresOperatorStore } from "../../lib/postgres/recovery";
import { hashOperatorCredential } from "../../lib/recovery";

/*
 * The recovery CLI against a throwaway database, with Chowdeck mocked and
 * the database connection and client injected. Operators authenticate with
 * CHOWBOT_OPERATOR / CHOWBOT_OPERATOR_TOKEN.
 */

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

const ORDER_ID = 7001326;
const key = randomBytes(32);

let database: TestDatabase;
let sql: ReturnType<TestDatabase["connect"]>;
let stores: ReturnType<typeof createPostgresStores>;
let chowdeck: BunServer<undefined>;
let received: string[];
let alice: string;
let bob: string;

const run = async (argv: string[], operator?: { name: string; token: string }) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runRecoveryCli(
    argv,
    {
      CHOWBOT_ENCRYPTION_KEY: key.toString("base64"),
      ...(operator && { CHOWBOT_OPERATOR: operator.name, CHOWBOT_OPERATOR_TOKEN: operator.token }),
    },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    { sql, client: new ChowdeckClient({ baseUrl: chowdeck.url.origin, timeoutMs: 1000 }) },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
};

const credentialFrom = (output: string) => output.split("\n").find((line) => line.startsWith("cbop_"))!;

const seedCreated = async () => {
  const userId = await stores.users.findOrCreateByPhone(`080${Math.floor(Math.random() * 1e8)}`);
  await stores.sessions.set(userId, { token: "secret-token", phone: "x" });
  const [row] = await sql`INSERT INTO order_submissions ${sql({
    user_id: userId, vendor_id: 102555, cart_id: Math.floor(Math.random() * 1e9) + 1, fee_id: 1, address_binding: "b",
    cart_fingerprint: "f", computed_total: 554000, quote_expires_at: new Date(Date.now() + 300_000), state: "created",
    chowdeck_order_id: ORDER_ID + Math.floor(Math.random() * 1e6), confirmation_consumed_at: new Date(), order_request_started_at: new Date(),
  })} RETURNING id`;
  return row.id as string;
};

const lockReleased = async (id: string) =>
  (await sql`SELECT lock_released_at FROM order_submissions WHERE id = ${id}`)[0].lock_released_at;

const RELEASE = (id: string) => [
  "abandon", id, "--reason", "user_reported_abandoned", "--note", "User said on the phone they will not pay.", "--acknowledge-duplicate-risk",
];

describePostgres("recovery CLI (PostgreSQL)", () => {
  beforeAll(async () => {
    database = await createTestDatabase();
    sql = database.connect();
    await migrate(sql);
    stores = createPostgresStores(sql, createKeyring(key));
    chowdeck = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        received.push(`${req.method} ${url.pathname}`);
        if (url.pathname.endsWith("/timeline")) return Response.json({ data: [{ action: "ORDER_CREATED" }] });
        const id = Number(url.pathname.split("/").pop());
        return Response.json({ status: "success", data: { id, vendor_id: 102555, status: "pending" } });
      },
    });

    const first = await run(["operator", "add", "ops-alice"]);
    expect(first.code).toBe(0);
    alice = credentialFrom(first.out);
    const second = await run(["operator", "add", "ops-bob"], { name: "ops-alice", token: alice });
    expect(second.code).toBe(0);
    bob = credentialFrom(second.out);
  });

  afterAll(async () => {
    chowdeck.stop(true);
    await database.drop();
  });

  beforeEach(() => {
    received = [];
  });

  describe("operators", () => {
    test("store only an argon2id hash of the credential, shown once", async () => {
      const [row] = await sql`SELECT * FROM admin_operators WHERE name = 'ops-alice'`;

      expect(alice).toMatch(/^cbop_[A-Za-z0-9_-]{43}$/);
      expect(row.credential_hash).toStartWith("$argon2id$");
      expect(JSON.stringify(row)).not.toContain(alice);
    });

    test("only the first operator can be added without authenticating", async () => {
      const result = await run(["operator", "add", "ops-mallory"]);

      expect(result.code).toBe(1);
      expect(result.err).toBe("Operator authentication failed.");
      expect((await sql`SELECT 1 FROM admin_operators WHERE name = 'ops-mallory'`).length).toBe(0);
    });

    test("a disabled operator can no longer authenticate", async () => {
      const added = await run(["operator", "add", "ops-carol"], { name: "ops-alice", token: alice });
      const carol = credentialFrom(added.out);
      expect((await run(["operator", "disable", "ops-carol"], { name: "ops-bob", token: bob })).code).toBe(0);

      const result = await run(["show", crypto.randomUUID()], { name: "ops-carol", token: carol });

      expect(result.code).toBe(1);
      expect(result.err).toBe("Operator authentication failed.");
    });
  });

  describe("authentication", () => {
    test.each([
      ["no credentials", undefined],
      ["a wrong token", () => ({ name: "ops-alice", token: bob })],
      ["a malformed token", () => ({ name: "ops-alice", token: "not-a-token" })],
      ["an unknown operator", () => ({ name: "ops-nobody", token: alice })],
      ["an invalid operator name", () => ({ name: "Ops Alice", token: alice })],
    ])("refuses %s before reading or releasing anything", async (_, operator) => {
      const id = await seedCreated();

      const show = await run(["show", id], operator?.());
      const release = await run(RELEASE(id), operator?.());

      for (const result of [show, release]) {
        expect(result.code).toBe(1);
        expect(result.err).toBe("Operator authentication failed.");
        expect(result.out).toBe("");
      }
      expect(received).toHaveLength(0);
      expect(await lockReleased(id)).toBeNull();
    });
  });

  describe("show and abandon", () => {
    test("show is read-only and prints the reasons and the risk to acknowledge", async () => {
      const id = await seedCreated();

      const result = await run(["show", id], { name: "ops-bob", token: bob });

      expect(result.code).toBe(0);
      expect(result.out).toContain("state:              created");
      expect(result.out).toContain("abandon reasons:    order_not_retrievable, user_reported_abandoned");
      expect(result.out).toContain("may still exist and may still be payable");
      expect(received).toHaveLength(0);
      expect(await lockReleased(id)).toBeNull();
    });

    test("abandon records the authenticated operator, never a self-declared one", async () => {
      const id = await seedCreated();

      const result = await run(RELEASE(id), { name: "ops-bob", token: bob });

      expect(result.code).toBe(0);
      expect(result.out).toContain("Chowdeck lookup: unpaid");
      expect(result.out).toContain("Marked abandoned by ops-bob");
      expect(result.out).toContain("This is not a cancellation on Chowdeck.");
      const [audit] = await sql`
        SELECT o.name FROM order_submission_recoveries r JOIN admin_operators o ON o.id = r.operator_id
        WHERE r.submission_id = ${id}`;
      expect(audit.name).toBe("ops-bob");
      expect(received.every((r) => r.startsWith("GET "))).toBe(true);
    });

    test("abandon refuses without --acknowledge-duplicate-risk", async () => {
      const id = await seedCreated();

      const result = await run(RELEASE(id).slice(0, -1), { name: "ops-bob", token: bob });

      expect(result.code).toBe(1);
      expect(result.err).toContain("the duplicate-order risk must be acknowledged explicitly");
      expect(received).toHaveLength(0);
      expect(await lockReleased(id)).toBeNull();
    });

    test("rejects unknown commands and options", async () => {
      expect((await run(["delete", "x"])).code).toBe(2);
      expect((await run(["abandon", "x", "--force"])).code).toBe(2);
      expect((await run(["release", "x"])).code).toBe(2);
    });
  });
});

/*
 * First-operator bootstrap on a fresh database, with every caller on its own
 * connection pool, as separate CLI processes would be.
 */
describePostgres("first-operator bootstrap (PostgreSQL)", () => {
  let fresh: TestDatabase;

  beforeEach(async () => {
    fresh = await createTestDatabase();
    await migrate(fresh.connect());
  });

  afterEach(async () => {
    await fresh.drop();
  });

  const cli = async (argv: string[], operator?: { name: string; token: string }) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runRecoveryCli(
      argv,
      {
        CHOWBOT_ENCRYPTION_KEY: key.toString("base64"),
        ...(operator && { CHOWBOT_OPERATOR: operator.name, CHOWBOT_OPERATOR_TOKEN: operator.token }),
      },
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      { sql: fresh.connect() },
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  test("exactly one of many concurrent CLI bootstraps on independent connections succeeds", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => cli(["operator", "add", `ops-first-${i}`])));

    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    expect(results.filter((r) => r.code === 1).every((r) => r.err === "Operator authentication failed.")).toBe(true);
    const rows = await fresh.connect()`SELECT name, bootstrap FROM admin_operators`;
    expect(rows).toHaveLength(1);
    expect(rows[0].bootstrap).toBe(true);
  }, 60_000);

  test("exactly one of many concurrent store bootstraps succeeds", async () => {
    const hash = await hashOperatorCredential("cbop_test");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => new PostgresOperatorStore(createDrizzle(fresh.connect())).bootstrap(`ops-store-${i}`, hash)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await fresh.connect()`SELECT 1 FROM admin_operators`).toHaveLength(1);
  }, 60_000);

  test("after bootstrap, unauthenticated adds are refused and authenticated adds are not bootstrap operators", async () => {
    const first = await cli(["operator", "add", "ops-root"]);
    const token = first.out.split("\n").find((line) => line.startsWith("cbop_"))!;

    expect((await cli(["operator", "add", "ops-sneaky"])).err).toBe("Operator authentication failed.");
    expect((await cli(["operator", "add", "ops-sneaky"], { name: "ops-root", token: "cbop_wrong" })).err).toBe("Operator authentication failed.");
    expect((await cli(["operator", "add", "ops-second"], { name: "ops-root", token })).code).toBe(0);

    const rows = await fresh.connect()`SELECT name, bootstrap FROM admin_operators ORDER BY name`;
    expect(rows.map((r: { name: string; bootstrap: boolean }) => [r.name, r.bootstrap])).toEqual([["ops-root", true], ["ops-second", false]]);
  }, 60_000);

  test("disabling every operator does not reopen bootstrap", async () => {
    const first = await cli(["operator", "add", "ops-root"]);
    const token = first.out.split("\n").find((line) => line.startsWith("cbop_"))!;
    expect((await cli(["operator", "disable", "ops-root"], { name: "ops-root", token })).code).toBe(0);

    const again = await cli(["operator", "add", "ops-new-root"]);

    expect(again.code).toBe(1);
    expect(await fresh.connect()`SELECT 1 FROM admin_operators`).toHaveLength(1);
  }, 60_000);

  test("the database refuses a second bootstrap row even outside the store", async () => {
    const db = fresh.connect();
    await db`INSERT INTO admin_operators (name, credential_hash, bootstrap) VALUES ('ops-a', 'h', true)`;

    const error = await db`INSERT INTO admin_operators (name, credential_hash, bootstrap) VALUES ('ops-b', 'h', true)`.then(() => undefined, (e: Error) => e);

    expect(String(error?.message)).toContain("admin_operators_one_bootstrap_idx");
  });
});

