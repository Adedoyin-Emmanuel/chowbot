import {
  isIdLessChoice,
  resolvePaymentChannel,
  type OrderPaymentChoice,
  type PaymentChannelQuery,
  type SupportedPaymentChannel,
} from "./channels";
import {
  notSentReport,
  orderAmounts,
  reportResult,
  stateFromChowdeck,
  stateUnavailable,
  type ActionReport,
  type OrderClassification,
  type OrderStatusReport,
} from "../orders/status";
import { isRecord, type ScalarValue } from "../../utils/object";
import OrderService, { payForMeLinkOf, readOrderState, trackingLinkOf, type OrderDetail } from "../orders/service";
import CheckoutService, { CheckoutRefusedError, type OrderQuote } from "../checkout/service";
import {
  formatNaira,
  tipFromNaira,
  validateGiftRecipient,
  type GiftRecipient,
  type GiftRecipientInput,
} from "../checkout/draft";
import PaymentService, { pocketTagOf, type PaymentStartConfig } from "../payments/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import { NotSignedInError } from "../addresses/service";
import { chowdeckAuthHeaders, type UserSession } from "../../lib/session";

const ORDER_PATH = "/customer/order";
const CHECKOUT_CURRENCY = "NGN";
const CHECKOUT_COUNTRY_CODE = "NG";

/*
 * When the active-order list could not be read before sending, an order is
 * matched by creation time instead, allowing for clock skew.
 */
const CLOCK_TOLERANCE_MS = 2 * 60 * 1000;

export type PlaceOrderArgs = {
  restaurant_id: number;
  address_id: number;
  quoted_total: number;
  payment_channel: OrderPaymentChoice;
  pocket_tag?: string;
  promo_code?: string;
  tip?: "none" | { amount_naira: number };
  gift?: GiftRecipientInput;
};

type Extras = { tipRaw?: number; gift?: GiftRecipient };

type OrderRead = { order: OrderDetail; classification: OrderClassification };

const describeError = (error: unknown) =>
  error instanceof ChowdeckApiError ? error.message : "unexpected error";

/*
 * A 401 is not proof nothing was created: the website treats it as an expired
 * token and re-sends the same order.
 */
const isDefiniteRejection = (error: unknown): error is ChowdeckApiError =>
  error instanceof ChowdeckApiError &&
  error.kind === "http" &&
  error.status !== undefined &&
  error.status < 500 &&
  error.status !== 401;

const isPositiveId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

/*
 * As on the website, an unpaid order is changed by placing a new one from the
 * cart: each attempt in the user's capture was a new order, and Chowdeck
 * leaves the earlier unpaid one unpaid ("abandoned").
 */
const CHANGE_BEFORE_PAYING =
  "Until it is paid, the user can change anything (restaurant or rider note, tip, bags, items, address or payment channel): update the cart or arguments and call place_order again. The earlier unpaid order stays unpaid and is never charged; give the user only the newest payment link.";

const refused = (message: string, nextStep: string) => notSentReport("place_order", message, nextStep);

const quotedNote = (value: unknown) =>
  typeof value === "string" && value.trim() ? `"${value}"` : "none";

const createdSince = (value: ScalarValue | undefined, since: number) => {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return !Number.isNaN(time) && time >= since;
};

/*
 * The only code path that sends POST /customer/order. Everything is checked
 * against Chowdeck just before sending, the request is sent exactly once, and
 * an unclear outcome is resolved only from Chowdeck's own order list. Nothing
 * about the order is stored.
 */
class OrderPlacementService {
  private readonly orders: OrderService;
  private readonly checkout: CheckoutService;
  private readonly payments: PaymentService;

  constructor(
    private readonly session: UserSession,
    private readonly channelQuery: PaymentChannelQuery,
    paymentStartConfig: PaymentStartConfig,
    private readonly client = new ChowdeckClient(),
  ) {
    this.orders = new OrderService(session, client);
    this.checkout = new CheckoutService(session, client);
    this.payments = new PaymentService(session, paymentStartConfig, client);
  }

  private async authHeaders() {
    const headers = await chowdeckAuthHeaders(this.session);
    if (!headers.authorization) throw new NotSignedInError();
    return headers;
  }

  async placeOrder(args: PlaceOrderArgs) {
    const headers = await this.authHeaders();
    const choice = args.payment_channel;
    const pocketTag = pocketTagOf(args.pocket_tag);
    if (choice === "pocket" && !pocketTag) {
      return refused(
        "Order not placed: a PocketApp payment needs the payer's Pocket tag. Nothing was sent.",
        "Ask the user for their Pocket tag and call place_order again with pocket_tag.",
      );
    }

    let extras: Extras;
    let quote: OrderQuote;
    try {
      extras = this.extrasFromArgs(args);
      quote = await this.checkout.quoteForOrder(args.restaurant_id, args.address_id, args.promo_code);
    } catch (error) {
      if (error instanceof CheckoutRefusedError || error instanceof ChowdeckApiError) {
        return refused(`Order not placed: ${error.message}. Nothing was sent.`, "Tell the user why; fix it if they want, then try again.");
      }
      throw error;
    }

    if (quote.computedTotal !== Math.round(args.quoted_total * 100)) {
      return refused(
        `Order not placed: the total is now ${formatNaira(quote.computedTotal)}, not the ${formatNaira(Math.round(args.quoted_total * 100))} quoted. Nothing was sent.`,
        `Tell the user the new total. Only if they still want the order, call place_order again with quoted_total: ${quote.computedTotal / 100}.`,
      );
    }

    // Chowdeck's tip limits and gift phone check, read only when used.
    try {
      if (extras.tipRaw !== undefined && typeof args.tip === "object") {
        const tip = tipFromNaira(args.tip.amount_naira, await this.checkout.readTipConfig());
        if (!tip.ok) throw new CheckoutRefusedError(`the tip ${tip.error}`);
      }
      if (extras.gift) await this.checkout.validateGiftPhone(extras.gift);
    } catch (error) {
      if (error instanceof CheckoutRefusedError) {
        return refused(`Order not placed: ${error.message}. Nothing was sent.`, "Correct the tip or gift details and try again.");
      }
      throw error;
    }

    let channelId: number | undefined;
    if (!isIdLessChoice(choice)) {
      channelId = (await resolvePaymentChannel(this.client, headers, this.channelQuery, choice))?.id;
      if (channelId === undefined) {
        return refused(
          `Order not placed: the ${choice} payment channel is not available right now. Nothing was sent.`,
          "Choose another payment option, or try again later.",
        );
      }
    }

    const estimate = quote.computedTotal + (extras.tipRaw ?? 0) - (quote.promo?.discountRaw ?? 0);
    // A wallet order is paid at creation, so the balance must cover the estimate.
    if (choice === "wallet") {
      let balance: number;
      try {
        balance = (await this.checkout.readWalletBalance()).total;
      } catch (error) {
        if (error instanceof NotSignedInError) throw error;
        return refused(
          `Order not placed: ChowBot could not read your Chowdeck wallet balance (${describeError(error)}). Nothing was sent.`,
          "Try again later, or choose another payment option.",
        );
      }
      if (balance < estimate) {
        return refused(
          `Order not placed: your Chowdeck wallet balance (${formatNaira(balance)}) is below the estimated total (${formatNaira(estimate)}). Nothing was sent.`,
          "Top up the wallet in the Chowdeck app, or choose another payment option.",
        );
      }
    }

    const body = {
      source: "web",
      vendor_id: args.restaurant_id,
      cart_id: quote.cart.id,
      checkout_from_cart: true,
      class: quote.orderClass,
      fee_id: quote.feeId,
      address_id: args.address_id,
      ...(choice === "wallet"
        ? { payment_method: "wallet" }
        : choice === "pay_for_me"
          ? { payment_method: "pay_for_me", has_external_payment: true }
          : { payment_method_id: channelId }),
      split_payment_with_wallet: false,
      requires_delivery_pin: true,
      bag_quantity: quote.raw.bag_quantity,
      promo_codes: quote.promo ? [quote.promo.code] : [],
      currency: CHECKOUT_CURRENCY,
      country_code: CHECKOUT_COUNTRY_CODE,
      customer_vendor_note: quote.raw.customer_vendor_note ?? null,
      customer_delivery_note: quote.raw.customer_delivery_note ?? null,
      gift_recipient: extras.gift ?? null,
      // Raw x100 units.
      ...(extras.tipRaw !== undefined && { tip: extras.tipRaw }),
    };

    // Evidence for an unclear outcome: the active orders that already exist.
    const before = await this.activeOrderIds(args.restaurant_id);
    const sentAt = Date.now();
    const placed = { args, quote, extras, estimate, pocketTag };
    let response: unknown;
    try {
      response = await this.client.request(ORDER_PATH, { method: "POST", headers, body });
    } catch (error) {
      if (isDefiniteRejection(error)) {
        return reportResult(
          {
            action: "place_order",
            outcome: "rejected_by_chowdeck",
            message: `Order not placed: Chowdeck rejected the order: ${error.message}. No order was created.`,
            chowdeck_confirmed: [`Chowdeck refused the order request (status ${error.status})`],
            status: null,
            next_step: "Tell the user why Chowdeck refused it. They may fix the problem and try again.",
            outcome_uncertain: false,
            safe_to_retry: true,
          },
          true,
        );
      }
      return this.reconcile(placed, before, sentAt, describeError(error));
    }

    const data =
      isRecord(response) && response.status === "success" && isRecord(response.data) ? response.data : undefined;
    if (!data || !isPositiveId(data.id)) {
      return this.reconcile(placed, before, sentAt, `POST ${ORDER_PATH} returned an unexpected response`);
    }
    return this.createdReport(placed, data.id, data);
  }

  private extrasFromArgs(args: PlaceOrderArgs): Extras {
    const extras: Extras = {};
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
    return extras;
  }

  private async activeOrdersAt(restaurantId: number) {
    const { orders } = await this.orders.listOrders("active");
    return orders.filter((order) => Number(order.vendor_id) === restaurantId);
  }

  private async activeOrderIds(restaurantId: number) {
    try {
      return new Set((await this.activeOrdersAt(restaurantId)).map((order) => String(order.id)));
    } catch (error) {
      if (error instanceof NotSignedInError) throw error;
      return undefined;
    }
  }

  /*
   * The order request may or may not have created an order. It is never
   * resent: Chowdeck's active orders are read once, and exactly one new order
   * at the restaurant is taken as the one created.
   */
  private async reconcile(placed: Placed, before: Set<string> | undefined, sentAt: number, detail: string) {
    let found: Record<string, ScalarValue>[] | undefined;
    let lookupError: string | undefined;
    try {
      found = (await this.activeOrdersAt(placed.args.restaurant_id)).filter((order) =>
        before ? !before.has(String(order.id)) : createdSince(order.created_at, sentAt - CLOCK_TOLERANCE_MS),
      );
    } catch (error) {
      lookupError = describeError(error);
    }
    const orderId = found?.length === 1 ? Number(found[0]!.id) : undefined;
    if (isPositiveId(orderId)) return this.createdReport(placed, orderId, {}, detail);

    const evidence = lookupError
      ? `ChowBot could not read your active Chowdeck orders to check (${lookupError}).`
      : found && found.length > 1
        ? `Chowdeck lists ${found.length} new active orders at this restaurant (${found.map((order) => order.id).join(", ")}), so ChowBot cannot tell which, if any, is this one.`
        : "Chowdeck's active orders show no new order at this restaurant, but that does not prove none was created.";
    return reportResult(
      {
        action: "place_order",
        outcome: "unknown_outcome",
        message: `The order's outcome is unknown (${detail}). ${evidence} An order may or may not have been created.`,
        chowdeck_confirmed: [],
        status: null,
        ...(found && found.length > 1 && { possible_orders: found }),
        next_step:
          placed.args.payment_channel === "wallet"
            ? "A wallet order is charged when it is created, so do not place it again until list_orders (status active) or the wallet balance shows whether this one went through."
            : "No payment was taken. Check list_orders with status active: if this order is there, use it (start_payment gives its payment link); if not, place it again. An extra unpaid order is never charged.",
        outcome_uncertain: true,
        safe_to_retry: false,
      },
      true,
    );
  }

  /*
   * Reads the new order's record and reports Chowdeck's own state, total and
   * notes. For an online channel it then starts the payment, unless the
   * record is unclear or its total differs from the estimate.
   */
  private async createdReport(placed: Placed, orderId: number, data: Record<string, unknown>, unclearResponse?: string) {
    const { args, quote, extras, estimate, pocketTag } = placed;
    const choice = args.payment_channel;
    const confirmed = [
      unclearResponse
        ? `Chowdeck's answer to the order request was unclear (${unclearResponse}), but one new order, ${orderId}, now appears at this restaurant in your active Chowdeck orders`
        : `Chowdeck created order ${orderId} (POST ${ORDER_PATH} answered success)`,
    ];
    const warnings: string[] = [];
    let amount: Record<string, unknown> = { estimated_total: formatNaira(estimate) };
    let read: OrderRead | undefined;
    let status: OrderStatusReport;
    try {
      read = await readOrderState(this.orders, orderId);
      status = stateFromChowdeck(orderId, read.classification);
    } catch (error) {
      status = stateUnavailable(orderId, describeError(error));
      warnings.push("Chowdeck's order record could not be read, so its total and payment state are not confirmed yet.");
    }

    let totalMatches = false;
    if (read) {
      const amounts = orderAmounts(read.order);
      if (amounts) {
        amount = { ...amounts, ...amount };
        confirmed.push(`Chowdeck's order record shows a total of ${amounts.total}`);
        totalMatches = amounts.total_raw === estimate;
        if (!totalMatches) {
          warnings.push(
            `Chowdeck's order total (${amounts.total}) differs from ChowBot's estimate (${formatNaira(estimate)}). Tell the user Chowdeck's total before they pay.`,
          );
        }
      } else {
        warnings.push("Chowdeck's order record has no numeric total, so the amount to pay is not confirmed yet.");
      }
      for (const [field, label] of [
        ["customer_vendor_note", "restaurant note"],
        ["customer_delivery_note", "delivery note"],
      ] as const) {
        const onOrder = read.order[field];
        if (onOrder === undefined) continue;
        const sent = typeof quote.raw[field] === "string" ? (quote.raw[field] as string) : "";
        const stored = typeof onOrder === "string" ? onOrder : "";
        if (stored !== sent) {
          warnings.push(`The ${label} on Chowdeck's order (${quotedNote(stored)}) differs from the cart's (${quotedNote(sent)}).`);
        }
      }
      const listed = read.order.promo_codes;
      if (quote.promo && typeof listed === "string" && !listed.toUpperCase().includes(quote.promo.code.toUpperCase())) {
        warnings.push(`Chowdeck's order record does not list the promo code ${quote.promo.code}, so its discount is not confirmed.`);
      }
    }

    const paid = status.order_state === "payment_confirmed";
    const payForMeLink = payForMeLinkOf(data.pay_for_me_url) ?? payForMeLinkOf(read?.order.pay_for_me_url);
    const trackingLink = trackingLinkOf(data.tracking_url) ?? trackingLinkOf(read?.order.tracking_url);

    let payment: ActionReport | undefined;
    let nextStep: string;
    if (choice === "pay_for_me") {
      if (!payForMeLink) warnings.push("Chowdeck returned no pay-for-me link in the expected form; the user can share it from the Chowdeck app.");
      nextStep =
        `Give the user pay_for_me_link to share with the person who will pay (anyone with it can pay the order). Check payment later with get_order. ${CHANGE_BEFORE_PAYING} A pay-for-me link already shared can still be paid, so tell the payer which link to use.`;
    } else if (choice === "wallet") {
      if (!paid) warnings.push("Chowdeck's order record does not show the wallet payment as successful yet.");
      nextStep = paid
        ? "Tell the user the order is placed and paid from their wallet. Follow it with track_order. Do not place it again: it is paid."
        : "Do not pay this order another way or place it again yet: a wallet order is charged at creation. Check it with get_order until Chowdeck shows whether the wallet payment went through.";
    } else if (read && totalMatches) {
      payment = await this.payments.startFor(orderId, choice as SupportedPaymentChannel, read, undefined, pocketTag);
      nextStep =
        payment.outcome === "payment_link_generated"
          ? `${payment.next_step} ${CHANGE_BEFORE_PAYING}`
          : `The order exists but no payment link was generated (see payment). ${payment.next_step} ${CHANGE_BEFORE_PAYING}`;
    } else {
      nextStep = `The order exists and is unpaid; no payment was started. ${
        read ? "Show the user Chowdeck's total; if they want to pay it" : "Once get_order shows its total"
      }, call start_payment with order_id ${orderId} and payment_channel ${choice}. ${CHANGE_BEFORE_PAYING}`;
    }

    const linked = payment?.outcome === "payment_link_generated";
    return reportResult({
      action: "place_order",
      outcome: "order_created",
      message: paid
        ? `Chowdeck order ${orderId} was placed and Chowdeck's order record shows it paid.`
        : linked
          ? `Chowdeck order ${orderId} was placed. ${payment!.message}`
          : `Chowdeck order ${orderId} was placed and is not paid yet.`,
      chowdeck_confirmed: confirmed,
      status,
      amount,
      order_id: orderId,
      restaurant_id: args.restaurant_id,
      payment_channel: choice,
      ...(extras.tipRaw !== undefined && { tip: formatNaira(extras.tipRaw) }),
      ...(quote.promo && { promo_code: quote.promo.code }),
      ...(extras.gift && { gift_for: extras.gift.name }),
      ...(linked && { payment_link: payment!.payment_link }),
      ...(payment && { payment }),
      ...(trackingLink && { tracking_link: trackingLink }),
      ...(payForMeLink && { pay_for_me_link: payForMeLink }),
      ...(warnings.length > 0 && { warnings }),
      next_step: nextStep,
      outcome_uncertain: false,
      safe_to_retry: false,
    });
  }
}

type Placed = { args: PlaceOrderArgs; quote: OrderQuote; extras: Extras; estimate: number; pocketTag?: string };

export default OrderPlacementService;
