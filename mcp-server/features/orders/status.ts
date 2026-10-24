import type { CallToolResult } from "@modelcontextprotocol/server";

import { formatNaira, toNairaJson } from "../../utils/money";
import type { OrderDetail } from "./service";

/*
 * Only Chowdeck's order record is payment evidence, and paid means
 * payment.status "success": unpaid orders read "abandoned" with a MADE_PAYMENT
 * timeline step. Any status containing "cancel" is read as cancelled.
 */
export type ChowdeckOrderState = "payment_confirmed" | "awaiting_payment" | "cancelled" | "unknown";

export type OrderEvidence = { orderStatus: string | null; paymentStatus: string | null };

/*
 * Any other non-success status (e.g. "refunded") is reported as unknown, not unpaid.
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
 * The order states every ordering and payment tool reports, all read from
 * Chowdeck's order record:
 *   awaiting_payment   no payment, or only a failed or abandoned one
 *   payment_pending    a pending or initialised payment, which may still complete
 *   payment_confirmed  the payment succeeded
 *   cancelled          the order is cancelled
 *   unknown            the record could not be read, or is inconclusive
 */
const IN_PROGRESS_PAYMENT_STATUSES = new Set(["pending", "initialised", "initialized"]);

export type OrderState = "awaiting_payment" | "payment_pending" | "payment_confirmed" | "cancelled" | "unknown";

export type OrderStatusReport = {
  order_id: number;
  order_state: OrderState;
  source: string;
  detail: string;
  chowdeck_order_status?: string | null;
  chowdeck_payment_status?: string | null;
};

export const stateFromChowdeck = (orderId: number, classification: OrderClassification): OrderStatusReport => {
  const base = {
    order_id: orderId,
    source: `Chowdeck's order record, read ${new Date().toISOString()}`,
    chowdeck_order_status: classification.evidence.orderStatus,
    chowdeck_payment_status: classification.evidence.paymentStatus,
  };
  if (classification.state !== "awaiting_payment") {
    return { ...base, order_state: classification.state, detail: classification.reason };
  }
  return IN_PROGRESS_PAYMENT_STATUSES.has(classification.evidence.paymentStatus ?? "")
    ? {
        ...base,
        order_state: "payment_pending",
        detail: `${classification.reason}. Chowdeck has a payment that has not completed, so it may still be in progress`,
      }
    : { ...base, order_state: "awaiting_payment", detail: classification.reason };
};

export const stateUnavailable = (orderId: number, reason: string): OrderStatusReport => ({
  order_id: orderId,
  order_state: "unknown",
  source: "none: Chowdeck's order record could not be read",
  detail: `ChowBot could not read the order from Chowdeck (${reason}), so its current state is unknown. This does not mean it is unpaid, paid or cancelled`,
});

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
  content: [{ type: "text", text: toNairaJson(report) }],
  ...(isError && { isError }),
});

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
