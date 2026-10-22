import { isRecord } from "../../utils/object";
import { NotSignedInError } from "../addresses/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import OrderService, { readOrderState, type OrderDetail } from "../orders/service";
import {
  notSentReport,
  orderAmounts,
  reportResult,
  stateFromChowdeck,
  stateUnavailable,
  type ActionReport,
  type OrderClassification,
} from "../orders/status";
import { formatNaira } from "../checkout/draft";
import type { SupportedPaymentChannel } from "../order-placement/channels";
import { chowdeckAuthHeaders, type UserSession } from "../../lib/session";

export const PAYMENT_START_PATH = "/customer/payment/start/v2";

/*
 * The website's payment redirects: OPay takes return_url (the ongoing-order
 * page) and cancel_url (checkout?status=failed); every other channel takes
 * callback_url and return_url, both the ongoing-order page.
 */
export type PaymentStartConfig = {
  origin: string;
};

export const CHOWDECK_WEBSITE_ORIGIN = "https://chowdeck.com";

export const paymentRedirects = (config: PaymentStartConfig, orderId: number, channel: SupportedPaymentChannel) => {
  const ongoingOrder = `${config.origin}/store/ongoing-order?orderId=${orderId}`;
  return channel === "opay"
    ? { return_url: ongoingOrder, cancel_url: `${config.origin}/store/checkout?status=failed` }
    : { callback_url: ongoingOrder, return_url: ongoingOrder };
};

const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/*
 * The payment link is shown to the user only if it is an https URL without
 * embedded credentials; anything else is an unexpected response.
 */
const isPaymentLink = (value: unknown): value is string => {
  if (!isHttpsUrl(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password;
};

export const createPaymentStartConfig = (origin: string = CHOWDECK_WEBSITE_ORIGIN): PaymentStartConfig => {
  if (!isHttpsUrl(origin) || new URL(origin).origin !== origin) {
    throw new Error("The payment-start origin must be an https origin such as https://chowdeck.com");
  }
  return { origin };
};

// pocket_tag is required for pocket and sent without a leading "@".
export type StartPaymentArgs = { order_id: number; payment_channel: SupportedPaymentChannel; pocket_tag?: string };

const refused = (message: string, nextStep: string, status: ActionReport["status"] = null) =>
  notSentReport("start_payment", message, nextStep, status);

const describeError = (error: unknown) =>
  error instanceof ChowdeckApiError ? error.message : "unexpected error";

/*
 * A 401 is not a definite rejection: it cannot be taken as proof that no
 * payment was started.
 */
const isDefiniteRejection = (error: unknown): error is ChowdeckApiError =>
  error instanceof ChowdeckApiError &&
  error.kind === "http" &&
  error.status !== undefined &&
  error.status < 500 &&
  error.status !== 401;

export const pocketTagOf = (value: string | undefined) => value?.trim().replace(/^@/, "") || undefined;

/*
 * The only code path that sends POST /customer/payment/start/v2. Chowdeck's
 * order record decides whether a payment may start; the request is sent once
 * and never repeated, and an unclear outcome is checked against the order
 * record instead. The link is returned only in the tool result, never stored
 * or logged.
 */
class PaymentService {
  private readonly orders: OrderService;

  constructor(
    private readonly session: UserSession,
    private readonly config: PaymentStartConfig,
    private readonly client = new ChowdeckClient(),
  ) {
    this.orders = new OrderService(session, client);
  }

  private async authHeaders() {
    const headers = await chowdeckAuthHeaders(this.session);
    if (!headers.authorization) throw new NotSignedInError();
    return headers;
  }

  async startPayment(args: StartPaymentArgs) {
    const headers = await this.authHeaders();
    const pocketTag = pocketTagOf(args.pocket_tag);
    if (args.payment_channel === "pocket" && !pocketTag) {
      return refused(
        "Payment not started: a PocketApp payment needs the payer's Pocket tag. Nothing was started.",
        "Ask the user for their Pocket tag, then call start_payment again with pocket_tag.",
      );
    }
    let read;
    try {
      read = await readOrderState(this.orders, args.order_id);
    } catch (error) {
      if (error instanceof NotSignedInError) throw error;
      return refused(
        `Payment not started: ChowBot could not read order ${args.order_id} from Chowdeck (${describeError(error)}), so it cannot confirm the order is unpaid. Nothing was started.`,
        "Try again later; nothing was sent.",
        stateUnavailable(args.order_id, describeError(error)),
      );
    }
    const report = await this.startFor(args.order_id, args.payment_channel, read, headers, pocketTag);
    return reportResult(report, !["payment_link_generated", "already_paid"].includes(report.outcome));
  }

  /*
   * Starts payment for an order whose record was just read, unless that
   * record shows it paid, cancelled or inconclusive. Shared with place_order,
   * which calls it right after creating an online-channel order.
   */
  async startFor(
    orderId: number,
    channel: SupportedPaymentChannel,
    read: { order: OrderDetail; classification: OrderClassification },
    headers?: Record<string, string>,
    pocketTag?: string,
  ): Promise<ActionReport> {
    const { order, classification } = read;
    const status = stateFromChowdeck(orderId, classification);
    const notSent = (message: string, nextStep: string, outcome = "not_sent"): ActionReport => ({
      action: "start_payment",
      outcome,
      message,
      chowdeck_confirmed: [classification.reason],
      status,
      next_step: nextStep,
      outcome_uncertain: false,
      safe_to_retry: true,
    });
    if (classification.state === "payment_confirmed") {
      return notSent("Payment not started: Chowdeck shows this order is already paid.", "Tell the user the order is paid. Nothing else to pay.", "already_paid");
    }
    if (classification.state === "cancelled") {
      return notSent("Payment not started: Chowdeck shows this order cancelled.", "Tell the user the order is cancelled; there is nothing to pay.");
    }
    if (classification.state !== "awaiting_payment") {
      return notSent(
        `Payment not started: ${classification.reason}, so ChowBot cannot confirm the order is unpaid. Nothing was started.`,
        "Check the order in the Chowdeck app before paying.",
      );
    }
    if (order.has_external_payment === true) {
      return notSent(
        "Payment not started: this is a pay-for-me order; whoever pays uses its pay-for-me link (get_order shows it).",
        "Share the pay-for-me link with the person paying, or check the order with get_order.",
      );
    }
    const amounts = orderAmounts(order);
    if (!amounts) {
      return notSent(
        "Payment not started: Chowdeck's order record shows no total, so the amount to pay cannot be confirmed. Nothing was started.",
        "Pay in the Chowdeck app.",
      );
    }

    let response: unknown;
    try {
      response = await this.client.request(PAYMENT_START_PATH, {
        method: "POST",
        headers: headers ?? (await this.authHeaders()),
        body: {
          method: channel,
          order_id: orderId,
          ...paymentRedirects(this.config, orderId, channel),
          ...(pocketTag && { pocket_tag: pocketTag }),
        },
      });
    } catch (error) {
      if (isDefiniteRejection(error)) {
        return {
          action: "start_payment",
          outcome: "rejected_by_chowdeck",
          message: `Payment not started: Chowdeck refused to start the payment (status ${error.status}).`,
          chowdeck_confirmed: [`Chowdeck refused the payment start (status ${error.status})`],
          status,
          next_step: "Tell the user Chowdeck refused it; they can pay in the Chowdeck app or try another payment channel.",
          outcome_uncertain: false,
          safe_to_retry: true,
        };
      }
      return this.unknownOutcome(orderId, describeError(error));
    }

    const data =
      isRecord(response) && response.status === "success" && isRecord(response.data)
        ? response.data
        : undefined;
    const link = data?.authorization_url;
    if (!isPaymentLink(link)) {
      return this.unknownOutcome(orderId, `POST ${PAYMENT_START_PATH} returned an unexpected response`);
    }

    /*
     * OPay and Pocket report amountInLowerUnits; Paystack does not. A mismatch
     * only warns: the link is still returned, as it cannot be recovered later.
     */
    const charged = data?.amountInLowerUnits;
    const chargedKnown = typeof charged === "number" && Number.isFinite(charged);
    const mismatch = chargedKnown && charged !== amounts.total_raw;
    // Pocket answers display_type "inapp": the request goes to the payer's Pocket app.
    const inApp = data?.display_type === "inapp";
    const warnings = [
      ...(status.order_state === "payment_pending"
        ? ["Chowdeck already had an unfinished payment for this order. If the user already paid through an earlier link, they should wait for it to confirm (get_order) rather than pay again."]
        : []),
      ...(mismatch
        ? [`The payment page amount (${formatNaira(charged)}) differs from Chowdeck's order total (${amounts.total}). Tell the user before they pay.`]
        : []),
    ];
    return {
      action: "start_payment",
      outcome: "payment_link_generated",
      message: inApp
        ? `Chowdeck sent a payment request of ${amounts.total} for order ${orderId} to the Pocket tag ${pocketTag}. Approve it in the Pocket app. Payment page: ${link}`
        : `Open this link to pay ${amounts.total} for Chowdeck order ${orderId} with ${channel}: ${link}`,
      chowdeck_confirmed: [
        "Chowdeck started the payment and returned a payment link",
        `Chowdeck's order record shows a total of ${amounts.total}`,
        ...(chargedKnown ? [`the payment processor reports ${formatNaira(charged)} to pay`] : []),
      ],
      status,
      amount: { ...amounts, ...(chargedKnown && { payment_page_amount: formatNaira(charged) }) },
      order_id: orderId,
      payment_link: link,
      ...(warnings.length > 0 && { warnings }),
      next_step: `${
        inApp
          ? "Tell the user to approve the payment request in their Pocket app."
          : "Give the user this link as a clickable link to open and pay in their browser."
      } Payment is confirmed only when get_order shows it, never from this link.`,
      outcome_uncertain: false,
      safe_to_retry: false,
    };
  }

  /*
   * Never resent: the order record is read once more for evidence, and the
   * outcome stays unknown whatever it shows, because a payment page may exist.
   */
  private async unknownOutcome(orderId: number, detail: string): Promise<ActionReport> {
    let status: ActionReport["status"];
    try {
      status = stateFromChowdeck(orderId, (await readOrderState(this.orders, orderId)).classification);
    } catch (error) {
      status = stateUnavailable(orderId, describeError(error));
    }
    const paid = status.order_state === "payment_confirmed";
    return {
      action: "start_payment",
      outcome: paid ? "already_paid" : "unknown_outcome",
      message: paid
        ? `The payment start's response was unclear (${detail}), but Chowdeck's order record now shows order ${orderId} paid.`
        : `The payment start's outcome is unknown (${detail}): a payment page may or may not exist, and ChowBot has no link to give. ${
            status.order_state === "payment_pending"
              ? "Chowdeck's order record now shows an unfinished payment, so one was probably started."
              : "Chowdeck's order record shows no payment in progress, which does not prove none was started."
          }`,
      chowdeck_confirmed: status.order_state === "unknown" ? [] : [status.detail],
      status,
      next_step: paid
        ? "Tell the user the order is paid."
        : "Do not start another payment straight away. Ask the user to check the order in the Chowdeck app (or get_order); only if it is still unpaid and they have no payment page open, call start_payment again.",
      outcome_uncertain: !paid,
      safe_to_retry: false,
    };
  }
}

export default PaymentService;
