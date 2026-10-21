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
  type OrderEvidence,
  type OrderSubmission,
  type ReleasedSubmission,
  type UserOrderSubmissions,
} from "../../lib/order-submissions";
import { logger } from "../../utils/logger";
import OrderService, { readPaymentEvidence } from "../orders/service";
import { isRecord, type ScalarValue } from "../../utils/object";
import CheckoutService, { CheckoutRefusedError } from "../checkout/service";
import {
  formatNaira,
  tipFromNaira,
  validatePromoCode,
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
 * Checkout extras the order carries, as validated for submission.
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
  promo_code?: string;
  /*
   * Two-step confirmation, for clients that cannot show a confirmation
   * prompt: the code returned by the first call, sent back only after the
   * user explicitly agrees to the summary it came with.
   */
  confirmation?: string;
  acknowledge_unresolved_attempts?: boolean;
};

type ConfirmationAnswer = { confirm: boolean; acknowledge_unresolved_attempts?: boolean };

/*
 * Validates the extras from the arguments alone (no Chowdeck calls). Used
 * at submission, where the live checks were already made at confirmation
 * and the result is bound by extrasDigest.
 */
const extrasFromArgs = (args: PlaceOrderArgs): OrderExtras => {
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
  if (args.promo_code !== undefined) {
    const code = validatePromoCode(args.promo_code);
    if (!code.ok) throw new CheckoutRefusedError(`the promo code ${code.error}`);
    extras.promoCode = code.value;
  }
  return extras;
};

const answerSchema = z.object({
  confirm: z.boolean(),
  acknowledge_unresolved_attempts: z.boolean().optional(),
});

const text = (message: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: message }],
  ...(isError && { isError }),
});

const json = (value: unknown): CallToolResult => text(JSON.stringify(value));

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
 * cannot be taken as proof that no order was created.
 */
const isDefiniteOrderRejection = (error: unknown): error is ChowdeckApiError =>
  isDefiniteRejection(error) && error.status !== 401;

const describeError = (error: unknown) =>
  error instanceof ChowdeckApiError ? error.message : "unexpected error";

const logFailure = (what: string, error: unknown) =>
  logger.error(what, error instanceof Error ? error.name : typeof error);

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

/*
 * The only code path that sends POST /customer/order. A confirmed attempt is
 * claimed atomically, gated by one fresh delivery-fee quote, marked as
 * started (committed), and only then sent, exactly once. Nothing here
 * retries or replays an order request.
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
      return text("Order not placed: order placement is not available on this server.", true);
    }
    let state: PlacementState;
    try {
      state = (await this.requestStateCodec.verify(args.confirmation, ctx)) as PlacementState;
    } catch {
      return text(
        "Order not placed: the confirmation code is invalid, expired or not yours. Call place_order again without confirmation to get a new summary, and show it to the user.",
        true,
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
      return text(
        "Order not placed: order placement is not available on this server.",
        true,
      );
    }
    const submission = await this.submissions.get(args.quote_ref);
    if (!submission)
      return text(
        "Order not placed: that quote_ref does not exist for your account.",
        true,
      );
    if (
      submission.state !== "quoted" &&
      submission.state !== "confirmation_pending"
    ) {
      return text(
        "Order not placed: this quote was already used. Call get_checkout_quote again.",
        true,
      );
    }
    if (submission.quoteExpiresAt.getTime() <= Date.now()) {
      return text(
        "Order not placed: the quote expired. Call get_checkout_quote again and confirm the new total.",
        true,
      );
    }

    const checked = await this.revalidate(submission, args.address_id);
    if (!checked)
      return text(
        "Order not placed: the cart changed since the quote. Call get_checkout_quote again.",
        true,
      );

    const channel = await resolvePaymentChannel(
      this.client,
      await this.authHeaders(),
      this.channelQuery,
      args.payment_channel,
    );
    if (!channel) {
      return text(
        `Order not placed: the ${args.payment_channel} payment channel is not available right now.`,
        true,
      );
    }

    /*
     * The live checks for the extras: Chowdeck's tip limits, the gift
     * phone check and the promo discount calculation. A promo code is
     * accepted only when Chowdeck's calculation shows a discount.
     */
    let extras: OrderExtras;
    let promoDiscount = 0;
    try {
      extras = extrasFromArgs(args);
      if (extras.tipRaw !== undefined && typeof args.tip === "object") {
        const tip = tipFromNaira(args.tip.amount_naira, await this.checkout.readTipConfig());
        if (!tip.ok) throw new CheckoutRefusedError(`the tip ${tip.error}`);
      }
      if (extras.gift) await this.checkout.validateGiftPhone(extras.gift);
      if (extras.promoCode) {
        const promo = await this.checkout.promoCheck(
          {
            raw: checked.raw,
            vendorId: submission.vendorId,
            addressId: args.address_id,
            orderClass: checked.vendor.fields.self_delivery === true ? "vendor_delivery" : "delivery",
            cartTotal: (checked.cart.total_price ?? null) as ScalarValue,
          },
          extras.promoCode,
        );
        if (promo.status !== "discount") {
          throw new CheckoutRefusedError(
            promo.status === "rejected"
              ? `Chowdeck refused the promo code ${promo.promo_code} (${promo.rejection})`
              : `Chowdeck's discount calculation shows no discount for the promo code ${promo.promo_code}`,
          );
        }
        promoDiscount = promo.code_discount;
      }
    } catch (error) {
      if (error instanceof CheckoutRefusedError || error instanceof ChowdeckApiError) {
        return text(`Order not placed: ${error.message}.`, true);
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
      return text(
        "Order not placed: the quote is no longer valid. Call get_checkout_quote again.",
        true,
      );
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

    const message = [
      `Place this order at ${restaurantName}?`,
      `Items: ${items}.`,
      `Deliver to: ${addressLabel}.`,
      `Total: ${submission.computedTotal} (raw Chowdeck amount: cart total plus delivery and service fees, computed by ChowBot).`,
      `Payment: ${channel.name}. The order is created unpaid; payment is completed separately.`,
      extras.tipRaw !== undefined
        ? `Tip: ${formatNaira(extras.tipRaw)} for the rider.`
        : "Tip: none (ChowBot does not add a tip).",
      `Restaurant note: ${quotedNote(checked.raw.customer_vendor_note)}.`,
      `Delivery note: ${quotedNote(checked.raw.customer_delivery_note)}.`,
      extras.gift
        ? `Gift for ${extras.gift.name} (phone ${extras.gift.phone}, ${extras.gift.country_code}) from ${extras.gift.donor_name}${extras.gift.message ? `, message "${extras.gift.message}"` : ""}${extras.gift.save_as_beneficiary ? ", saved as a beneficiary on your account" : ""}.`
        : "Not a gift.",
      extras.promoCode
        ? `Promo code ${extras.promoCode}: Chowdeck's discount calculation shows ${formatNaira(promoDiscount)} off the items; the final discount is set by Chowdeck.`
        : "No promo code.",
      ...(extras.tipRaw !== undefined || extras.promoCode
        ? [
            `Estimated total: ${formatNaira(submission.computedTotal + (extras.tipRaw ?? 0) - promoDiscount)} (the total above${extras.tipRaw !== undefined ? " plus the tip" : ""}${extras.promoCode ? " minus the calculated discount" : ""}; computed by ChowBot, not confirmed by Chowdeck).`,
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
      return json({
        status: "confirmation_required",
        order_placed: false,
        summary: message,
        confirmation: requestState,
        expires_in_seconds: REQUEST_STATE_TTL_SECONDS,
        ...(unresolved.total > 0 && { requires_acknowledge_unresolved_attempts: true }),
        next_step:
          "Nothing was ordered. Show the user this summary in full and ask whether to place the order. Only if they explicitly say yes, call place_order again with exactly the same arguments plus confirmation set to this value" +
          (unresolved.total > 0 ? " and acknowledge_unresolved_attempts: true (only if they also accept the warning about earlier attempts)" : "") +
          ". Never call it again without their yes, and never after an unknown outcome.",
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
      return text(
        "Order not placed: the order details changed after confirmation was requested. Start again.",
        true,
      );
    }
    const answer =
      given ??
      acceptedContent(ctx.mcpReq.inputResponses, "confirm", answerSchema);
    if (answer?.confirm !== true)
      return text("Order not placed: it was not confirmed.");
    if (
      state.acknowledgementRequired &&
      answer.acknowledge_unresolved_attempts !== true
    ) {
      return text(
        "Order not placed: the earlier unresolved order attempts were not acknowledged.",
      );
    }

    const submission = await this.submissions.get(args.quote_ref);
    if (!submission)
      return text(
        "Order not placed: that quote_ref does not exist for your account.",
        true,
      );
    const checked = await this.revalidate(submission, args.address_id);
    if (!checked)
      return text(
        "Order not placed: the cart changed since the quote. Call get_checkout_quote again.",
        true,
      );
    let extras: OrderExtras;
    try {
      extras = extrasFromArgs(args);
    } catch (error) {
      if (error instanceof CheckoutRefusedError) return text(`Order not placed: ${error.message}.`, true);
      throw error;
    }
    if (state.extrasDigest !== extrasDigestOf(extras)) {
      return text(
        "Order not placed: the tip, gift or promo code differs from what was confirmed. Start again.",
        true,
      );
    }
    if (state.notesDigest !== notesDigestOf(checked.raw)) {
      return text(
        "Order not placed: the cart's restaurant or delivery note changed after confirmation was requested. Start again to confirm the current notes.",
        true,
      );
    }
    if (
      !state.acknowledgementRequired &&
      (await this.unresolvedAttempts(submission.vendorId, submission.id))
        .total > 0
    ) {
      return text(
        "Order not placed: another order attempt at this restaurant became unresolved after confirmation. Start again.",
        true,
      );
    }

    await this.submissions.recoverUnsent(submission.cartId);
    const claim = await this.submissions.claim(submission.id, {
      nonceHash: sha256(state.nonce),
      addressId: args.address_id,
      cartFingerprint: submission.cartFingerprint,
    });
    if (!claim.ok)
      return text(`Order not placed: ${CLAIM_REFUSALS[claim.reason]}.`, true);

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
      return text(
        definite
          ? `Order not placed: Chowdeck rejected the order check: ${describeError(error)}. No order was sent.`
          : `Order not placed: the delivery-fee check could not be confirmed (${describeError(error)}). A fee record may exist on Chowdeck, but no order was sent.`,
        true,
      );
    }

    let marked: boolean;
    try {
      marked = await this.submissions.markOrderRequestStarted(submission.id);
    } catch (error) {
      logFailure("Marking an order request as started failed:", error);
      return text(
        "Order not placed: ChowBot could not confirm it was safe to send the order, so nothing was sent. This attempt stays locked until it can be checked with get_order_submission.",
        true,
      );
    }
    if (!marked) {
      return text(
        "Order not placed: this attempt was recovered or changed before sending. Nothing was sent.",
        true,
      );
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
        return text(
          `Order not placed: Chowdeck rejected the order: ${error.message}. No order was created.`,
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
    const result = {
      order_id: orderId,
      quote_ref: submission.id,
      restaurant_id: submission.vendorId,
      payment_channel: submission.paymentChannelName,
      computed_total: submission.computedTotal,
      ...(extras.tipRaw !== undefined && { tip: formatNaira(extras.tipRaw) }),
      ...(extras.promoCode && { promo_code: extras.promoCode }),
      ...(extras.gift && { gift_for: extras.gift.name }),
      status:
        data.made_payment === true
          ? "created; Chowdeck reports it paid"
          : "created; awaiting payment",
      next_step:
        "ChowBot does not start payments yet. Check this order with get_order_submission; payment status is confirmed only from Chowdeck's order record.",
    };
    if (!saved) {
      return json({
        ...result,
        warning: `ChowBot could not save this order. Keep order id ${orderId} and run resolve_order_submission with outcome link_order and order_id ${orderId}. Do not place the order again.`,
      });
    }
    return json(result);
  }

  private async unknownOutcome(submission: OrderSubmission, detail: string) {
    await this.persist(() =>
      this.submissions.recordOutcome(submission.id, { kind: "unknown" }),
    );
    return text(
      `The order's outcome is unknown (${detail}). An order may or may not have been created on Chowdeck. Do not place it again. Check the Chowdeck app; if you find the order, link it with resolve_order_submission (outcome link_order).`,
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

  private paymentEvidence(
    orderId: number,
  ): Promise<{ paid: boolean; evidence: OrderEvidence }> {
    return readPaymentEvidence(this.orders, orderId);
  }

  /*
   * R1 and R4 for one restaurant: releases provably unsent claims after
   * the grace period, records payment from Chowdeck evidence, and reports
   * every attempt that still holds a lock. Unknown attempts are never
   * released here.
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

    const checks = new Map<string, string>();
    for (const attempt of before.filter(
      (a) => a.state === "created" && a.chowdeckOrderId,
    )) {
      try {
        const { paid, evidence } = await this.paymentEvidence(
          attempt.chowdeckOrderId!,
        );
        if (paid) {
          await this.submissions.recordPaid(attempt.id, evidence);
          checks.set(attempt.id, "payment confirmed by Chowdeck");
        } else {
          checks.set(
            attempt.id,
            `not paid yet (Chowdeck payment status: ${evidence.paymentStatus ?? "unknown"})`,
          );
        }
      } catch (error) {
        checks.set(
          attempt.id,
          `payment could not be checked (${describeError(error)})`,
        );
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
      if (attempt.state !== "created" || !attempt.chowdeckOrderId || attempt.paidAfterReleaseAt) continue;
      try {
        const { paid, evidence } = await this.paymentEvidence(attempt.chowdeckOrderId);
        if (paid) {
          await this.submissions.recordPaidAfterRelease(attempt.id, evidence);
          checks.set(attempt.id, "payment confirmed by Chowdeck after the attempt was abandoned");
        } else {
          checks.set(
            attempt.id,
            `not paid yet (Chowdeck payment status: ${evidence.paymentStatus ?? "unknown"})`,
          );
        }
      } catch (error) {
        checks.set(
          attempt.id,
          `payment could not be checked (${describeError(error)}); this does not mean the order is unpaid or no longer exists`,
        );
      }
    }

    const open = await this.submissions.listOpen(restaurantId);
    const released = await this.submissions.listRecentlyReleased(restaurantId);
    return json({
      restaurant_id: restaurantId,
      attempts: open.map((attempt) => ({
        quote_ref: attempt.id,
        state: attempt.state,
        ...(attempt.chowdeckOrderId && { order_id: attempt.chowdeckOrderId }),
        claimed_at: attempt.claimedAt?.toISOString() ?? null,
        order_request_started: attempt.orderRequestStartedAt !== null,
        ...paymentStartOf(attempt),
        ...(checks.has(attempt.id) && {
          payment_check: checks.get(attempt.id),
        }),
        guidance: guidanceFor(attempt),
      })),
      abandoned: released.map((attempt) => ({
        quote_ref: attempt.id,
        status: "abandoned",
        last_known_state: attempt.state,
        ...(attempt.chowdeckOrderId && { order_id: attempt.chowdeckOrderId }),
        order_request_started: attempt.orderRequestStartedAt !== null,
        ...paymentStartOf(attempt),
        reason: attempt.recoveryReasonCode,
        abandoned_at: attempt.lockReleasedAt?.toISOString() ?? null,
        ...(attempt.paidAfterReleaseAt && {
          paid_after_abandoned: { confirmed_at: attempt.paidAfterReleaseAt.toISOString() },
        }),
        ...(checks.has(attempt.id) && {
          payment_check: checks.get(attempt.id),
        }),
        guidance: abandonedGuidanceFor(attempt),
      })),
    });
  }

  /*
   * R3: links an order the user found in Chowdeck to an attempt whose order
   * request was sent but whose outcome is unknown. The order must be
   * readable with the user's token, belong to the same restaurant and not
   * predate the claim. If it cannot be verified, the lock is kept.
   */
  async linkOrder(quoteRef: string, orderId: number) {
    await this.authHeaders();
    const attempt = await this.submissions.get(quoteRef);
    if (!attempt)
      return text(
        "Not linked: that quote_ref does not exist for your account.",
        true,
      );
    if (!(
      attempt.state === "unknown" ||
      (attempt.state === "submitting" && attempt.orderRequestStartedAt)
    )) {
      return text(
        "Not linked: only an attempt whose order request was sent and whose outcome is unknown can be linked.",
        true,
      );
    }

    let order: Record<string, unknown>;
    try {
      ({ order } = await this.orders.getOrder(String(orderId)));
    } catch (error) {
      return text(
        `Not linked: Chowdeck could not confirm that order (${describeError(error)}). The attempt stays locked.`,
        true,
      );
    }
    if (order.vendor_id !== attempt.vendorId) {
      return text(
        "Not linked: that order is from a different restaurant. The attempt stays locked.",
        true,
      );
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
      return text(
        "Not linked: that order could not be shown to come after this attempt. The attempt stays locked.",
        true,
      );
    }

    const payment = isRecord(order.payment) ? order.payment : undefined;
    const outcome = await this.submissions.linkOrder(attempt.id, orderId, {
      orderStatus: typeof order.status === "string" ? order.status : null,
      paymentStatus:
        typeof payment?.status === "string" ? payment.status : null,
    });
    if (outcome === "order_already_linked") {
      return text(
        "Not linked: that order is already linked to another attempt. The attempt stays locked.",
        true,
      );
    }
    if (outcome !== "linked")
      return text("Not linked: the attempt changed in the meantime.", true);
    return json({
      quote_ref: attempt.id,
      order_id: orderId,
      state: "created",
      lock: "kept until payment is confirmed and the cart changes",
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

const guidanceFor = (attempt: OrderSubmission) => {
  switch (attempt.state) {
    case "submitting":
      return attempt.orderRequestStartedAt
        ? "The order request was sent but its outcome was not recorded. Check the Chowdeck app and link the order if you find it."
        : "The order request was never sent; this attempt is released automatically after two minutes.";
    case "unknown":
      return "An order may or may not exist. Check the Chowdeck app and link the order if you find it. The cart stays locked.";
    case "created":
      return "The order exists and is awaiting payment. The cart stays locked.";
    case "paid":
      return "Paid. The cart stays locked until it changes.";
    default:
      return "";
  }
};

export default OrderPlacementService;
