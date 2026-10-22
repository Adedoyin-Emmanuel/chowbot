import type { Server } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";

import { callTool } from "../../helpers/mcp";
import { ChowdeckClient } from "../../../lib/client";
import { registerCartTools } from "../../../features/carts/tools";
import { MAX_NOTE_LENGTH, validateNote } from "../../../features/carts/notes";
import { bindSession, InMemorySessionStore, type UserSession } from "../../../lib/session";

/*
 * Restaurant and delivery notes, saved on the cart the way the storefront
 * does: POST /customer/cart/vendor/{id} with one note field. Chowdeck is
 * mocked; notes are fictional.
 */

const RESTAURANT = 102555;
type Received = { method: string; path: string; authorization: string | null; body: unknown };
type Route = () => Response | Promise<Response>;

let upstream: Server<undefined>;
let received: Received[];
let routes: Record<string, Route[]>;

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      received.push({ method: req.method, path: url.pathname, authorization: req.headers.get("authorization"), body: text ? JSON.parse(text) : undefined });
      const queue = routes[`${req.method} ${url.pathname}`];
      const route = queue && (queue.length > 1 ? queue.shift() : queue[0]);
      return route ? route() : Response.json({ message: "unexpected request" }, { status: 500 });
    },
  });
});

afterAll(() => upstream.stop(true));

beforeEach(() => {
  received = [];
  routes = {};
});

const cart = (notes: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    data: {
      id: 30742921,
      vendor_id: RESTAURANT,
      status: "active",
      currency: "NGN",
      total_price: 440000,
      is_valid: true,
      validation_result: [],
      customer_vendor_note: null,
      customer_delivery_note: null,
      cart_items: [{ id: 1, item_id: 880557, name: "Fried Rice", type: "menu", quantity: 1, price_per_quantity: 180000, pack_reference: "pack-1" }],
      ...notes,
    },
  });

const ok = () => Response.json({ status: "success", message: "Cart updated" });

const signedIn = async (token = "secret-token-alice") => {
  const session = bindSession(new InMemorySessionStore(), crypto.randomUUID());
  await session.save({ token, phone: "08000000000" });
  return session;
};

const serverFor = (session?: UserSession) => () => {
  const server = new McpServer({ name: "ChowBot", version: "test" });
  registerCartTools(server, session, new ChowdeckClient({ baseUrl: upstream.url.origin, timeoutMs: 200 }));
  return server;
};

const textOf = (result: { content: { text: string }[] }) => result.content[0]!.text;
const writes = () => received.filter((r) => r.method === "POST");

const setNotes = async (args: Record<string, unknown>, session?: UserSession) =>
  callTool(serverFor(session ?? (await signedIn())), "set_cart_notes", { restaurant_id: RESTAURANT, ...args });

describe("validateNote", () => {
  test.each([
    [null, ""],
    ["", ""],
    ["   \n\t ", ""],
    ["  Extra pepper, please  ", "Extra pepper, please"],
    ["Gate code 1234\nCall on arrival", "Gate code 1234\nCall on arrival"],
    ["Ẹ jọ̀ọ́, no onions 🌶️", "Ẹ jọ̀ọ́, no onions 🌶️"],
  ])("accepts %p as %p", (input, value) => {
    expect(validateNote(input)).toEqual({ ok: true, value });
  });

  test("counts Unicode characters, not bytes or UTF-16 units, against the limit", () => {
    expect(validateNote("🌶".repeat(MAX_NOTE_LENGTH))).toEqual({ ok: true, value: "🌶".repeat(MAX_NOTE_LENGTH) });
    expect(validateNote("a".repeat(MAX_NOTE_LENGTH + 1))).toMatchObject({ ok: false });
    expect(validateNote(` ${"a".repeat(MAX_NOTE_LENGTH)} `)).toEqual({ ok: true, value: "a".repeat(MAX_NOTE_LENGTH) });
  });

  test.each([["bell \u0007"], ["nul \u0000"], ["escape \u001b[31m"]])("refuses control characters in %p", (input) => {
    expect(validateNote(input)).toEqual({ ok: false, error: "contains control characters" });
  });
});

describe("get_cart_notes", () => {
  test("shows both notes from the user's own cart, keeping them separate", async () => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart({ customer_vendor_note: "No onions", customer_delivery_note: "Blue gate" })];

    const result = await callTool(serverFor(await signedIn()), "get_cart_notes", { restaurant_id: RESTAURANT });

    expect(JSON.parse(textOf(result))).toEqual({ restaurant_id: RESTAURANT, cart_id: 30742921, vendor_note: "No onions", delivery_note: "Blue gate" });
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([`GET /customer/cart/vendor/${RESTAURANT}`]);
    expect(received[0]!.authorization).toBe("Bearer secret-token-alice");
  });

  test("reports null notes as empty, and a missing cart as an error", async () => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart(), () => Response.json({ status: "success", data: {} })];
    const session = await signedIn();

    expect(JSON.parse(textOf(await callTool(serverFor(session), "get_cart_notes", { restaurant_id: RESTAURANT })))).toMatchObject({ vendor_note: "", delivery_note: "" });
    expect(textOf(await callTool(serverFor(session), "get_cart_notes", { restaurant_id: RESTAURANT }))).toBe(
      "Failed to get checkout notes: there is no cart for this restaurant; add an item first",
    );
  });
});

describe("set_cart_notes", () => {
  test("saves each note with its own one-field request, then confirms both from the cart", async () => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart(), cart({ customer_vendor_note: "No onions", customer_delivery_note: "Call on arrival 📞" })];
    routes[`POST /customer/cart/vendor/${RESTAURANT}`] = [ok];

    const result = await setNotes({ vendor_note: "  No onions ", delivery_note: "Call on arrival 📞" });

    expect(result.isError).toBeUndefined();
    expect(writes().map((w) => w.body)).toEqual([{ customer_vendor_note: "No onions" }, { customer_delivery_note: "Call on arrival 📞" }]);
    for (const request of received) expect(request.authorization).toBe("Bearer secret-token-alice");
    expect(JSON.parse(textOf(result))).toEqual({
      restaurant_id: RESTAURANT,
      updated: {
        vendor: { sent: "No onions", stored: "No onions", verification: "verified" },
        delivery: { sent: "Call on arrival 📞", stored: "Call on arrival 📞", verification: "verified" },
      },
      confirmed_by_chowdeck: true,
      message: "Chowdeck's cart, read again after the change, holds exactly these notes; an order placed from this cart carries them.",
      notes: { restaurant_id: RESTAURANT, cart_id: 30742921, vendor_note: "No onions", delivery_note: "Call on arrival 📞" },
    });
  });

  /*
   * A successful write alone is never reported as saved; the re-read decides.
   */
  test("never reports a note saved when the re-read cart holds something else, or cannot be read", async () => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart(), cart({ customer_vendor_note: "I want extra pepper (edited)" })];
    routes[`POST /customer/cart/vendor/${RESTAURANT}`] = [() => Response.json({ status: "success", message: "Cart updated successfully" })];
    const mismatch = JSON.parse(textOf(await setNotes({ vendor_note: "I want extra pepper" })));
    expect(mismatch.confirmed_by_chowdeck).toBe(false);
    expect(mismatch.updated.vendor.verification).toBe("mismatch");
    expect(mismatch.message).toContain("do not tell the user it was saved as written");

    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart(), () => Response.json({ message: "Server Error" }, { status: 500 })];
    const unread = JSON.parse(textOf(await setNotes({ vendor_note: "I want extra pepper" })));
    expect(unread.confirmed_by_chowdeck).toBe(false);
    expect(unread.updated.vendor.verification).toBe("unverified");
    expect(unread.message).toContain("do not tell the user they were saved");
  });

  test("refuses to change the notes on a cart Chowdeck links to an order, before writing", async () => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart({ order_id: 43605309 })];
    routes[`POST /customer/cart/vendor/${RESTAURANT}`] = [ok];

    const result = await setNotes({ vendor_note: "I want extra pepper" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Chowdeck links this cart to order 43605309; ChowBot does not change it");
    expect(writes()).toHaveLength(0);
  });

  test("changes only the note given, leaving the other untouched", async () => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart({ customer_vendor_note: "Old" }), cart({ customer_vendor_note: "Old", customer_delivery_note: "Blue gate" })];
    routes[`POST /customer/cart/vendor/${RESTAURANT}`] = [ok];

    const result = JSON.parse(textOf(await setNotes({ delivery_note: "Blue gate" })));

    expect(writes().map((w) => w.body)).toEqual([{ customer_delivery_note: "Blue gate" }]);
    expect(result.updated).toEqual({ delivery: { sent: "Blue gate", stored: "Blue gate", verification: "verified" } });
    expect(result.notes.vendor_note).toBe("Old");
  });

  test.each([[null], [""], ["   "]])("clears a note given %p by sending an empty string", async (value) => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart({ customer_vendor_note: "Old" }), cart({ customer_vendor_note: "" })];
    routes[`POST /customer/cart/vendor/${RESTAURANT}`] = [ok];

    const result = JSON.parse(textOf(await setNotes({ vendor_note: value })));

    expect(writes().map((w) => w.body)).toEqual([{ customer_vendor_note: "" }]);
    expect(result.updated.vendor).toEqual({ sent: "", stored: "", verification: "verified" });
  });

  test("accepts a note at exactly the limit and refuses one over it, before contacting Chowdeck", async () => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart(), cart({ customer_vendor_note: "a".repeat(MAX_NOTE_LENGTH) })];
    routes[`POST /customer/cart/vendor/${RESTAURANT}`] = [ok];
    expect(JSON.parse(textOf(await setNotes({ vendor_note: "a".repeat(MAX_NOTE_LENGTH) }))).updated.vendor.verification).toBe("verified");

    received = [];
    const tooLong = await setNotes({ vendor_note: "a".repeat(MAX_NOTE_LENGTH + 1) });
    expect(textOf(tooLong)).toBe(`Failed to set checkout notes: the vendor note is longer than ${MAX_NOTE_LENGTH} characters (ChowBot's limit; Chowdeck's own limit is unknown)`);
    expect(received).toHaveLength(0);
  });

  test.each([
    ["a number", { vendor_note: 42 }],
    ["an object", { delivery_note: { text: "hi" } }],
    ["an oversized raw value", { vendor_note: "a".repeat(4001) }],
  ])("refuses %s before contacting Chowdeck", async (_, args) => {
    const result = await setNotes(args);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Input validation error");
    expect(received).toHaveLength(0);
  });

  test("refuses control characters and an empty request without contacting Chowdeck", async () => {
    expect(textOf(await setNotes({ delivery_note: "ring \u0007" }))).toBe("Failed to set checkout notes: the delivery note contains control characters");
    expect(textOf(await setNotes({}))).toBe("Failed to set checkout notes: give vendor_note and/or delivery_note (null or an empty string clears one)");
    expect(received).toHaveLength(0);
  });

  test("writes nothing when the restaurant has no cart", async () => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [() => Response.json({ status: "success", data: {} })];

    const result = await setNotes({ vendor_note: "No onions" });

    expect(textOf(result)).toBe("Failed to set checkout notes: there is no cart for this restaurant; add an item first");
    expect(writes()).toHaveLength(0);
  });

  test("reports a mismatch when Chowdeck stores something else", async () => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart(), cart({ customer_vendor_note: "No onio" })];
    routes[`POST /customer/cart/vendor/${RESTAURANT}`] = [ok];

    expect(JSON.parse(textOf(await setNotes({ vendor_note: "No onions" }))).updated.vendor).toEqual({ sent: "No onions", stored: "No onio", verification: "mismatch" });
  });

  test("does not claim verification when the cart cannot be re-read", async () => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart(), () => Response.json({ message: "Server Error" }, { status: 500 })];
    routes[`POST /customer/cart/vendor/${RESTAURANT}`] = [ok];

    const result = JSON.parse(textOf(await setNotes({ vendor_note: "No onions" })));

    expect(result.updated.vendor).toEqual({ sent: "No onions", verification: "unverified" });
    expect(result.verification_error).toContain("could not be re-read");
    expect(result.notes).toBeUndefined();
  });

  test.each([
    ["a server error", () => Response.json({ message: "Server Error" }, { status: 503 })],
    ["a timeout", async () => { await Bun.sleep(400); return ok(); }],
    ["a non-success envelope", () => Response.json({ status: "pending" })],
  ])("stops after %s, never retries, and sends no further note", async (_, reply) => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart()];
    routes[`POST /customer/cart/vendor/${RESTAURANT}`] = [reply];

    const result = await setNotes({ vendor_note: "No onions", delivery_note: "Blue gate" });
    await Bun.sleep(450);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("the vendor note may or may not have been saved");
    expect(writes()).toHaveLength(1);
  });

  test("reports a definite rejection as not saved", async () => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart()];
    routes[`POST /customer/cart/vendor/${RESTAURANT}`] = [() => Response.json({ status: "failed", message: "Note too long" }, { status: 422 })];

    const result = await setNotes({ delivery_note: "Blue gate" });

    expect(textOf(result)).toBe(`Failed to set checkout notes: POST /customer/cart/vendor/${RESTAURANT} failed with status 422: Note too long; the delivery note was not saved`);
    expect(writes()).toHaveLength(1);
  });

  test("uses each user's own session, and refuses without one", async () => {
    routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart()];
    routes[`POST /customer/cart/vendor/${RESTAURANT}`] = [ok];
    await setNotes({ vendor_note: "Bob's note" }, await signedIn("secret-token-bob"));
    expect(new Set(received.map((r) => r.authorization))).toEqual(new Set(["Bearer secret-token-bob"]));

    received = [];
    expect(textOf(await callTool(serverFor(undefined), "set_cart_notes", { restaurant_id: RESTAURANT, vendor_note: "x" }))).toContain("cannot identify individual users");
    expect(received).toHaveLength(0);
  });

  test("never logs note text", async () => {
    const logged: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    try {
      routes[`GET /customer/cart/vendor/${RESTAURANT}`] = [cart()];
      routes[`POST /customer/cart/vendor/${RESTAURANT}`] = [() => Response.json({ message: "Server Error" }, { status: 503 })];
      await setNotes({ vendor_note: "SECRET-NOTE-TEXT" });
    } finally {
      spy.mockRestore();
    }
    expect(logged.join("\n")).not.toContain("SECRET-NOTE-TEXT");
  });
});
