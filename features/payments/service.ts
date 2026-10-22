import type {
  OrderSubmission,
  PaymentStartState,
  UserOrderSubmissions,
} from "../../lib/order-submissions";
import { logger } from "../../utils/logger";
import { isRecord } from "../../utils/object";
import { NotSignedInError } from "../addresses/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import OrderService, { readOrderState } from "../orders/service";
import {
  notSentReport,
  orderAmounts,
  recordedState,
  reportResult,
  stateFromChowdeck,
  stateUnavailable,
  type OrderClassification,
  type OrderStatusReport,
} from "../orders/status";
import { formatNaira } from "../checkout/draft";
import { SUPPORTED_PAYMENT_CHANNELS, type SupportedPaymentChannel } from "../order-placement/channels";
import { chowdeckAuthHeaders, type UserSession } from "../../lib/session";

export const PAYMENT_START_PATH = "/customer/payment/start/v2";

/*
 * The redirect URLs the Chowdeck website sends with a payment start
 * (storefront chunk 3488, read 2026-10-21; every channel observed
 * 2026-10-22). OPay:
 *   return_url: `${origin}/store/ongoing-order?orderId=${order id}`
 *   cancel_url: `${origin}${pathname}${search}?status=failed`, i.e. the
 *               checkout page, /store/checkout?status=failed
 * Every other channel: callback_url and return_url, both the ongoing-order
 * page. ChowBot sends the same pages on the website's origin, so after paying the
 * user lands on Chowdeck's own order page. GET /customer/order/{id} was
 * observed returning an unpaid order (2026-10-22, order 43609160), with its
 * total_price; start_payment reads it before every start.
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

const isSupportedChannel = (name: string | null): name is SupportedPaymentChannel =>
  name !== null && (SUPPORTED_PAYMENT_CHANNELS as readonly string[]).includes(name);

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

/*
 * confirmed_total: the raw total from the first call's summary, sent back
 * only after the user accepted it. The payment starts only if Chowdeck's
 * order record, read again, still shows exactly that total.
 * pocket_tag: the payer's PocketApp tag, required to start a pocket payment;
 * the website sends it without a leading "@".
 */
export type StartPaymentArgs = { quote_ref: string; confirmed_total?: number; pocket_tag?: string };

/*
 * R2: only the local database write is retried, never the payment start.
 */
const PERSIST_ATTEMPTS = 3;
const PERSIST_BACKOFF_MS = [100, 400];

const refused = (message: string, nextStep: string, status: OrderStatusReport | null = null) =>
  notSentReport("start_payment", message, nextStep, status);

const PAY_IN_APP = "Pay in the Chowdeck app, or check the order with get_order_submission.";

const describeError = (error: unknown) =>
  error instanceof ChowdeckApiError ? error.message : "unexpected error";

const logFailure = (what: string, error: unknown) =>
  logger.error(what, error instanceof Error ? error.name : typeof error);

/*
 * As for the order request, a 401 is not a definite rejection: it cannot be
 * taken as proof that no payment was started.
 */
const isDefiniteRejection = (error: unknown): error is ChowdeckApiError =>
  error instanceof ChowdeckApiError &&
  error.kind === "http" &&
  error.status !== undefined &&
  error.status < 500 &&
  error.status !== 401;

const PAYMENT_START_GUIDANCE: Record<PaymentStartState | "in_flight", string> =
  {
    started:
      "a payment was already started for this order; ChowBot does not start another. Complete or retry payment in the Chowdeck app",
    rejected:
      "Chowdeck refused the earlier payment start for this order; ChowBot does not try again. Pay in the Chowdeck app",
    unknown:
      "an earlier payment start for this order has an unknown outcome; ChowBot does not try again. Check the Chowdeck app before paying, so you do not pay twice",
    in_flight:
      "an earlier payment start for this order was sent but its outcome was not recorded; ChowBot does not try again. Check the Chowdeck app before paying, so you do not pay twice",
  };

/*
 * The only code path that sends POST /customer/payment/start/v2. For one
 * created, unpaid order it confirms with Chowdeck that the order is unpaid,
 * commits the payment-start marker, and only then sends the request, exactly
 * once. The payment link is returned in the tool result, for every client,
 * only after a successful response with a valid https link; it never appears
 * in the database or the logs.
 */
class PaymentStartService {
  private readonly orders: OrderService;

  constructor(
    private readonly session: UserSession,
    private readonly submissions: UserOrderSubmissions,
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

  /*
   * The link is never offered through a URL elicitation: a declared
   * capability does not prove the client can show the prompt, and a link lost
   * after the payment started cannot be recovered, as ChowBot never starts a
   * second payment for an order.
   *
   * Two calls: the first reads Chowdeck's order record and shows its total;
   * the second, with that total as confirmed_total, re-reads the record and
   * starts the payment only if the total is unchanged. A changed total (for
   * example a promo discount applied differently) needs a new confirmation.
   */
  async startPayment(args: StartPaymentArgs) {
    await this.authHeaders();
    const submission = await this.submissions.get(args.quote_ref);
    if (!submission)
      return refused("Payment not started: that quote_ref does not exist for your account.", "Use the quote_ref from place_order.");
    if (submission.state === "paid" && submission.chowdeckOrderId) {
      return this.recordedPaid(submission, submission.chowdeckOrderId);
    }
    const refusal = this.refusalFor(submission);
    if (refusal) return refused(`Payment not started: ${refusal}.`, PAY_IN_APP);
    const orderId = submission.chowdeckOrderId!;

    let read;
    try {
      read = await readOrderState(this.orders, orderId);
    } catch (error) {
      if (error instanceof NotSignedInError) throw error;
      return refused(
        `Payment not started: ChowBot could not confirm with Chowdeck that order ${orderId} is unpaid (${describeError(error)}). Nothing was started.`,
        "Try again later; nothing was sent, so it is safe to retry.",
        stateUnavailable(orderId, describeError(error), recordedState(submission)),
      );
    }
    const { order, classification } = read;
    const status = stateFromChowdeck(orderId, classification, submission);
    if (classification.state === "payment_confirmed") {
      await this.persist(() =>
        this.submissions.recordPaid(submission.id, classification.evidence),
      );
      return reportResult({
        action: "start_payment",
        outcome: "already_paid",
        message: "Payment not started: Chowdeck shows this order is already paid.",
        chowdeck_confirmed: [classification.reason],
        status,
        next_step: "Tell the user the order is paid. Nothing else to pay.",
        outcome_uncertain: false,
        safe_to_retry: true,
      });
    }
    if (classification.state !== "awaiting_payment") {
      return refused(
        `Payment not started: ${classification.reason}, so ChowBot cannot confirm the order is unpaid. Nothing was started.`,
        PAY_IN_APP,
        status,
      );
    }
    const amounts = orderAmounts(order);
    if (!amounts) {
      return refused(
        "Payment not started: Chowdeck's order record shows no total, so the amount to pay cannot be confirmed. Nothing was started.",
        PAY_IN_APP,
        status,
      );
    }

    const needsPocketTag = submission.paymentChannelName === "pocket";
    if (args.confirmed_total === undefined) {
      return reportResult({
        action: "start_payment",
        outcome: "confirmation_required",
        message: `Nothing was started yet. Chowdeck's order record shows ${amounts.total} to pay for order ${orderId}.`,
        chowdeck_confirmed: [classification.reason, `Chowdeck's order record shows a total of ${amounts.total}`],
        status,
        amount: amounts,
        confirmed_total: amounts.total_raw,
        next_step: `Show the user the amount (${amounts.total}${amounts.discounts ? ", including the discounts listed" : ""}) and ask whether to pay it with ${submission.paymentChannelName}${needsPocketTag ? ", and ask for their Pocket tag" : ""}. Only if they say yes, call start_payment again with the same quote_ref and confirmed_total: ${amounts.total_raw}${needsPocketTag ? " and their pocket_tag" : ""}.`,
        outcome_uncertain: false,
        safe_to_retry: true,
      });
    }
    if (args.confirmed_total !== amounts.total_raw) {
      return refused(
        `Payment not started: Chowdeck's order total is now ${amounts.total}, not the ${formatNaira(args.confirmed_total)} that was confirmed. Nothing was started.`,
        `Show the user the new total and, only if they accept it, call start_payment again with confirmed_total: ${amounts.total_raw}.`,
        status,
      );
    }

    const pocketTag = args.pocket_tag?.replace(/^@/, "");
    if (needsPocketTag && !pocketTag) {
      return refused(
        "Payment not started: a PocketApp payment needs the payer's Pocket tag. Nothing was started.",
        `Ask the user for their Pocket tag, then call start_payment again with confirmed_total: ${amounts.total_raw} and pocket_tag.`,
        status,
      );
    }

    const headers = await this.authHeaders();
    let marked: boolean;
    try {
      marked = await this.submissions.markPaymentStarted(
        submission.id,
        orderId,
      );
    } catch (error) {
      logFailure("Marking a payment start failed:", error);
      return refused(
        "Payment not started: ChowBot could not confirm it was safe to start the payment, so nothing was sent.",
        PAY_IN_APP,
        status,
      );
    }
    if (!marked) {
      return refused(
        "Payment not started: this order changed, or a payment or cancellation was started for it in the meantime. Nothing was sent.",
        "Check it with get_order_submission.",
        status,
      );
    }

    return this.sendPaymentStartOnce(
      submission,
      orderId,
      headers,
      amounts.total_raw,
      classification,
      needsPocketTag ? pocketTag : undefined,
    );
  }

  /*
   * ChowBot recorded Chowdeck's payment confirmation earlier. Nothing is
   * started; the user is told what Chowdeck's order record shows now.
   */
  private async recordedPaid(submission: OrderSubmission, orderId: number) {
    let status: OrderStatusReport;
    const confirmed: string[] = [];
    try {
      const { classification } = await readOrderState(this.orders, orderId);
      status = stateFromChowdeck(orderId, classification, submission);
      confirmed.push(classification.reason);
    } catch (error) {
      if (error instanceof NotSignedInError) throw error;
      status = stateUnavailable(orderId, describeError(error), recordedState(submission));
    }
    return reportResult({
      action: "start_payment",
      outcome: status.order_state === "payment_confirmed" ? "already_paid" : "not_sent",
      message:
        status.order_state === "payment_confirmed"
          ? "Payment not started: Chowdeck shows this order is already paid."
          : "Payment not started: ChowBot recorded Chowdeck's payment confirmation for this order earlier, so it starts no payment; see status for what Chowdeck shows now.",
      chowdeck_confirmed: confirmed,
      status,
      next_step:
        status.order_state === "payment_confirmed"
          ? "Tell the user the order is paid. Nothing else to pay."
          : "Tell the user what status shows, and check the order in the Chowdeck app before paying anything.",
      outcome_uncertain: status.order_state !== "payment_confirmed",
      safe_to_retry: true,
    });
  }

  private refusalFor(submission: OrderSubmission) {
    if (submission.state === "cancelled")
      return "Chowdeck's order record showed this order cancelled";
    if (submission.cancelRequestedAt)
      return "a cancellation was sent for this order, so ChowBot does not start a payment for it";
    if (submission.lockReleasedAt)
      return "this attempt was marked abandoned, so ChowBot no longer starts payments for it. Pay in the Chowdeck app if you still want the order";
    if (submission.state !== "created" || !submission.chowdeckOrderId)
      return "only an order ChowBot created and recorded can be paid here";
    if (submission.paymentStartedAt)
      return PAYMENT_START_GUIDANCE[
        submission.paymentStartState ?? "in_flight"
      ];
    if (!isSupportedChannel(submission.paymentChannelName))
      return "this order's payment channel is not supported here";
    return undefined;
  }

  private async sendPaymentStartOnce(
    submission: OrderSubmission,
    orderId: number,
    headers: Record<string, string>,
    confirmedTotal: number,
    before: OrderClassification,
    pocketTag?: string,
  ) {
    const channel = submission.paymentChannelName as SupportedPaymentChannel;
    let response: unknown;
    try {
      response = await this.client.request(PAYMENT_START_PATH, {
        method: "POST",
        headers,
        body: {
          method: channel,
          order_id: orderId,
          ...paymentRedirects(this.config, orderId, channel),
          ...(pocketTag && { pocket_tag: pocketTag }),
        },
      });
    } catch (error) {
      if (isDefiniteRejection(error)) {
        await this.persist(() =>
          this.submissions.recordPaymentStart(submission.id, "rejected"),
        );
        return reportResult(
          {
            action: "start_payment",
            outcome: "rejected_by_chowdeck",
            message: `Payment not started: Chowdeck refused to start the payment (status ${error.status}). ChowBot will not try again; pay in the Chowdeck app.`,
            chowdeck_confirmed: [`Chowdeck refused the payment start (status ${error.status})`],
            status: null,
            next_step: "Tell the user to pay in the Chowdeck app. ChowBot will not start another payment for this order.",
            outcome_uncertain: false,
            safe_to_retry: false,
          },
          true,
        );
      }
      return this.unknownOutcome(submission, describeError(error));
    }

    const data =
      isRecord(response) &&
      response.status === "success" &&
      isRecord(response.data)
        ? response.data
        : undefined;
    const link = data?.authorization_url;
    if (!isPaymentLink(link)) {
      return this.unknownOutcome(
        submission,
        `POST ${PAYMENT_START_PATH} returned an unexpected response`,
      );
    }

    await this.persist(() =>
      this.submissions.recordPaymentStart(submission.id, "started"),
    );

    /*
     * OPay's and Pocket's starts report the amount they will charge
     * (amountInLowerUnits, observed 2026-10-22); Paystack's do not. It is
     * compared with the confirmed total; the link is still returned, as it
     * cannot be recovered later.
     */
    const charged = data?.amountInLowerUnits;
    const chargedKnown = typeof charged === "number" && Number.isFinite(charged);
    const mismatch = chargedKnown && charged !== confirmedTotal;
    /*
     * Pocket answers display_type "inapp": the payment request goes to the
     * payer's Pocket app, and the link is Chowdeck's own verify page.
     */
    const inApp = data?.display_type === "inapp";
    return reportResult({
      action: "start_payment",
      outcome: "payment_link_generated",
      message: inApp
        ? `Chowdeck sent a payment request for order ${orderId} to the Pocket tag ${pocketTag}. Open the Pocket app to approve it. Payment page: ${link}`
        : `Open this link to pay for Chowdeck order ${orderId} with ${channel}: ${link}`,
      chowdeck_confirmed: [
        "Chowdeck started the payment and returned a payment link",
        ...(chargedKnown ? [`the payment processor reports ${formatNaira(charged)} to pay`] : []),
      ],
      status: {
        ...stateFromChowdeck(orderId, before, { paymentStartedAt: new Date(), paymentStartState: "started" }),
        source: "Chowdeck's order record, read just before this payment start, and the payment start's response",
      },
      amount: {
        confirmed_total: formatNaira(confirmedTotal),
        ...(chargedKnown && { payment_page_amount: formatNaira(charged) }),
      },
      order_id: orderId,
      payment_link: link,
      ...(mismatch && {
        warning: `The payment page amount (${formatNaira(charged)}) differs from the total the user confirmed (${formatNaira(confirmedTotal)}). Tell the user before they pay.`,
      }),
      next_step: `${
        inApp
          ? "Tell the user to open their Pocket app and approve the payment request."
          : "Give the user this link as a clickable link to open and pay in their browser."
      } ChowBot will not start another payment for this order. After they pay, check the order with get_order_submission: payment is confirmed only from Chowdeck's order record, never from this link.`,
      outcome_uncertain: false,
      safe_to_retry: false,
    });
  }

  private async unknownOutcome(submission: OrderSubmission, detail: string) {
    await this.persist(() =>
      this.submissions.recordPaymentStart(submission.id, "unknown"),
    );
    return reportResult(
      {
        action: "start_payment",
        outcome: "unknown_outcome",
        message: `The payment start's outcome is unknown (${detail}). A payment may or may not have been started. ChowBot will not try again. Check the Chowdeck app before paying, so you do not pay twice.`,
        chowdeck_confirmed: [],
        status: null,
        next_step: "Do not call start_payment again. Check the order in the Chowdeck app or with get_order_submission before paying.",
        outcome_uncertain: true,
        safe_to_retry: false,
      },
      true,
    );
  }

  /*
   * R2: retries only a local database write. Returns false when every
   * attempt failed; the marker then stays without an outcome, which blocks
   * any further payment start.
   */
  private async persist(write: () => Promise<boolean>) {
    for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt++) {
      try {
        return await write();
      } catch (error) {
        logFailure("Saving a payment-start outcome failed:", error);
        const delay = PERSIST_BACKOFF_MS[attempt];
        if (delay !== undefined) await Bun.sleep(delay);
      }
    }
    return false;
  }
}

export default PaymentStartService;
