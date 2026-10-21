import {
  inputRequired,
  type ServerContext,
  type CallToolResult,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";

import type {
  OrderSubmission,
  PaymentStartState,
  UserOrderSubmissions,
} from "../../lib/order-submissions";
import { logger } from "../../utils/logger";
import { isRecord } from "../../utils/object";
import { NotSignedInError } from "../addresses/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import OrderService, { readPaymentEvidence } from "../orders/service";
import { SUPPORTED_PAYMENT_CHANNELS } from "../order-placement/channels";
import { chowdeckAuthHeaders, type UserSession } from "../../lib/session";

export const PAYMENT_START_PATH = "/customer/payment/start/v2";

/*
 * The redirect URLs the Chowdeck website sends with an OPay payment start
 * (storefront chunk 3488, read 2026-10-21):
 *   return_url: `${origin}/store/ongoing-order?orderId=${order id}`
 *   cancel_url: `${origin}${pathname}${search}?status=failed`, i.e. the
 *               checkout page, /store/checkout?status=failed
 * ChowBot sends the same pages on the website's origin, so after paying the
 * user lands on Chowdeck's own order page. start_payment stays registered
 * only where a configuration is supplied (none in production): whether
 * Chowdeck returns an unpaid order by id, which its pre-payment check needs,
 * has not been observed.
 */
export type PaymentStartConfig = {
  origin: string;
};

export const CHOWDECK_WEBSITE_ORIGIN = "https://chowdeck.com";

export const paymentRedirects = (config: PaymentStartConfig, orderId: number) => ({
  return_url: `${config.origin}/store/ongoing-order?orderId=${orderId}`,
  cancel_url: `${config.origin}/store/checkout?status=failed`,
});

const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

export const createPaymentStartConfig = (origin: string = CHOWDECK_WEBSITE_ORIGIN): PaymentStartConfig => {
  if (!isHttpsUrl(origin) || new URL(origin).origin !== origin) {
    throw new Error("The payment-start origin must be an https origin such as https://chowdeck.com");
  }
  return { origin };
};

type PaymentState = { v: 1; purpose: "start_payment"; submissionId: string };

export type StartPaymentArgs = { quote_ref: string };

/*
 * R2: only the local database write is retried, never the payment start.
 */
const PERSIST_ATTEMPTS = 3;
const PERSIST_BACKOFF_MS = [100, 400];

const text = (message: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: message }],
  ...(isError && { isError }),
});

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
 * created, unpaid order it checks that the client can show a URL, confirms
 * with Chowdeck that the order is unpaid, commits the payment-start marker,
 * and only then sends the request, exactly once. The payment link is handed
 * to the client only through a URL-mode elicitation: it never appears in a
 * tool result, the database or the logs.
 */
class PaymentStartService {
  private readonly orders: OrderService;

  constructor(
    private readonly session: UserSession,
    private readonly submissions: UserOrderSubmissions,
    private readonly requestStateCodec: RequestStateCodec,
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
   * The SDK refuses a URL elicitation for a client without the url
   * capability only after the handler returns, so this check must come
   * before anything is started upstream.
   */
  private canShowUrl(ctx: ServerContext) {
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const caps = envelope?.["io.modelcontextprotocol/clientCapabilities"] as
      { elicitation?: { url?: unknown } } | undefined;
    return Boolean(envelope && caps?.elicitation?.url);
  }

  async startPayment(args: StartPaymentArgs, ctx: ServerContext) {
    if (!this.canShowUrl(ctx)) {
      return text(
        "Payment not started: this client cannot open ChowBot's payment link. Pay for the order in the Chowdeck app.",
        true,
      );
    }
    const state = ctx.mcpReq.requestState<PaymentState>();
    if (state !== undefined) return this.afterLink(args, ctx, state);

    await this.authHeaders();
    const submission = await this.submissions.get(args.quote_ref);
    if (!submission)
      return text(
        "Payment not started: that quote_ref does not exist for your account.",
        true,
      );
    const refusal = this.refusalFor(submission);
    if (refusal) return text(`Payment not started: ${refusal}.`, true);
    const orderId = submission.chowdeckOrderId!;

    try {
      const { paid, evidence } = await readPaymentEvidence(
        this.orders,
        orderId,
      );
      if (paid) {
        await this.persist(() =>
          this.submissions.recordPaid(submission.id, evidence),
        );
        return text(
          "Payment not started: Chowdeck shows this order is already paid.",
        );
      }
    } catch (error) {
      return text(
        `Payment not started: ChowBot could not confirm with Chowdeck that order ${orderId} is unpaid (${describeError(error)}). Nothing was started.`,
        true,
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
      return text(
        "Payment not started: ChowBot could not confirm it was safe to start the payment, so nothing was sent. Pay in the Chowdeck app.",
        true,
      );
    }
    if (!marked) {
      return text(
        "Payment not started: this order changed or a payment was started for it in the meantime. Nothing was sent.",
        true,
      );
    }

    return this.sendPaymentStartOnce(submission, orderId, headers, ctx);
  }

  private refusalFor(submission: OrderSubmission) {
    if (submission.state === "paid") return "this order is already paid";
    if (submission.lockReleasedAt)
      return "this attempt was marked abandoned, so ChowBot no longer starts payments for it. Pay in the Chowdeck app if you still want the order";
    if (submission.state !== "created" || !submission.chowdeckOrderId)
      return "only an order ChowBot created and recorded can be paid here";
    if (submission.paymentStartedAt)
      return PAYMENT_START_GUIDANCE[
        submission.paymentStartState ?? "in_flight"
      ];
    if (
      !SUPPORTED_PAYMENT_CHANNELS.includes(
        submission.paymentChannelName as (typeof SUPPORTED_PAYMENT_CHANNELS)[number],
      )
    )
      return "this order's payment channel is not supported here";
    return undefined;
  }

  private async sendPaymentStartOnce(
    submission: OrderSubmission,
    orderId: number,
    headers: Record<string, string>,
    ctx: ServerContext,
  ) {
    let response: unknown;
    try {
      response = await this.client.request(PAYMENT_START_PATH, {
        method: "POST",
        headers,
        body: {
          method: submission.paymentChannelName,
          order_id: orderId,
          ...paymentRedirects(this.config, orderId),
        },
      });
    } catch (error) {
      if (isDefiniteRejection(error)) {
        await this.persist(() =>
          this.submissions.recordPaymentStart(submission.id, "rejected"),
        );
        return text(
          `Payment not started: Chowdeck refused to start the payment (status ${error.status}). ChowBot will not try again; pay in the Chowdeck app.`,
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
    if (!isHttpsUrl(link)) {
      return this.unknownOutcome(
        submission,
        `POST ${PAYMENT_START_PATH} returned an unexpected response`,
      );
    }

    await this.persist(() =>
      this.submissions.recordPaymentStart(submission.id, "started"),
    );

    return inputRequired({
      inputRequests: {
        pay: inputRequired.elicitUrl({
          message: `Pay ${submission.computedTotal} for Chowdeck order ${orderId} with ${submission.paymentChannelName} in your browser. Payment is confirmed only from Chowdeck's order record.`,
          url: link,
        }),
      },
      requestState: await this.requestStateCodec.mint(
        {
          v: 1,
          purpose: "start_payment",
          submissionId: submission.id,
        } satisfies PaymentState,
        ctx,
      ),
    });
  }

  /*
   * The client's answer to the payment link. Nothing is sent to Chowdeck:
   * the payment already started, and only Chowdeck's order record shows
   * whether it was paid.
   */
  private afterLink(
    args: StartPaymentArgs,
    ctx: ServerContext,
    state: PaymentState,
  ) {
    if (
      state.purpose !== "start_payment" ||
      state.submissionId !== args.quote_ref
    ) {
      return text(
        "Payment not started: the request changed after the payment link was issued.",
        true,
      );
    }
    const pay = ctx.mcpReq.inputResponses?.pay as
      { action?: unknown } | undefined;
    const opened = pay?.action === "accept";
    return text(
      opened
        ? "The payment page was opened. ChowBot does not know whether payment completed; check with get_order_submission, which reads Chowdeck's order record."
        : "The payment link was not opened. The payment session was started, and ChowBot will not start another; pay in the Chowdeck app.",
    );
  }

  private async unknownOutcome(submission: OrderSubmission, detail: string) {
    await this.persist(() =>
      this.submissions.recordPaymentStart(submission.id, "unknown"),
    );
    return text(
      `The payment start's outcome is unknown (${detail}). A payment may or may not have been started. ChowBot will not try again. Check the Chowdeck app before paying, so you do not pay twice.`,
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
