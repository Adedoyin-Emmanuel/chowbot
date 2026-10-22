import type { CallToolResult } from "@modelcontextprotocol/server";

import { formatNaira } from "../checkout/draft";
import type { OrderDetail } from "./service";
import type { OrderEvidence, OrderSubmission } from "../../lib/order-submissions";

/*
 * What Chowdeck's own order record (GET /customer/order/{id}) says about an
 * order, and nothing else. ChowBot's database, a payment-start response, a
 * user's statement or a tool call succeeding are never payment evidence.
 *
 * Observed 2026-10-22 (orders 43584305, 43591071, 43609160): an unpaid order
 * has status "abandoned" seconds after creation, payment: {} and
 * time_payment_confirmed: null, and still lists a MADE_PAYMENT timeline step.
 * Paid is therefore only payment.status "success". A cancelled order was never
 * observed; any status containing "cancel" is read as cancelled.
 */
export type ChowdeckOrderState = "payment_confirmed" | "awaiting_payment" | "cancelled" | "unknown";

/*
 * Payment statuses that show no payment was taken. Anything else that is not
 * "success" (for example "refunded" or "reversed") is not understood, so it
 * is reported as unknown rather than as unpaid.
 */
const UNPAID_PAYMENT_STATUSES = new Set(["pending", "initialised", "initialized", "failed", "abandoned"]);

export type OrderClassification = {
  state: ChowdeckOrderState;
  paid: boolean;
  evidence: OrderEvidence;
  reason: string;
};

export const classifyOrder = (order: OrderDetail): OrderClassification => {
  const evidence: OrderEvidence = {
    orderStatus: typeof order.status === "string" ? order.status : null,
    paymentStatus: typeof order.payment?.status === "string" ? order.payment.status : null,
  };
  const paid = evidence.paymentStatus === "success";
  const confirmedAt = order.time_payment_confirmed;
  const shown = `order status ${evidence.orderStatus ?? "not given"}, payment status ${evidence.paymentStatus ?? "not given"}`;

  if (evidence.orderStatus !== null && /cancel/i.test(evidence.orderStatus)) {
    return {
      state: "cancelled",
      paid,
      evidence,
      reason: paid
        ? `Chowdeck's order record shows the order cancelled after a successful payment (${shown}); it does not show whether a refund was made`
        : `Chowdeck's order record shows the order cancelled (${shown})`,
    };
  }
  if (paid) {
    return { state: "payment_confirmed", paid, evidence, reason: `Chowdeck's order record shows the payment succeeded (${shown})` };
  }
  if (typeof confirmedAt === "string" && confirmedAt.length > 0) {
    return {
      state: "unknown",
      paid,
      evidence,
      reason: `Chowdeck's order record has a payment confirmation time but no successful payment status (${shown}), so the payment state is unclear`,
    };
  }
  if (evidence.paymentStatus === null || UNPAID_PAYMENT_STATUSES.has(evidence.paymentStatus)) {
    return { state: "awaiting_payment", paid, evidence, reason: `Chowdeck's order record shows no payment yet (${shown})` };
  }
  return {
    state: "unknown",
    paid,
    evidence,
    reason: `Chowdeck's order record shows a payment status ChowBot does not understand (${shown})`,
  };
};

/*
 * The order states every ordering and payment tool reports:
 *   order_created           Chowdeck shows the order unpaid; ChowBot has not generated a payment link
 *   payment_link_generated  Chowdeck gave ChowBot a payment link; its order record shows no payment yet
 *   payment_pending         Chowdeck shows no completed payment, while a payment may be in progress
 *                           (a payment start with an unknown outcome, or a pending payment record)
 *   payment_confirmed       Chowdeck's order record shows the payment succeeded
 *   cancelled               Chowdeck's order record shows the order cancelled
 *   unknown                 Chowdeck could not be read, or its record is inconclusive
 */
export type OrderState =
  | "order_created"
  | "payment_link_generated"
  | "payment_pending"
  | "payment_confirmed"
  | "cancelled"
  | "unknown";

export type OrderStatusReport = {
  order_id: number;
  order_state: OrderState;
  source: string;
  detail: string;
  chowdeck_order_status?: string | null;
  chowdeck_payment_status?: string | null;
  last_recorded_by_chowbot?: string;
};

type LocalPaymentStart = Pick<OrderSubmission, "paymentStartedAt" | "paymentStartState">;

export const stateFromChowdeck = (
  orderId: number,
  classification: OrderClassification,
  local?: LocalPaymentStart,
): OrderStatusReport => {
  const base = {
    order_id: orderId,
    source: `Chowdeck's order record, read ${new Date().toISOString()}`,
    chowdeck_order_status: classification.evidence.orderStatus,
    chowdeck_payment_status: classification.evidence.paymentStatus,
  };
  if (classification.state !== "awaiting_payment") {
    return { ...base, order_state: classification.state, detail: classification.reason };
  }
  const start = local?.paymentStartedAt ? (local.paymentStartState ?? "in_flight") : undefined;
  if (start === "started") {
    return {
      ...base,
      order_state: "payment_link_generated",
      detail: `${classification.reason}. ChowBot generated a payment link for it; payment is confirmed only when Chowdeck's order record shows it`,
    };
  }
  if (start === "unknown" || start === "in_flight" || classification.evidence.paymentStatus !== null) {
    return {
      ...base,
      order_state: "payment_pending",
      detail: `${classification.reason}. ${start === "unknown" || start === "in_flight" ? "A payment start's outcome is unknown, so a payment may be in progress" : "Chowdeck has a payment record that has not succeeded"}`,
    };
  }
  return {
    ...base,
    order_state: "order_created",
    detail: `${classification.reason}${start === "rejected" ? ". Chowdeck refused ChowBot's payment start for it" : ""}`,
  };
};

/*
 * Chowdeck could not be read: the state is unknown, whatever ChowBot last
 * recorded, and that record is shown only as ChowBot's own.
 */
export const stateUnavailable = (orderId: number, reason: string, recorded?: string): OrderStatusReport => ({
  order_id: orderId,
  order_state: "unknown",
  source: "none: Chowdeck's order record could not be read",
  detail: `ChowBot could not read the order from Chowdeck (${reason}), so its current state is unknown. This does not mean it is unpaid, paid or cancelled`,
  ...(recorded && { last_recorded_by_chowbot: recorded }),
});

/*
 * What ChowBot last recorded for an attempt, for display beside a fresh
 * reading or when Chowdeck cannot be read. Never presented as Chowdeck's.
 */
export const recordedState = (attempt: Pick<OrderSubmission, "state" | "updatedAt">) =>
  `${attempt.state} (ChowBot's record, ${attempt.updatedAt.toISOString()}; not a fresh Chowdeck reading)`;

const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const DISCOUNT_FIELDS = ["promo_code_price", "discount_price", "voucher_amount", "vendor_discount_amount"] as const;
const PART_FIELDS = ["items_price", "delivery_price", "service_price", "bag_fee", "tip_amount", "small_order_price", "safety_fee", "container_fee"] as const;

export type OrderAmounts = {
  total: string;
  total_raw: number;
  source: string;
  parts: Record<string, string>;
  discounts?: Record<string, string>;
  promo_codes?: string;
};

/*
 * The amounts on Chowdeck's order record, in naira. Undefined when the
 * record has no numeric total_price.
 */
export const orderAmounts = (order: OrderDetail): OrderAmounts | undefined => {
  if (!isAmount(order.total_price)) return undefined;
  const parts: Record<string, string> = {};
  for (const field of PART_FIELDS) {
    const value = order[field];
    if (isAmount(value) && value !== 0) parts[field] = formatNaira(value);
  }
  const discounts: Record<string, string> = {};
  for (const field of DISCOUNT_FIELDS) {
    const value = order[field];
    if (isAmount(value) && value > 0) discounts[field] = formatNaira(value);
  }
  const promoCodes = typeof order.promo_codes === "string" && order.promo_codes.trim() ? order.promo_codes : undefined;
  return {
    total: formatNaira(order.total_price),
    total_raw: order.total_price,
    source: "Chowdeck's order record (total_price)",
    parts,
    ...(Object.keys(discounts).length > 0 && { discounts }),
    ...(promoCodes && { promo_codes: promoCodes }),
  };
};

/*
 * The shape every ordering, payment and cancellation tool returns:
 *   action              what was attempted
 *   outcome             a short code for what happened
 *   message             the same in one or two sentences for the user
 *   chowdeck_confirmed  only what Chowdeck itself confirmed
 *   status              the order's current state and its source, or null
 *   amount              Chowdeck's amounts, when known
 *   next_step           what the user should do next
 *   outcome_uncertain   whether something may have happened that ChowBot cannot confirm
 *   safe_to_retry       whether repeating the same call cannot create a duplicate order,
 *                       payment or cancellation
 */
export type ActionReport = {
  action: string;
  outcome: string;
  message: string;
  chowdeck_confirmed: string[];
  status: OrderStatusReport | null;
  amount?: unknown;
  next_step: string;
  outcome_uncertain: boolean;
  safe_to_retry: boolean;
} & Record<string, unknown>;

export const reportResult = (report: ActionReport, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(report) }],
  ...(isError && { isError }),
});

/*
 * A refusal before anything was sent to Chowdeck.
 */
export const notSentReport = (action: string, message: string, nextStep: string, status: OrderStatusReport | null = null) =>
  reportResult(
    {
      action,
      outcome: "not_sent",
      message,
      chowdeck_confirmed: [],
      status,
      next_step: nextStep,
      outcome_uncertain: false,
      safe_to_retry: true,
    },
    true,
  );
