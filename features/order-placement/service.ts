import { z } from "zod";
import {
  inputRequired,
  acceptedContent,
  type ServerContext,
  type CallToolResult,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";
import { randomBytes } from "node:crypto";

import {
  resolvePaymentChannel,
  type PaymentChannelQuery,
  type SupportedPaymentChannel,
} from "./channels";
import {
  RELEASED_WARNING_DAYS,
  type ClaimRefusal,
  type OrderSubmission,
  type ReleasedSubmission,
  type UserOrderSubmissions,
} from "../../lib/order-submissions";
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
import { logger } from "../../utils/logger";
import OrderService, { readOrderState, trackingLinkOf, type OrderDetail } from "../orders/service";
import { isRecord } from "../../utils/object";
import CheckoutService, { CheckoutRefusedError } from "../checkout/service";
import {
  formatNaira,
  tipFromNaira,
  validateGiftRecipient,
  type GiftRecipient,
  type GiftRecipientInput,
} from "../checkout/draft";
import { cartFingerprint } from "../carts/service";
import { REQUEST_STATE_TTL_SECONDS } from "../../lib/request-state";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import AddressService, { NotSignedInError } from "../addresses/service";
import { chowdeckAuthHeaders, type UserSession } from "../../lib/session";

const ORDER_PATH = "/customer/order";
const CHECKOUT_CURRENCY = "NGN";
const CHECKOUT_COUNTRY_CODE = "NG";

/*
 * Reported by the user from the website on 2026-10-22; its body, eligibility
 * rules and responses have not been observed.
 */
export const cancelOrderPath = (orderId: number) => `/customer/order/${orderId}/cancel`;

/*
 * R3: an order created before the claim cannot belong to this attempt;
 * allow a little clock difference between ChowBot and Chowdeck.
 */
const LINK_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

/*
 * R2: only the local database write is retried, never the order request.
 */
const PERSIST_ATTEMPTS = 3;
const PERSIST_BACKOFF_MS = [100, 400];

const UNRESOLVED_STATES = new Set(["submitting", "unknown", "created"]);

type PlacementState = {
  v: 1;
  submissionId: string;
  nonce: string;
  addressId: number;
  channel: SupportedPaymentChannel;
  acknowledgementRequired: boolean;
  /*
   * The cart notes the user saw in the confirmation; the order copies the
   * notes from the cart at submission, so they must still match.
   */
  notesDigest?: string;
  /*
   * The tip, gift and promo code the user confirmed, bound the same way.
   */
  extrasDigest?: string;
};

/*
 * A cancellation the user was asked to confirm, for one order.
 */
type CancelState = {
  v: 1;
  kind: "cancel_order";
  submissionId: string;
  orderId: number;
};

/*
 * Checkout extras the order carries, as validated for submission. The promo
 * code is the one applied in the quote, never an argument.
 */
type OrderExtras = { tipRaw?: number; gift?: GiftRecipient; promoCode?: string };

const extrasDigestOf = (extras: OrderExtras) =>
  sha256(JSON.stringify([extras.tipRaw ?? null, extras.gift ?? null, extras.promoCode ?? null]));

const notesDigestOf = (raw: Record<string, unknown>) =>
  sha256(JSON.stringify([raw.customer_vendor_note ?? null, raw.customer_delivery_note ?? null]));

export type PlaceOrderArgs = {
  quote_ref: string;
  address_id: number;
  payment_channel: SupportedPaymentChannel;
  tip?: "none" | { amount_naira: number };
  gift?: GiftRecipientInput;
  /*
   * Accepted only when it is the code the quote applied: a promo code is
   * applied in get_checkout_quote, never at placement.
   */
  promo_code?: string;
  /*
   * Two-step confirmation, for clients that cannot show a confirmation
   * prompt: the code returned by the first call, sent back only after the
   * user explicitly agrees to the summary it came with.
   */
  confirmation?: string;
  acknowledge_unresolved_attempts?: boolean;
};

export type CancelOrderArgs = { quote_ref: string; confirmation?: string };

type ConfirmationAnswer = { confirm: boolean; acknowledge_unresolved_attempts?: boolean };

/*
 * Validates the extras from the arguments and the quote alone (no Chowdeck
 * calls). Used at submission, where the live checks were already made at
 * confirmation and the result is bound by extrasDigest.
 */
const extrasFromArgs = (args: PlaceOrderArgs, submission: OrderSubmission): OrderExtras => {
  const extras: OrderExtras = {};
  if (typeof args.tip === "object") {
    const tip = tipFromNaira(args.tip.amount_naira, { available: true, minimum: 0, maximum: 0 });
    if (!tip.ok) throw new CheckoutRefusedError(`the tip ${tip.error}`);
    if (tip.value.kind === "amount") extras.tipRaw = tip.value.raw;
  }
  if (args.gift !== undefined) {
    const gift = validateGiftRecipient(args.gift);
    if (!gift.ok) throw new CheckoutRefusedError(`the gift recipient's ${gift.error}`);
    extras.gift = gift.value;
  }
  if (
    args.promo_code !== undefined &&
    args.promo_code.trim().toUpperCase() !== (submission.promoCode ?? "").toUpperCase()
  ) {
    throw new CheckoutRefusedError(
      submission.promoCode
        ? `this quote applied the promo code ${submission.promoCode}, not ${args.promo_code.trim()}; call get_checkout_quote with the code you want`
        : `a promo code is applied in the quote, not here; call get_checkout_quote with promo_code ${args.promo_code.trim()} so Chowdeck can calculate its discount`,
    );
  }
  if (submission.promoCode) extras.promoCode = submission.promoCode;
  return extras;
};

/*
 * The total the user confirms: ChowBot's quote total, plus the tip, minus
 * the discount Chowdeck's calculation returned in the quote.
 */
const confirmedEstimate = (submission: OrderSubmission, extras: OrderExtras) =>
  submission.computedTotal + (extras.tipRaw ?? 0) - (submission.promoDiscount ?? 0);

const answerSchema = z.object({
  confirm: z.boolean(),
  acknowledge_unresolved_attempts: z.boolean().optional(),
});

const sha256 = (value: string) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const isPositiveId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const isDefiniteRejection = (error: unknown): error is ChowdeckApiError =>
  error instanceof ChowdeckApiError &&
  error.kind === "http" &&
  error.status !== undefined &&
  error.status < 500;

/*
 * For the order request only, a 401 is not a definite rejection: the
 * website treats it as an expired token and re-sends the same order, so it
 * cannot be taken as proof that no order was created. The same caution
 * applies to the cancellation request.
 */
const isDefiniteOrderRejection = (error: unknown): error is ChowdeckApiError =>
  isDefiniteRejection(error) && error.status !== 401;

const describeError = (error: unknown) =>
  error instanceof ChowdeckApiError ? error.message : "unexpected error";

const logFailure = (what: string, error: unknown) =>
  logger.error(what, error instanceof Error ? error.name : typeof error);

const NEW_QUOTE = "Call get_checkout_quote again and confirm the new total.";

const PAID_ORDER_OPTIONS =
  "Chowdeck's order record shows this order is paid. ChowBot cannot cancel, change or refund a paid order, and editing or clearing the cart does not change it. Follow it with track_order, and use the Chowdeck app (order page and support) for any change; whether Chowdeck lets a customer cancel a paid order has not been verified.";

const CLAIM_REFUSALS: Record<ClaimRefusal, string> = {
  not_found: "that quote_ref does not exist for your account",
  not_confirmable:
    "this confirmation was already used or the quote is no longer awaiting confirmation; call get_checkout_quote again",
  confirmation_invalid:
    "this confirmation is no longer valid; call get_checkout_quote again",
  expired:
    "the quote or its confirmation expired; call get_checkout_quote again and confirm the new total",
  address_changed:
    "the delivery address differs from the one quoted; call get_checkout_quote again",
  cart_changed:
    "the cart changed since the quote; call get_checkout_quote again",
  cart_locked:
    "an earlier order attempt from this cart is unpaid, paid on an unchanged cart, or has an unknown outcome; check it with get_order_submission",
};

const placeRefused = (message: string, nextStep: string, status: OrderStatusReport | null = null) =>
  notSentReport("place_order", message, nextStep, status);

const cancelRefused = (message: string, nextStep: string, status: OrderStatusReport | null = null) =>
  notSentReport("cancel_order", message, nextStep, status);

/*
 * The only code path that sends POST /customer/order, and the only one that
 * sends a cancellation. A confirmed attempt is claimed atomically, gated by
 * one fresh delivery-fee quote, marked as started (committed), and only then
 * sent, exactly once. Nothing here retries or replays an order or
 * cancellation request.
 */
class OrderPlacementService {
  private readonly orders: OrderService;
  private readonly checkout: CheckoutService;
  private readonly addresses: AddressService;

  constructor(
    private readonly session: UserSession,
    private readonly submissions: UserOrderSubmissions,
    private readonly client = new ChowdeckClient(),
    private readonly requestStateCodec?: RequestStateCodec,
    private readonly channelQuery?: PaymentChannelQuery,
  ) {
    this.checkout = new CheckoutService(session, client);
    this.addresses = new AddressService(session, client);
    this.orders = new OrderService(session, client);
  }

  private async authHeaders() {
    const headers = await chowdeckAuthHeaders(this.session);
    if (!headers.authorization) throw new NotSignedInError();
    return headers;
  }

  /*
   * Other attempts at the restaurant that could already have produced an
   * order: those still locking a cart while unpaid or unknown, and those an
   * operator released in the last RELEASED_WARNING_DAYS.
   */
  private async unresolvedAttempts(vendorId: number, excludeId: string) {
    const open = (await this.submissions.listOpen(vendorId)).filter(
      (attempt) =>
        attempt.id !== excludeId && UNRESOLVED_STATES.has(attempt.state),
    );
    const released = (
      await this.submissions.listRecentlyReleased(vendorId)
    ).filter((attempt) => attempt.id !== excludeId);
    return { open, released, total: open.length + released.length };
  }

  /*
   * Re-reads the user's cart, address and restaurant exactly as a quote
   * would, and refuses if the cart is no longer the one quoted.
   */
  private async revalidate(submission: OrderSubmission, addressId: number) {
    const checked = await this.checkout.validateForOrder(
      submission.vendorId,
      addressId,
    );
    if (cartFingerprint(checked.cart) !== submission.cartFingerprint)
      return undefined;
    return checked;
  }

  /*
   * One fresh read of an order's record. A failure is returned, never
   * thrown, so callers can report it as an unknown state.
   */
  private async freshState(orderId: number): Promise<
    | { ok: true; order: OrderDetail; classification: OrderClassification }
    | { ok: false; error: string }
  > {
    try {
      return { ok: true, ...(await readOrderState(this.orders, orderId)) };
    } catch (error) {
      if (error instanceof NotSignedInError) throw error;
      return { ok: false, error: describeError(error) };
    }
  }

  /*
   * Use an explicit two-call confirmation for every client. A capability
   * declaration alone cannot establish that the host can render an
   * elicitation UI; returning one can fail before the summary reaches the
   * user. The signed state is user- and method-bound and expires after five
   * minutes. Submission still follows the same nonce, claim, digest, lock,
   * and one-send checks.
   */
  async placeOrder(args: PlaceOrderArgs, ctx: ServerContext) {
    await this.authHeaders();
    if (args.confirmation === undefined) return this.askForConfirmation(args, ctx, "code");
    if (!this.requestStateCodec) {
      return placeRefused("Order not placed: order placement is not available on this server.", "Order in the Chowdeck app.");
    }
    let state: PlacementState;
    try {
      state = (await this.requestStateCodec.verify(args.confirmation, ctx)) as PlacementState;
    } catch {
      return placeRefused(
        "Order not placed: the confirmation code is invalid, expired or not yours.",
        "Call place_order again without confirmation to get a new summary, and show it to the user.",
      );
    }
    return this.submit(args, ctx, state, {
      confirm: true,
      ...(args.acknowledge_unresolved_attempts !== undefined && {
        acknowledge_unresolved_attempts: args.acknowledge_unresolved_attempts,
      }),
    });
  }

  private async askForConfirmation(args: PlaceOrderArgs, ctx: ServerContext, mode: "prompt" | "code") {
    if (!this.requestStateCodec || !this.channelQuery) {
      return placeRefused("Order not placed: order placement is not available on this server.", "Order in the Chowdeck app.");
    }
    const submission = await this.submissions.get(args.quote_ref);
    if (!submission)
      return placeRefused("Order not placed: that quote_ref does not exist for your account.", "Use a quote_ref from get_checkout_quote.");
    if (submission.state === "failed" && submission.failureReason === "superseded") {
      return placeRefused(
        "Order not placed: this quote was replaced by a newer quote for the same cart, so its total can no longer be confirmed.",
        "Use the quote_ref of the newest get_checkout_quote result.",
      );
    }
    if (
      submission.state !== "quoted" &&
      submission.state !== "confirmation_pending"
    ) {
      return placeRefused("Order not placed: this quote was already used.", NEW_QUOTE);
    }
    if (submission.quoteExpiresAt.getTime() <= Date.now()) {
      return placeRefused("Order not placed: the quote expired.", NEW_QUOTE);
    }

    const checked = await this.revalidate(submission, args.address_id);
    if (!checked)
      return placeRefused("Order not placed: the cart changed since the quote.", NEW_QUOTE);

    const channel = await resolvePaymentChannel(
      this.client,
      await this.authHeaders(),
      this.channelQuery,
      args.payment_channel,
    );
    if (!channel) {
      return placeRefused(
        `Order not placed: the ${args.payment_channel} payment channel is not available right now.`,
        "Try again later, or order in the Chowdeck app.",
      );
    }

    /*
     * The live checks for the extras: Chowdeck's tip limits and the gift
     * phone check. The promo code and its discount come from the quote.
     */
    let extras: OrderExtras;
    try {
      extras = extrasFromArgs(args, submission);
      if (extras.tipRaw !== undefined && typeof args.tip === "object") {
        const tip = tipFromNaira(args.tip.amount_naira, await this.checkout.readTipConfig());
        if (!tip.ok) throw new CheckoutRefusedError(`the tip ${tip.error}`);
      }
      if (extras.gift) await this.checkout.validateGiftPhone(extras.gift);
    } catch (error) {
      if (error instanceof CheckoutRefusedError || error instanceof ChowdeckApiError) {
        return placeRefused(`Order not placed: ${error.message}.`, "Correct the tip or gift details and call place_order again without confirmation.");
      }
      throw error;
    }

    const unresolved = await this.unresolvedAttempts(
      submission.vendorId,
      submission.id,
    );
    const nonce = randomBytes(32).toString("base64url");
    const issued = await this.submissions.issueConfirmation(submission.id, {
      paymentMethodId: channel.id,
      paymentChannelName: channel.name,
      nonceHash: sha256(nonce),
      ttlSeconds: REQUEST_STATE_TTL_SECONDS,
    });
    if (!issued) {
      return placeRefused("Order not placed: the quote is no longer valid.", NEW_QUOTE);
    }

    const { addresses } = await this.addresses.list();
    const address = addresses.find((entry) => entry.id === args.address_id);
    const addressLabel =
      typeof address?.pretty_name === "string"
        ? address.pretty_name
        : "your selected saved address";
    const restaurantFields = checked.restaurant as Record<string, unknown>;
    const restaurantName =
      typeof restaurantFields.name === "string"
        ? restaurantFields.name
        : `restaurant ${submission.vendorId}`;
    const items = checked.cart.packs
      .flatMap((pack) => pack.rows.filter((row) => row.type === "menu"))
      .map((row) => `${row.quantity ?? 1} × ${row.name ?? "item"}`)
      .join(", ");
    const estimate = confirmedEstimate(submission, extras);

    const message = [
      `Place this order at ${restaurantName}?`,
      `Items: ${items}.`,
      `Deliver to: ${addressLabel}.`,
      `Total: ${submission.computedTotal} (raw Chowdeck amount: cart total plus delivery and service fees, computed by ChowBot).`,
      `Payment: ${channel.name}. The order is created unpaid; payment is completed separately, after Chowdeck's own order total is shown.`,
      extras.tipRaw !== undefined
        ? `Tip: ${formatNaira(extras.tipRaw)} for the rider.`
        : "Tip: none (ChowBot does not add a tip).",
      `Restaurant note: ${quotedNote(checked.raw.customer_vendor_note)}.`,
      `Delivery note: ${quotedNote(checked.raw.customer_delivery_note)}.`,
      "(These are the notes saved on the cart; to change one, use set_cart_notes and then ask for a new summary.)",
      extras.gift
        ? `Gift for ${extras.gift.name} (phone ${extras.gift.phone}, ${extras.gift.country_code}) from ${extras.gift.donor_name}${extras.gift.message ? `, message "${extras.gift.message}"` : ""}${extras.gift.save_as_beneficiary ? ", saved as a beneficiary on your account" : ""}.`
        : "Not a gift.",
      extras.promoCode
        ? `Promo code ${extras.promoCode}: Chowdeck's discount calculation in the quote returned ${formatNaira(submission.promoDiscount ?? 0)} off.`
        : "No promo code.",
      ...(extras.tipRaw !== undefined || extras.promoCode
        ? [
            `Estimated total: ${formatNaira(estimate)} (the total above${extras.tipRaw !== undefined ? " plus the tip" : ""}${extras.promoCode ? " minus Chowdeck's calculated discount" : ""}; computed by ChowBot, not yet confirmed by Chowdeck's order record).`,
          ]
        : []),
      ...(unresolved.open.length > 0
        ? [
            `Warning: you have ${unresolved.open.length} earlier order attempt(s) at this restaurant that are unpaid or have an unknown outcome. Placing this order may result in more than one order. Confirm acknowledge_unresolved_attempts to continue.`,
          ]
        : []),
      ...(unresolved.released.length > 0
        ? [
            `Warning: ${unresolved.released.length} earlier order attempt(s) at this restaurant were marked abandoned by ChowBot support in the last ${RELEASED_WARNING_DAYS} days. Abandoned is not cancelled: ChowBot did not cancel anything on Chowdeck, and an order from them may still exist and may still be payable. Placing this order may result in more than one order. Confirm acknowledge_unresolved_attempts to continue.`,
          ]
        : []),
    ].join(" ");

    const requestedSchema =
      unresolved.total > 0
        ? z.object({
            confirm: z.boolean(),
            acknowledge_unresolved_attempts: z.boolean(),
          })
        : z.object({ confirm: z.boolean() });

    const requestState = await this.requestStateCodec.mint(
      {
        v: 1,
        submissionId: submission.id,
        nonce,
        addressId: args.address_id,
        channel: args.payment_channel,
        acknowledgementRequired: unresolved.total > 0,
        notesDigest: notesDigestOf(checked.raw),
        extrasDigest: extrasDigestOf(extras),
      } satisfies PlacementState,
      ctx,
    );
    if (mode === "code") {
      return reportResult({
        action: "place_order",
        outcome: "confirmation_required",
        message: "Nothing was ordered yet. The user must confirm the summary first.",
        chowdeck_confirmed: [
          "the cart, saved address and restaurant were re-checked with Chowdeck",
          `the ${channel.name} payment channel is active on Chowdeck`,
          ...(extras.promoCode ? [`Chowdeck's discount calculation in the quote returned ${formatNaira(submission.promoDiscount ?? 0)} off for ${extras.promoCode}`] : []),
        ],
        status: null,
        amount: {
          quoted_total: formatNaira(submission.computedTotal),
          ...(extras.promoCode && { promo_code: extras.promoCode, chowdeck_calculated_discount: formatNaira(submission.promoDiscount ?? 0) }),
          ...(extras.tipRaw !== undefined && { tip: formatNaira(extras.tipRaw) }),
          estimated_total: formatNaira(estimate),
          source: "computed by ChowBot from Chowdeck's quote and discount calculation; Chowdeck's order record gives the amount to pay",
        },
        order_placed: false,
        summary: message,
        confirmation: requestState,
        expires_in_seconds: REQUEST_STATE_TTL_SECONDS,
        ...(unresolved.total > 0 && { requires_acknowledge_unresolved_attempts: true }),
        next_step:
          "Nothing was ordered. Show the user this summary in full and ask whether to place the order. Only if they explicitly say yes, call place_order again with exactly the same arguments plus confirmation set to this value" +
          (unresolved.total > 0 ? " and acknowledge_unresolved_attempts: true (only if they also accept the warning about earlier attempts)" : "") +
          ". Never call it again without their yes, and never after an unknown outcome.",
        outcome_uncertain: false,
        safe_to_retry: true,
      });
    }
    return inputRequired({
      inputRequests: {
        confirm: inputRequired.elicit({ message, requestedSchema }),
      },
      requestState,
    });
  }

  private async submit(
    args: PlaceOrderArgs,
    ctx: ServerContext,
    state: PlacementState,
    given?: ConfirmationAnswer,
  ) {
    if (
      state.submissionId !== args.quote_ref ||
      state.addressId !== args.address_id ||
      state.channel !== args.payment_channel
    ) {
      return placeRefused("Order not placed: the order details changed after confirmation was requested.", "Start again with place_order without confirmation.");
    }
    const answer =
      given ??
      acceptedContent(ctx.mcpReq.inputResponses, "confirm", answerSchema);
    if (answer?.confirm !== true)
      return placeRefused("Order not placed: it was not confirmed.", "Nothing to do unless the user wants to order.");
    if (
      state.acknowledgementRequired &&
      answer.acknowledge_unresolved_attempts !== true
    ) {
      return placeRefused(
        "Order not placed: the earlier unresolved order attempts were not acknowledged.",
        "Check them with get_order_submission, or confirm again with acknowledge_unresolved_attempts: true if the user accepts the duplicate risk.",
      );
    }

    const submission = await this.submissions.get(args.quote_ref);
    if (!submission)
      return placeRefused("Order not placed: that quote_ref does not exist for your account.", "Use a quote_ref from get_checkout_quote.");
    const checked = await this.revalidate(submission, args.address_id);
    if (!checked)
      return placeRefused("Order not placed: the cart changed since the quote.", NEW_QUOTE);
    let extras: OrderExtras;
    try {
      extras = extrasFromArgs(args, submission);
    } catch (error) {
      if (error instanceof CheckoutRefusedError) return placeRefused(`Order not placed: ${error.message}.`, "Start again with place_order without confirmation.");
      throw error;
    }
    if (state.extrasDigest !== extrasDigestOf(extras)) {
      return placeRefused("Order not placed: the tip, gift or promo code differs from what was confirmed.", "Start again with place_order without confirmation.");
    }
    if (state.notesDigest !== notesDigestOf(checked.raw)) {
      return placeRefused(
        "Order not placed: the cart's restaurant or delivery note changed after confirmation was requested.",
        "Start again with place_order without confirmation to confirm the current notes.",
      );
    }
    if (
      !state.acknowledgementRequired &&
      (await this.unresolvedAttempts(submission.vendorId, submission.id))
        .total > 0
    ) {
      return placeRefused(
        "Order not placed: another order attempt at this restaurant became unresolved after confirmation.",
        "Start again with place_order without confirmation.",
      );
    }

    await this.submissions.recoverUnsent(submission.cartId);
    const claim = await this.submissions.claim(submission.id, {
      nonceHash: sha256(state.nonce),
      addressId: args.address_id,
      cartFingerprint: submission.cartFingerprint,
    });
    if (!claim.ok)
      return placeRefused(`Order not placed: ${CLAIM_REFUSALS[claim.reason]}.`, claim.reason === "cart_locked" ? "Check the earlier attempt with get_order_submission." : NEW_QUOTE);

    try {
      await this.checkout.requestGateQuote(
        submission.vendorId,
        args.address_id,
        checked.cart.id,
        checked.vendor.sourceId,
      );
    } catch (error) {
      const definite = isDefiniteRejection(error);
      try {
        await this.submissions.recordGateFailure(
          submission.id,
          definite ? "gate_rejected" : "gate_uncertain",
        );
      } catch (recordError) {
        logFailure("Recording a gate failure failed:", recordError);
      }
      return placeRefused(
        definite
          ? `Order not placed: Chowdeck rejected the order check: ${describeError(error)}. No order was sent.`
          : `Order not placed: the delivery-fee check could not be confirmed (${describeError(error)}). A fee record may exist on Chowdeck, but no order was sent.`,
        NEW_QUOTE,
      );
    }

    let marked: boolean;
    try {
      marked = await this.submissions.markOrderRequestStarted(submission.id);
    } catch (error) {
      logFailure("Marking an order request as started failed:", error);
      return placeRefused(
        "Order not placed: ChowBot could not confirm it was safe to send the order, so nothing was sent. This attempt stays locked until it can be checked with get_order_submission.",
        "Check the attempt with get_order_submission.",
      );
    }
    if (!marked) {
      return placeRefused("Order not placed: this attempt was recovered or changed before sending. Nothing was sent.", NEW_QUOTE);
    }

    return this.sendOrderOnce(submission, args, checked, claim.feeId, extras);
  }

  private async sendOrderOnce(
    submission: OrderSubmission,
    args: PlaceOrderArgs,
    checked: Awaited<ReturnType<CheckoutService["validateForOrder"]>>,
    feeId: number,
    extras: OrderExtras,
  ) {
    const raw = checked.raw;
    const body = {
      source: "web",
      vendor_id: submission.vendorId,
      cart_id: submission.cartId,
      checkout_from_cart: true,
      class:
        checked.vendor.fields.self_delivery === true
          ? "vendor_delivery"
          : "delivery",
      fee_id: feeId,
      address_id: args.address_id,
      payment_method_id: submission.paymentMethodId,
      split_payment_with_wallet: false,
      requires_delivery_pin: true,
      bag_quantity: raw.bag_quantity,
      promo_codes: extras.promoCode ? [extras.promoCode] : [],
      currency: CHECKOUT_CURRENCY,
      country_code: CHECKOUT_COUNTRY_CODE,
      customer_vendor_note: raw.customer_vendor_note ?? null,
      customer_delivery_note: raw.customer_delivery_note ?? null,
      gift_recipient: extras.gift ?? null,
      // As the website: tip only when one was chosen, in raw x100 units.
      ...(extras.tipRaw !== undefined && { tip: extras.tipRaw }),
    };

    let response: unknown;
    try {
      response = await this.client.request(ORDER_PATH, {
        method: "POST",
        headers: await this.authHeaders(),
        body,
      });
    } catch (error) {
      if (isDefiniteOrderRejection(error)) {
        await this.persist(() =>
          this.submissions.recordOutcome(submission.id, { kind: "rejected" }),
        );
        return reportResult(
          {
            action: "place_order",
            outcome: "rejected_by_chowdeck",
            message: `Order not placed: Chowdeck rejected the order: ${error.message}. No order was created.`,
            chowdeck_confirmed: [`Chowdeck refused the order request (status ${error.status})`],
            status: null,
            next_step: "Tell the user why Chowdeck refused it. They may fix the problem and start again from get_checkout_quote.",
            outcome_uncertain: false,
            safe_to_retry: true,
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
    if (!data || !isPositiveId(data.id)) {
      return this.unknownOutcome(
        submission,
        `POST ${ORDER_PATH} returned an unexpected response`,
      );
    }
    const orderId = data.id;

    const saved = await this.persist(() =>
      this.submissions.recordOutcome(submission.id, {
        kind: "created",
        chowdeckOrderId: orderId,
      }),
    );
    return this.createdReport(submission, orderId, data, body, extras, saved);
  }

  /*
   * After creation the order record is read once (read-only), so the result
   * reports Chowdeck's own state, total and notes, not just the create
   * response.
   */
  private async createdReport(
    submission: OrderSubmission,
    orderId: number,
    data: Record<string, unknown>,
    sent: { customer_vendor_note: unknown; customer_delivery_note: unknown },
    extras: OrderExtras,
    saved: boolean,
  ) {
    const estimate = confirmedEstimate(submission, extras);
    const confirmed = [
      `Chowdeck created order ${orderId} (POST ${ORDER_PATH} answered success)`,
      data.made_payment === true
        ? "Chowdeck's create response says made_payment: true; that is not payment evidence, only the order record is"
        : "Chowdeck's create response says the order is not paid (made_payment: false)",
    ];
    const warnings: string[] = [];
    const fresh = await this.freshState(orderId);
    let status: OrderStatusReport;
    let amount: Record<string, unknown> = {
      estimated_total: formatNaira(estimate),
      estimate_source: "computed by ChowBot and confirmed by the user before ordering",
    };
    if (fresh.ok) {
      status = stateFromChowdeck(orderId, fresh.classification);
      const amounts = orderAmounts(fresh.order);
      if (amounts) {
        amount = { ...amounts, ...amount };
        confirmed.push(`Chowdeck's order record shows a total of ${amounts.total}`);
        if (amounts.total_raw !== estimate) {
          warnings.push(
            `Chowdeck's order total (${amounts.total}) differs from the estimate the user confirmed (${formatNaira(estimate)}). Do not pay until the user has seen and accepted Chowdeck's total; start_payment shows it and asks for it.`,
          );
        }
      } else {
        warnings.push("Chowdeck's order record has no numeric total, so the amount to pay is not confirmed yet.");
      }
      for (const [field, label] of [
        ["customer_vendor_note", "restaurant note"],
        ["customer_delivery_note", "delivery note"],
      ] as const) {
        const onOrder = fresh.order[field];
        if (onOrder === undefined) continue;
        const sentNote = typeof sent[field] === "string" ? sent[field] : "";
        const storedNote = typeof onOrder === "string" ? onOrder : "";
        if (storedNote === sentNote) {
          if (storedNote) confirmed.push(`the ${label} on Chowdeck's order record is "${storedNote}"`);
        } else {
          warnings.push(`the ${label} on Chowdeck's order record (${quotedNote(storedNote)}) differs from the cart's (${quotedNote(sentNote)}).`);
        }
      }
      if (extras.promoCode && typeof fresh.order.promo_codes === "string") {
        if (fresh.order.promo_codes.toUpperCase().includes(extras.promoCode.toUpperCase())) {
          confirmed.push(`Chowdeck's order record lists the promo code ${extras.promoCode}`);
        } else {
          warnings.push(`Chowdeck's order record does not list the promo code ${extras.promoCode}, so its discount is not confirmed.`);
        }
      }
    } else {
      status = stateUnavailable(orderId, fresh.error, "created (from Chowdeck's create response)");
      warnings.push("Chowdeck's order record could not be read, so its total is not confirmed yet.");
    }

    const result = {
      action: "place_order",
      outcome: "order_created",
      message: `Chowdeck order ${orderId} was created and is unpaid. Nothing has been paid yet.`,
      chowdeck_confirmed: confirmed,
      status,
      amount,
      order_id: orderId,
      quote_ref: submission.id,
      restaurant_id: submission.vendorId,
      payment_channel: submission.paymentChannelName,
      computed_total: submission.computedTotal,
      ...(extras.tipRaw !== undefined && { tip: formatNaira(extras.tipRaw) }),
      ...(extras.promoCode && { promo_code: extras.promoCode }),
      ...(extras.gift && { gift_for: extras.gift.name }),
      ...(trackingLinkOf(data.tracking_url) && { tracking_link: trackingLinkOf(data.tracking_url) }),
      ...(warnings.length > 0 && { warnings }),
      next_step:
        "To pay, call start_payment with this quote_ref: it first shows Chowdeck's own order total for the user to confirm, then returns a payment link. If start_payment is not available, the user pays in the Chowdeck app. To drop the unpaid order instead, use cancel_order; editing or clearing the cart does not cancel it. Once paid, follow it with track_order (tracking_link is Chowdeck's tracking page; it is private to the user). Do not place this order again.",
      outcome_uncertain: false,
      safe_to_retry: false,
    };
    if (!saved) {
      return reportResult({
        ...result,
        warning: `ChowBot could not save this order. Keep order id ${orderId} and run resolve_order_submission with outcome link_order and order_id ${orderId}. Do not place the order again.`,
      });
    }
    return reportResult(result);
  }

  private async unknownOutcome(submission: OrderSubmission, detail: string) {
    await this.persist(() =>
      this.submissions.recordOutcome(submission.id, { kind: "unknown" }),
    );
    return reportResult(
      {
        action: "place_order",
        outcome: "unknown_outcome",
        message: `The order's outcome is unknown (${detail}). An order may or may not have been created on Chowdeck. Do not place it again.`,
        chowdeck_confirmed: [],
        status: null,
        next_step:
          "Check the Chowdeck app; if you find the order, link it with resolve_order_submission (outcome link_order). Never place it again.",
        outcome_uncertain: true,
        safe_to_retry: false,
      },
      true,
    );
  }

  /*
   * R2: retries only a local database write. Returns false when every
   * attempt failed, leaving the attempt locked.
   */
  private async persist(write: () => Promise<boolean>) {
    for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt++) {
      try {
        return await write();
      } catch (error) {
        logFailure("Saving an order outcome failed:", error);
        const delay = PERSIST_BACKOFF_MS[attempt];
        if (delay !== undefined) await Bun.sleep(delay);
      }
    }
    return false;
  }

  /*
   * Records what a fresh Chowdeck reading proves about a created attempt:
   * payment (the lock stays) or cancellation (the lock is freed).
   */
  private async recordFromChowdeck(attempt: OrderSubmission, classification: OrderClassification) {
    if (attempt.state !== "created") return false;
    if (classification.state === "payment_confirmed") {
      return this.submissions.recordPaid(attempt.id, classification.evidence);
    }
    if (classification.state === "cancelled") {
      return this.submissions.recordCancelled(attempt.id, classification.evidence);
    }
    return false;
  }

  /*
   * R1 and R4 for one restaurant: releases provably unsent claims after
   * the grace period, reads every order ChowBot created there freshly from
   * Chowdeck and records payment or cancellation only from that evidence,
   * and reports every attempt that still holds a lock with its current
   * state and that state's source. Unknown attempts are never released here.
   */
  async getStatus(restaurantId: number) {
    await this.authHeaders();
    const before = await this.submissions.listOpen(restaurantId);
    for (const cartId of new Set(
      before
        .filter((a) => a.state === "submitting" && !a.orderRequestStartedAt)
        .map((a) => a.cartId),
    )) {
      await this.submissions.recoverUnsent(cartId);
    }

    const statuses = new Map<string, OrderStatusReport>();
    const cancelled: Record<string, unknown>[] = [];
    for (const attempt of before.filter((a) => a.chowdeckOrderId && (a.state === "created" || a.state === "paid"))) {
      const fresh = await this.freshState(attempt.chowdeckOrderId!);
      if (!fresh.ok) {
        statuses.set(attempt.id, stateUnavailable(attempt.chowdeckOrderId!, fresh.error, recordedState(attempt)));
        continue;
      }
      const status = stateFromChowdeck(attempt.chowdeckOrderId!, fresh.classification, attempt);
      statuses.set(attempt.id, status);
      await this.recordFromChowdeck(attempt, fresh.classification);
      if (attempt.state === "created" && fresh.classification.state === "cancelled") {
        cancelled.push({
          quote_ref: attempt.id,
          order_id: attempt.chowdeckOrderId,
          status,
          guidance: "Chowdeck's order record shows this order cancelled, so ChowBot stopped tracking it and the cart can be ordered from again.",
        });
      }
    }

    /*
     * Abandoned (operator-released) created orders still in the warning
     * window keep being checked, with the same evidence rule. A payment found
     * is recorded beside the attempt; nothing else about it changes and the
     * lock is not retaken. A failed lookup records nothing and implies
     * neither cancellation nor non-payment.
     */
    for (const attempt of await this.submissions.listRecentlyReleased(restaurantId)) {
      if (attempt.state !== "created" || !attempt.chowdeckOrderId) continue;
      if (attempt.paidAfterReleaseAt) continue;
      const fresh = await this.freshState(attempt.chowdeckOrderId);
      if (!fresh.ok) {
        statuses.set(attempt.id, stateUnavailable(attempt.chowdeckOrderId, fresh.error, recordedState(attempt)));
        continue;
      }
      statuses.set(attempt.id, stateFromChowdeck(attempt.chowdeckOrderId, fresh.classification, attempt));
      if (fresh.classification.paid) {
        await this.submissions.recordPaidAfterRelease(attempt.id, fresh.classification.evidence);
      }
    }

    const open = await this.submissions.listOpen(restaurantId);
    const released = await this.submissions.listRecentlyReleased(restaurantId);
    const statusOf = (attempt: OrderSubmission) =>
      statuses.get(attempt.id) ??
      (attempt.chowdeckOrderId
        ? undefined
        : {
            order_state: "unknown",
            source: "ChowBot's record only: there is no Chowdeck order id to read",
            detail:
              attempt.state === "submitting" && !attempt.orderRequestStartedAt
                ? "The order request was never sent"
                : "An order may or may not exist on Chowdeck",
            last_recorded_by_chowbot: recordedState(attempt),
          });
    return reportResult({
      action: "get_order_submission",
      outcome: "checked",
      message: `ChowBot's order attempts at restaurant ${restaurantId}, each with its current state read from Chowdeck where possible.`,
      chowdeck_confirmed: [...statuses.values()]
        .filter((status) => status.source.startsWith("Chowdeck's order record"))
        .map((status) => `order ${status.order_id}: ${status.detail}`),
      status: null,
      restaurant_id: restaurantId,
      attempts: open.map((attempt) => ({
        quote_ref: attempt.id,
        recorded_state: attempt.state,
        ...(attempt.chowdeckOrderId && { order_id: attempt.chowdeckOrderId }),
        status: statusOf(attempt),
        claimed_at: attempt.claimedAt?.toISOString() ?? null,
        order_request_started: attempt.orderRequestStartedAt !== null,
        ...paymentStartOf(attempt),
        ...cancelRequestOf(attempt),
        ...(attempt.promoCode && { promo_code: attempt.promoCode }),
        guidance: guidanceFor(attempt, statuses.get(attempt.id)),
      })),
      ...(cancelled.length > 0 && { cancelled }),
      abandoned: released.map((attempt) => ({
        quote_ref: attempt.id,
        status_label: "abandoned",
        last_known_state: attempt.state,
        ...(attempt.chowdeckOrderId && { order_id: attempt.chowdeckOrderId }),
        ...(statuses.has(attempt.id) && { status: statuses.get(attempt.id) }),
        order_request_started: attempt.orderRequestStartedAt !== null,
        ...paymentStartOf(attempt),
        reason: attempt.recoveryReasonCode,
        abandoned_at: attempt.lockReleasedAt?.toISOString() ?? null,
        ...(attempt.paidAfterReleaseAt && {
          paid_after_abandoned: { confirmed_at: attempt.paidAfterReleaseAt.toISOString() },
        }),
        guidance: abandonedGuidanceFor(attempt),
      })),
      next_step:
        "Tell the user each order's state as reported in status, with its source. An unknown state is not unpaid, paid or cancelled.",
      outcome_uncertain: [...statuses.values()].some((status) => status.order_state === "unknown"),
      safe_to_retry: true,
    });
  }

  /*
   * Cancels a created, unpaid order ChowBot placed, with the endpoint the
   * website was seen calling. The first call checks Chowdeck's order record
   * and returns a summary and confirmation code; the second, only after the
   * user agrees, commits the cancellation marker and sends the request
   * exactly once. The order record then decides whether it is cancelled.
   */
  async cancelOrder(args: CancelOrderArgs, ctx: ServerContext): Promise<CallToolResult> {
    await this.authHeaders();
    if (!this.requestStateCodec) {
      return cancelRefused("Order not cancelled: cancellation is not available on this server.", "Cancel it in the Chowdeck app.");
    }
    const submission = await this.submissions.get(args.quote_ref);
    if (!submission)
      return cancelRefused("Order not cancelled: that quote_ref does not exist for your account.", "Use a quote_ref from place_order or get_order_submission.");
    const orderId = submission.chowdeckOrderId;
    if (submission.lockReleasedAt) {
      return cancelRefused(
        "Order not cancelled: this attempt was marked abandoned, so ChowBot no longer manages it.",
        "If the order still exists, cancel it in the Chowdeck app.",
      );
    }
    if (!orderId || !["created", "paid", "cancelled"].includes(submission.state)) {
      return cancelRefused(
        "Order not cancelled: only an order ChowBot created and recorded can be cancelled here.",
        "Check the attempt with get_order_submission; for an unknown outcome, follow its guidance.",
      );
    }

    const fresh = await this.freshState(orderId);
    if (!fresh.ok) {
      return cancelRefused(
        `Order not cancelled: ChowBot could not read order ${orderId} from Chowdeck (${fresh.error}), so it cannot check the order is unpaid. Nothing was sent.`,
        "Try again later, or check the order in the Chowdeck app.",
        stateUnavailable(orderId, fresh.error, recordedState(submission)),
      );
    }
    const status = stateFromChowdeck(orderId, fresh.classification, submission);
    await this.recordFromChowdeck(submission, fresh.classification);
    if (fresh.classification.state === "cancelled") {
      return reportResult({
        action: "cancel_order",
        outcome: "already_cancelled",
        message: `Chowdeck's order record shows order ${orderId} is already cancelled. Nothing was sent.`,
        chowdeck_confirmed: [fresh.classification.reason],
        status,
        next_step: "Nothing to cancel. The cart can be ordered from again with a new quote.",
        outcome_uncertain: false,
        safe_to_retry: true,
      });
    }
    if (fresh.classification.state === "payment_confirmed") {
      return cancelRefused(`Order not cancelled: ${PAID_ORDER_OPTIONS}`, "Tell the user the order is paid and what Chowdeck supports, as above.", status);
    }
    if (fresh.classification.state !== "awaiting_payment") {
      return cancelRefused(
        `Order not cancelled: ${fresh.classification.reason}, so ChowBot cannot confirm the order is unpaid and sends no cancellation.`,
        "Check the order in the Chowdeck app.",
        status,
      );
    }
    if (submission.cancelRequestedAt) {
      return cancelRefused(
        `Order not cancelled again: a cancellation was already sent for order ${orderId} (${submission.cancelRequestState === "rejected" ? "Chowdeck refused it" : submission.cancelRequestState === "accepted" ? "Chowdeck accepted it, but its order record still does not show the order cancelled" : "its outcome is unknown"}). ChowBot never sends a second cancellation.`,
        "Check the order later with get_order_submission, or cancel it in the Chowdeck app.",
        status,
      );
    }

    if (args.confirmation === undefined) {
      const amounts = orderAmounts(fresh.order);
      const summary = [
        `Cancel Chowdeck order ${orderId}${amounts ? ` (total ${amounts.total} on Chowdeck's order record)` : ""}?`,
        "Chowdeck's order record shows it unpaid.",
        `ChowBot sends one cancellation request to Chowdeck (POST ${cancelOrderPath(orderId)}) and then reads the order again to see whether it was cancelled; it never retries.`,
        "Whether Chowdeck lets a customer cancel this order has not been verified, so it may refuse.",
        ...(submission.paymentStartedAt
          ? ["A payment link was generated for this order: if the user has paid or is paying, do not cancel, as ChowBot does not handle refunds."]
          : []),
        "The cart is not changed, and no payment can be started for this order afterwards.",
      ].join(" ");
      const confirmation = await this.requestStateCodec.mint(
        { v: 1, kind: "cancel_order", submissionId: submission.id, orderId } satisfies CancelState,
        ctx,
      );
      return reportResult({
        action: "cancel_order",
        outcome: "confirmation_required",
        message: "Nothing was cancelled yet. The user must confirm first.",
        chowdeck_confirmed: [fresh.classification.reason],
        status,
        ...(amounts && { amount: amounts }),
        summary,
        confirmation,
        expires_in_seconds: REQUEST_STATE_TTL_SECONDS,
        next_step:
          "Show the user this summary and ask whether to cancel. Only if they explicitly say yes, call cancel_order again with the same quote_ref plus confirmation set to this value.",
        outcome_uncertain: false,
        safe_to_retry: true,
      });
    }

    let state: CancelState;
    try {
      state = (await this.requestStateCodec.verify(args.confirmation, ctx)) as CancelState;
    } catch {
      return cancelRefused("Order not cancelled: the confirmation code is invalid, expired or not yours.", "Call cancel_order again without confirmation and show the user the new summary.");
    }
    if (state.kind !== "cancel_order" || state.submissionId !== submission.id || state.orderId !== orderId) {
      return cancelRefused("Order not cancelled: the confirmation does not belong to this order.", "Call cancel_order again without confirmation and show the user the new summary.");
    }

    let marked: boolean;
    try {
      marked = await this.submissions.markCancelRequested(submission.id, orderId);
    } catch (error) {
      logFailure("Marking a cancellation failed:", error);
      return cancelRefused(
        "Order not cancelled: ChowBot could not confirm it was safe to send the cancellation, so nothing was sent.",
        "Try again later, or cancel it in the Chowdeck app.",
        status,
      );
    }
    if (!marked) {
      return cancelRefused("Order not cancelled: this order changed or a cancellation was sent for it in the meantime. Nothing was sent.", "Check it with get_order_submission.", status);
    }
    return this.sendCancelOnce(submission, orderId);
  }

  private async sendCancelOnce(submission: OrderSubmission, orderId: number) {
    const path = cancelOrderPath(orderId);
    let requestOutcome: "accepted" | "rejected" | "unknown";
    let requestDetail: string;
    try {
      const response = await this.client.request(path, {
        method: "POST",
        headers: await this.authHeaders(),
      });
      if (isRecord(response) && response.status === "success") {
        requestOutcome = "accepted";
        requestDetail = `Chowdeck answered the cancellation request with success${typeof response.message === "string" ? ` ("${response.message}")` : ""}`;
      } else {
        requestOutcome = "unknown";
        requestDetail = `POST ${path} returned an unexpected response${isRecord(response) && typeof response.message === "string" ? ` ("${response.message}")` : ""}`;
      }
    } catch (error) {
      if (isDefiniteOrderRejection(error)) {
        requestOutcome = "rejected";
        requestDetail = `Chowdeck refused the cancellation: ${error.message}`;
      } else {
        requestOutcome = "unknown";
        requestDetail = describeError(error);
      }
    }
    await this.persist(() => this.submissions.recordCancelRequest(submission.id, requestOutcome));

    const fresh = await this.freshState(orderId);
    const status = fresh.ok
      ? stateFromChowdeck(orderId, fresh.classification, submission)
      : stateUnavailable(orderId, fresh.error, recordedState(submission));
    if (fresh.ok) await this.persist(() => this.recordFromChowdeck(submission, fresh.classification));
    const confirmedCancelled = fresh.ok && fresh.classification.state === "cancelled";
    const confirmed = [
      ...(requestOutcome !== "unknown" ? [requestDetail] : []),
      ...(fresh.ok ? [fresh.classification.reason] : []),
    ];

    if (confirmedCancelled) {
      return reportResult({
        action: "cancel_order",
        outcome: "cancelled",
        message: `Order ${orderId} is cancelled: Chowdeck's order record confirms it.`,
        chowdeck_confirmed: confirmed,
        status,
        next_step: "Tell the user the order is cancelled. The cart was not changed; a new order needs a new quote.",
        outcome_uncertain: false,
        safe_to_retry: false,
      });
    }
    if (requestOutcome === "rejected") {
      return reportResult(
        {
          action: "cancel_order",
          outcome: "rejected_by_chowdeck",
          message: `Order not cancelled: ${requestDetail}.`,
          chowdeck_confirmed: confirmed,
          status,
          next_step:
            "Tell the user Chowdeck refused the cancellation. ChowBot will not try again; the order stays as Chowdeck shows it. The user can check the Chowdeck app for their options.",
          outcome_uncertain: false,
          safe_to_retry: false,
        },
        true,
      );
    }
    return reportResult(
      {
        action: "cancel_order",
        outcome: requestOutcome === "accepted" ? "cancellation_unconfirmed" : "unknown_outcome",
        message:
          requestOutcome === "accepted"
            ? `Chowdeck accepted the cancellation request for order ${orderId}, but its order record does not show the order cancelled${fresh.ok ? ` (status ${fresh.classification.evidence.orderStatus ?? "not given"})` : ""}. The cancellation is not confirmed.`
            : `The cancellation's outcome is unknown (${requestDetail}). Order ${orderId} may or may not have been cancelled.`,
        chowdeck_confirmed: confirmed,
        status,
        next_step:
          "Do not send another cancellation and do not pay this order yet. Check it later with get_order_submission or in the Chowdeck app.",
        outcome_uncertain: true,
        safe_to_retry: false,
      },
      true,
    );
  }

  /*
   * R3: links an order the user found in Chowdeck to an attempt whose order
   * request was sent but whose outcome is unknown. The order must be
   * readable with the user's token, belong to the same restaurant and not
   * predate the claim. If it cannot be verified, the lock is kept.
   */
  async linkOrder(quoteRef: string, orderId: number) {
    const refuse = (message: string, status: OrderStatusReport | null = null) =>
      notSentReport("resolve_order_submission", message, "Check the order id in the Chowdeck app; the attempt stays locked.", status);
    await this.authHeaders();
    const attempt = await this.submissions.get(quoteRef);
    if (!attempt) return refuse("Not linked: that quote_ref does not exist for your account.");
    if (!(
      attempt.state === "unknown" ||
      (attempt.state === "submitting" && attempt.orderRequestStartedAt)
    )) {
      return refuse("Not linked: only an attempt whose order request was sent and whose outcome is unknown can be linked.");
    }

    const fresh = await this.freshState(orderId);
    if (!fresh.ok) {
      return refuse(`Not linked: Chowdeck could not confirm that order (${fresh.error}). The attempt stays locked.`);
    }
    const { order, classification } = fresh;
    if (order.vendor_id !== attempt.vendorId) {
      return refuse("Not linked: that order is from a different restaurant. The attempt stays locked.");
    }
    const createdAt =
      typeof order.created_at === "string"
        ? Date.parse(order.created_at)
        : Number.NaN;
    if (
      !attempt.claimedAt ||
      Number.isNaN(createdAt) ||
      createdAt < attempt.claimedAt.getTime() - LINK_CLOCK_TOLERANCE_MS
    ) {
      return refuse("Not linked: that order could not be shown to come after this attempt. The attempt stays locked.");
    }

    const outcome = await this.submissions.linkOrder(attempt.id, orderId, classification.evidence);
    if (outcome === "order_already_linked") {
      return refuse("Not linked: that order is already linked to another attempt. The attempt stays locked.");
    }
    if (outcome !== "linked") return refuse("Not linked: the attempt changed in the meantime.");
    return reportResult({
      action: "resolve_order_submission",
      outcome: "linked",
      message: `Order ${orderId} is now linked to this attempt.`,
      chowdeck_confirmed: [`order ${orderId} exists at this restaurant and was created after the attempt`, classification.reason],
      status: stateFromChowdeck(orderId, classification),
      quote_ref: attempt.id,
      order_id: orderId,
      state: "created",
      lock: "kept until payment is confirmed and the cart changes",
      next_step: "Check payment with get_order_submission, or pay with start_payment if Chowdeck shows it unpaid.",
      outcome_uncertain: false,
      safe_to_retry: true,
    });
  }
}

/*
 * Only the recorded payment-start state and time: never the payment link,
 * reference or other processor data, which ChowBot does not keep.
 */
const paymentStartOf = (attempt: OrderSubmission) =>
  attempt.paymentStartedAt
    ? {
        payment_start: {
          state: attempt.paymentStartState ?? "sent; outcome not recorded",
          started_at: attempt.paymentStartedAt.toISOString(),
        },
      }
    : {};

const cancelRequestOf = (attempt: OrderSubmission) =>
  attempt.cancelRequestedAt
    ? {
        cancel_request: {
          state: attempt.cancelRequestState ?? "sent; outcome not recorded",
          requested_at: attempt.cancelRequestedAt.toISOString(),
        },
      }
    : {};

/*
 * "Abandoned" is ChowBot's own label for an attempt an operator released: it
 * means ChowBot stopped tracking it, never that the order was cancelled.
 */
const abandonedGuidanceFor = (attempt: ReleasedSubmission) =>
  [
    `ChowBot support marked this attempt abandoned (${attempt.recoveryReasonCode?.startsWith("user_reported_") ? "based on your report, not verified with Chowdeck" : "reason recorded"}), so ChowBot no longer tracks it. Abandoned is not cancelled: ChowBot did not cancel anything on Chowdeck.`,
    attempt.paidAfterReleaseAt
      ? "Chowdeck has since confirmed this order was paid: it is a real, paid order. Do not place it again."
      : attempt.state === "created"
        ? "The order may still exist and may still be payable."
        : "An order may or may not exist for this attempt.",
    ...(attempt.paymentStartedAt
      ? ["A payment page started for it may still work."]
      : []),
    "A new order at this restaurant may duplicate it.",
  ].join(" ");

/*
 * A cart note as the confirmation shows it: the exact text the order would
 * carry, or "none".
 */
const quotedNote = (value: unknown) =>
  typeof value === "string" && value.trim() ? `"${value}"` : "none";

const guidanceFor = (attempt: OrderSubmission, status?: OrderStatusReport) => {
  if (status?.order_state === "payment_confirmed") return PAID_ORDER_OPTIONS;
  switch (attempt.state) {
    case "submitting":
      return attempt.orderRequestStartedAt
        ? "The order request was sent but its outcome was not recorded. Check the Chowdeck app and link the order if you find it."
        : "The order request was never sent; this attempt is released automatically after two minutes.";
    case "unknown":
      return "An order may or may not exist. Check the Chowdeck app and link the order if you find it. The cart stays locked.";
    case "created":
      if (status?.order_state === "unknown")
        return "ChowBot cannot tell the order's current state right now. Do not pay or order again until it can be checked. The cart stays locked.";
      return "The order exists on Chowdeck and is not paid. Pay it with start_payment (which shows Chowdeck's total first), or cancel it with cancel_order. Editing or clearing the cart does not change or cancel it. The cart stays locked.";
    case "paid":
      return "ChowBot recorded Chowdeck's payment confirmation earlier; see status for the current reading. The cart stays locked until it changes.";
    default:
      return "";
  }
};

export default OrderPlacementService;
