import { describe, expect, test } from "bun:test";

import {
  totalOff,
  effectivePrice,
  discountOrderLines,
  discountRequestBody,
  discountsForCode,
  parseAppliedDiscounts,
} from "../../../features/checkout/discounts";

/*
 * The website's discount/apply request, built from cart rows. Rows are fictional.
 */

const row = (fields: Record<string, unknown>) => ({ id: Math.floor(Math.random() * 1e6), name: "Item", quantity: 1, price_per_quantity: 1000, ...fields });

describe("effectivePrice (the website's H)", () => {
  test.each([
    [1000, 800, 800],
    [1000, 0, 0],
    [1000, 1000, 1000],
    [1000, 1200, 1000],
    [1000, -1, 1000],
    [1000, null, 1000],
    [undefined, 500, 0],
  ])("price %p with discount %p is %p", (price, discount, expected) => {
    expect(effectivePrice(price, discount)).toBe(expected);
  });
});

describe("discountOrderLines", () => {
  test("numbers packs by first appearance and attaches every option row of a pack to each menu row", () => {
    const rows = [
      row({ item_id: 20, type: "menu", pack_reference: "pack-b", quantity: 2 }),
      row({ item_id: 10, type: "menu", pack_reference: "pack-a" }),
      row({ item_id: 21, type: "menu", pack_reference: "pack-b" }),
      row({ item_id: 30, type: "group", pack_reference: "pack-b", menu_group_id: 900, price_per_quantity: 500, discount_price: 300 }),
    ];

    expect(discountOrderLines(rows).order_items).toEqual([
      { item_id: 20, quantity: 2, type: "menu", pack_id: 1, pack_unique_id: "pack-b" },
      { item_id: 30, price: 300, quantity: 1, type: "group", pack_id: 1, group_id: 900 },
      { item_id: 21, quantity: 1, type: "menu", pack_id: 1, pack_unique_id: "pack-b" },
      { item_id: 30, price: 300, quantity: 1, type: "group", pack_id: 1, group_id: 900 },
      { item_id: 10, quantity: 1, type: "menu", pack_id: 2, pack_unique_id: "pack-a" },
    ]);
  });

  test("emits option groups in JavaScript's key order: integer ids ascending, then others", () => {
    const rows = [
      row({ item_id: 1, type: "menu", pack_reference: "p" }),
      row({ item_id: 2, type: "group", pack_reference: "p", menu_group_id: 50 }),
      row({ item_id: 3, type: "group", pack_reference: "p", menu_group_id: null }),
      row({ item_id: 4, type: "group", pack_reference: "p", menu_group_id: 7 }),
    ];

    expect(discountOrderLines(rows).order_items.slice(1).map((line) => (line as { item_id: number }).item_id)).toEqual([4, 2, 3]);
  });

  test("lists container rows separately, never as order items", () => {
    const rows = [
      row({ item_id: 1, type: "menu", pack_reference: "p" }),
      row({ item_id: 99, type: "container", pack_reference: "p", name: "Bowl", price_per_quantity: 15000, quantity: 1 }),
    ];

    const lines = discountOrderLines(rows);

    expect(lines.order_items).toEqual([{ item_id: 1, quantity: 1, type: "menu", pack_id: 1, pack_unique_id: "p" }]);
    expect(lines.containers).toEqual([{ id: 99, quantity: 1, name: "Bowl", price: 15000, type: "container", pack_id: 1 }]);
  });

  test("ignores malformed rows and copes with an empty cart", () => {
    expect(discountOrderLines(["junk", null, 5])).toEqual({ order_items: [], containers: [] });
  });
});

describe("discountRequestBody", () => {
  const cart = { id: 555, currency: "NGN", cart_items: [row({ item_id: 1, type: "menu", pack_reference: "p" })] };

  test("uses the website's fields and its no-quote fallbacks", () => {
    expect(discountRequestBody({ promoCode: "SAVE10", vendorId: 7, addressId: 8, cart, orderClass: "vendor_delivery" })).toEqual({
      promo_codes: ["SAVE10"],
      vendor_id: 7,
      address_id: 8,
      fee_id: 0,
      cart_id: 555,
      currency: "NGN",
      order_items: [{ item_id: 1, quantity: 1, type: "menu", pack_id: 1, pack_unique_id: "p" }],
      containers: [],
      delivery_fee: 0,
      order_class: "delivery",
    });
  });

  /*
   * The website's request for 5FOR5, key order included.
   */
  test("sends the fee quote's id and delivery fee exactly as observed on the wire", () => {
    const observed = {
      id: 31006911,
      currency: "NGN",
      cart_items: [row({ item_id: 2974683, type: "menu", pack_reference: "pack-a4cba05e-21f1-562c-aa61-6d6b0d699fe9" })],
    };
    const body = discountRequestBody({
      promoCode: "5FOR5", vendorId: 134985, addressId: 4966130, cart: observed, orderClass: "delivery",
      fee: { id: 262993706, deliveryFee: 65000 },
    });

    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        promo_codes: ["5FOR5"], vendor_id: 134985, address_id: 4966130, fee_id: 262993706, cart_id: 31006911, currency: "NGN",
        order_items: [{ item_id: 2974683, quantity: 1, type: "menu", pack_id: 1, pack_unique_id: "pack-a4cba05e-21f1-562c-aa61-6d6b0d699fe9" }],
        containers: [], delivery_fee: 65000, order_class: "delivery",
      }),
    );
  });

  test("sends an empty promo list without a code, and no cart_id without a cart id", () => {
    const body = discountRequestBody({ vendorId: 7, addressId: 8, cart: { ...cart, id: undefined }, orderClass: "delivery" });

    expect(body.promo_codes).toEqual([]);
    expect(body).not.toHaveProperty("cart_id");
  });
});

describe("parseAppliedDiscounts and totalOff", () => {
  test("adds amount_off and bogof_amount_off, as the website totals them", () => {
    const discounts = parseAppliedDiscounts({ status: "success", data: [{ target: "menus", amount_off: 500, bogof_amount_off: 200 }, { amount_off: 100 }] });

    expect(discounts).toEqual([
      { target: "menus", amount_off: 500, bogof_amount_off: 200, promo_code: null },
      { target: null, amount_off: 100, bogof_amount_off: 0, promo_code: null },
    ]);
    expect(totalOff(discounts)).toBe(800);
  });

  /*
   * The 5FOR5 (free delivery) response, trimmed to the fields ChowBot reads.
   */
  test("keeps the promo code, title, description and terms Chowdeck returns, and matches discounts to a code", () => {
    const discounts = parseAppliedDiscounts({
      status: "success",
      message: "Discounts applied successfully",
      data: [
        {
          discount_id: 580242, title: "5FOR5", description: "Free delivery", amount_off: 65000, target: "deliveryfees",
          bogof_amount_off: 0, vendor_id: 134985, discount_terms: "Capped at NGN 1000. Minimum order amount is NGN 3000.",
          maximum_usage_count: 1, usage_count: 0, promo_code: "5FOR5",
        },
        { title: "Automatic", amount_off: 1000, target: "menus" },
      ],
    });

    expect(discounts[0]).toEqual({
      target: "deliveryfees", amount_off: 65000, bogof_amount_off: 0, promo_code: "5FOR5",
      title: "5FOR5", description: "Free delivery", terms: "Capped at NGN 1000. Minimum order amount is NGN 3000.",
    });
    expect(discountsForCode(discounts, "5for5")).toEqual([discounts[0]!]);
    expect(discountsForCode(discounts, "DECK11")).toEqual([]);
  });

  test.each([[{ data: "x" }], [{ data: [{ amount_off: Number.NaN }] }], ["text"], [{ data: [null] }]])("refuses %p", (body) => {
    expect(() => parseAppliedDiscounts(body)).toThrow("unexpected response shape");
  });
});
