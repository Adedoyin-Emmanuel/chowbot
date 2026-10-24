import { describe, expect, test } from "bun:test";

import { InMemorySessionStore, bindSession } from "../../lib/session";

describe("InMemorySessionStore", () => {
  test("keeps sessions for different principals isolated", async () => {
    const store = new InMemorySessionStore();
    const alice = bindSession(store, "alice");
    const bob = bindSession(store, "bob");

    await alice.save({ token: "alice-token", phone: "08011111111" });

    expect(await alice.get()).toEqual({ token: "alice-token", phone: "08011111111" });
    expect(await bob.get()).toBeUndefined();

    await bob.save({ token: "bob-token" });
    await alice.clear();

    expect(await alice.get()).toBeUndefined();
    expect(await bob.get()).toEqual({ token: "bob-token" });
  });

  test("does not share session objects between callers", async () => {
    const store = new InMemorySessionStore();
    const session = { token: "original" };

    await store.set("alice", session);
    session.token = "mutated-after-save";

    const loaded = await store.get("alice");
    loaded!.token = "mutated-after-load";

    expect(await store.get("alice")).toEqual({ token: "original" });
  });
});
