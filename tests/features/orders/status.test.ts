import { describe, expect, test } from "bun:test";

import type { OrderDetail } from "../../../features/orders/service";
import { classifyOrder, orderAmounts, stateFromChowdeck, stateUnavailable } from "../../../features/orders/status";

/*
 * The unpaid order observed on 2026-10-22 (43609160), as get_order's
 * allowlist keeps it: status "abandoned" seconds after creation, payment {}
 * and no payment confirmation time.
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
  const unpaid = classifyOrder(observedUnpaid);

  test.each([
    ["no payment start", undefined, "order_created"],
    ["a payment link", { paymentStartedAt: new Date(), paymentStartState: "started" as const }, "payment_link_generated"],
    ["a payment start with an unknown outcome", { paymentStartedAt: new Date(), paymentStartState: "unknown" as const }, "payment_pending"],
    ["a payment start whose outcome was never recorded", { paymentStartedAt: new Date(), paymentStartState: null }, "payment_pending"],
    ["a refused payment start", { paymentStartedAt: new Date(), paymentStartState: "rejected" as const }, "order_created"],
  ] as const)("an unpaid order with %s is %s", (_, local, state) => {
    const report = stateFromChowdeck(43609160, unpaid, local);
    expect(report.order_state).toBe(state);
    expect(report.source).toStartWith("Chowdeck's order record, read ");
  });

  test("Chowdeck's payment confirmation wins over any local payment-start record", () => {
    const paid = classifyOrder(order({ payment: { status: "success" } }));
    expect(stateFromChowdeck(1, paid, { paymentStartedAt: null, paymentStartState: null }).order_state).toBe("payment_confirmed");
  });

  test("an unreadable order is unknown, never unpaid, with ChowBot's record shown as its own", () => {
    const report = stateUnavailable(1, "GET /customer/order/1 timed out", "created (ChowBot's record)");
    expect(report).toMatchObject({ order_state: "unknown", last_recorded_by_chowbot: "created (ChowBot's record)" });
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
