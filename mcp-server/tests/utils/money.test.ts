import { describe, expect, test } from "bun:test";

import { formatNaira, toNairaJson } from "../../utils/money";

describe("naira results", () => {
  test("formats kobo as naira", () => {
    expect(formatNaira(651837)).toBe("₦6,518.37");
    expect(formatNaira(0)).toBe("₦0.00");
  });

  test("shows money fields in naira at any depth, leaving other numbers alone", () => {
    const shown = JSON.parse(
      toNairaJson({
        id: 30742921,
        total_price: 440000,
        packs: [{ rows: [{ quantity: 2, price_per_quantity: 180000, item_id: 880557 }] }],
        quote: { final_delivery_amount: 70000, amount: 70000 },
        coordinate: { x: 3.28, y: 6.68 },
        already: "₦5.00",
      }),
    );

    expect(shown).toEqual({
      id: 30742921,
      total_price: "₦4,400.00",
      packs: [{ rows: [{ quantity: 2, price_per_quantity: "₦1,800.00", item_id: 880557 }] }],
      quote: { final_delivery_amount: "₦700.00", amount: "₦700.00" },
      coordinate: { x: 3.28, y: 6.68 },
      already: "₦5.00",
    });
  });

  test("leaves out internal *_raw kobo values", () => {
    expect(JSON.parse(toNairaJson({ total: "₦5,540.00", total_raw: 554000 }))).toEqual({ total: "₦5,540.00" });
  });
});
