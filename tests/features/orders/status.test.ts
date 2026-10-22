import { describe, expect, test } from "bun:test";

import type { OrderDetail } from "../../../features/orders/service";
import { classifyOrder, orderAmounts, stateFromChowdeck, stateUnavailable } from "../../../features/orders/status";

/*
 * An unpaid order as get_order keeps it: status "abandoned", payment {} and
 * no payment confirmation time.
 */
const observed = {
  id: 43609160,
  status: "abandoned",
  total_price: 701000,
  items_price: 550000,
  delivery_price: 65000,
  service_price: 66000,
  bag_fee: 20000,
  promo_codes: "",
  promo_code_price: 0,
  discount_price: 0,
  time_payment_confirmed: null,
  payment: {},
};

const order = (fields: Record<string, unknown> = {}) => ({ ...observed, ...fields }) as unknown as OrderDetail;
const observedUnpaid = order();

describe("classifyOrder", () => {
  test("reads the observed unpaid order as awaiting payment, despite its status", () => {
    expect(classifyOrder(observedUnpaid)).toMatchObject({
      state: "awaiting_payment",
      paid: false,
      evidence: { orderStatus: "abandoned", paymentStatus: null },
    });
  });

  test.each([
    ["a successful payment", { payment: { status: "success" }, time_payment_confirmed: "2026-10-22T12:00:00.000Z" }, "payment_confirmed", true],
    ["a pending payment record", { payment: { status: "pending" } }, "awaiting_payment", false],
    ["a refunded payment", { payment: { status: "refunded" } }, "unknown", false],
    ["a confirmation time without a successful payment", { time_payment_confirmed: "2026-10-22T12:00:00.000Z" }, "unknown", false],
    ["a cancelled status", { status: "cancelled" }, "cancelled", false],
    ["a cancelled status after payment", { status: "cancelled_by_vendor", payment: { status: "success" } }, "cancelled", true],
  ])("reads %s", (_, fields, state, paid) => {
    expect(classifyOrder(order(fields))).toMatchObject({ state, paid });
  });

  test("never reads a cancelled-and-paid order as unpaid, and says a refund is not shown", () => {
    expect(classifyOrder(order({ status: "cancelled", payment: { status: "success" } })).reason).toContain(
      "does not show whether a refund was made",
    );
  });
});

describe("stateFromChowdeck", () => {
  test.each([
    ["no payment record", {}, "awaiting_payment"],
    ["a failed payment", { payment: { status: "failed" } }, "awaiting_payment"],
    ["a pending payment", { payment: { status: "pending" } }, "payment_pending"],
    ["an initialised payment", { payment: { status: "initialised" } }, "payment_pending"],
    ["a successful payment", { payment: { status: "success" } }, "payment_confirmed"],
    ["a cancelled status", { status: "cancelled" }, "cancelled"],
    ["a payment status ChowBot does not understand", { payment: { status: "reversed" } }, "unknown"],
  ] as const)("an order with %s is %s, read from Chowdeck's record only", (_, fields, state) => {
    const report = stateFromChowdeck(43609160, classifyOrder(order(fields)));
    expect(report.order_state).toBe(state);
    expect(report.source).toStartWith("Chowdeck's order record, read ");
    expect(report).not.toHaveProperty("last_recorded_by_chowbot");
  });

  test("an unreadable order is unknown, never unpaid", () => {
    const report = stateUnavailable(1, "GET /customer/order/1 timed out");
    expect(report).toMatchObject({ order_state: "unknown", source: "none: Chowdeck's order record could not be read" });
    expect(report.detail).toContain("does not mean it is unpaid, paid or cancelled");
  });
});

describe("orderAmounts", () => {
  test("reports Chowdeck's total and parts in naira, and discounts only when positive", () => {
    expect(orderAmounts(observedUnpaid)).toEqual({
      total: "₦7,010.00",
      total_raw: 701000,
      source: "Chowdeck's order record (total_price)",
      parts: { items_price: "₦5,500.00", delivery_price: "₦650.00", service_price: "₦660.00", bag_fee: "₦200.00" },
    });
    expect(orderAmounts(order({ total_price: 636000, promo_code_price: 65000, promo_codes: "5FOR5" }))).toMatchObject({
      total: "₦6,360.00",
      discounts: { promo_code_price: "₦650.00" },
      promo_codes: "5FOR5",
    });
  });

  test("has no amounts without a numeric total", () => {
    expect(orderAmounts(order({ total_price: "701000" }))).toBeUndefined();
  });
});
