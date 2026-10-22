import {
  isRecord,
  pickScalarFields,
  type ScalarValue,
} from "../../utils/object";
import { logger } from "../../utils/logger";
import type { UserOrderSubmissions } from "../../lib/order-submissions";
import CartService, { cartFingerprint, type CartDetail } from "../carts/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import {
  CONFIG_PATH,
  formatNaira,
  tipFromNaira,
  parseTipConfig,
  validatePromoCode,
  validateGiftRecipient,
  type TipChoice,
  type TipConfig,
  type GiftRecipient,
  type GiftRecipientInput,
  PHONE_VALIDATE_PATH,
} from "./draft";
import {
  totalOff,
  discountsForCode,
  DISCOUNT_APPLY_PATH,
  discountRequestBody,
  parseAppliedDiscounts,
  type AppliedDiscount,
} from "./discounts";
import AddressService, { NotSignedInError } from "../addresses/service";
import { chowdeckAuthHeaders, type UserSession } from "../../lib/session";

const ORDER_CLASS = "delivery";
const CHECKOUT_CURRENCY = "NGN";
const CHECKOUT_COUNTRY_CODE = "NG";

const DELIVERY_AMOUNT_PATH = "/customer/delivery/amount";
export const PROMO_CODE_LIST_PATH = "/customer/promo-code";
export const DISCOUNT_LIST_PATH = "/customer/discount";
const PAYMENT_METHODS_PATH = "/customer/payment/methods";
const vendorPath = (restaurantId: number) => `/customer/vendor/${restaurantId}`;

/*
 * Observed vendor fields only. The vendor's address_id is needed for the
 * quote but is never returned.
 */
const VENDOR_FIELDS = [
  "name",
  "minimum_order_amount",
  "is_open",
  "current_is_open_state",
  "operationally_open",
  "is_closed_by_operations",
  "is_temporarily_unavailable",
] as const;

/*
 * Observed quote fields. id (the fee record), distance, vendor_id, the
 * savings fields and the quote's own minimum_order_amount (whose meaning is
 * unknown) are deliberately left out.
 */
const QUOTE_FIELDS = [
  "amount",
  "currency",
  "safety_fee",
  "service_amount",
  "small_order_amount",
  "small_order_reason",
  "final_service_amount",
  "final_delivery_amount",
] as const;

const FEE_FIELDS = [
  "label",
  "type",
  "value",
  "amount",
  "currency",
  "summary",
] as const;

const PAYMENT_METHOD_FIELDS = [
  "type",
  "pretty_name",
  "is_current_active",
] as const;

export type ComputedTotal = {
  amount: number;
  formula: string;
  source: string;
};

export type CheckoutQuoteResult = {
  cart: CartDetail;
  payment_methods_error?: string;
  computed_total: ComputedTotal | null;
  restaurant: Record<string, ScalarValue>;
  computed_total_unavailable_reason?: string;
  payment_methods: Record<string, ScalarValue>[] | null;
  quote: Record<string, ScalarValue | Record<string, ScalarValue>[]>;
  orderable: boolean;
  quote_ref?: string;
  quote_valid_until?: string;
  not_orderable_reasons?: string[];
  promo?: QuotePromo;
};

/*
 * A promo code applied in a quote: Chowdeck's discount calculation for this
 * cart with the fresh quote's fee, exactly as the website requests it.
 */
export type QuotePromo = {
  promo_code: string;
  status: "applied" | "not_applied" | "rejected" | "unconfirmed";
  detail: string;
  chowdeck_discounts?: (AppliedDiscount & { amount: string })[];
  discount?: string;
  discount_raw?: number;
  estimated_total_after_discount?: { amount: number; display: string; source: string };
};

/*
 * Observed 2026-10-22 from GET /customer/promo-code. id, user_id,
 * promo_code_id, discount_id, settings and the vendors objects are left out.
 */
const PROMO_FIELDS = [
  "code",
  "title",
  "note",
  "display_name",
  "target_service",
  "type",
  "voucher_type",
  "voucher_status",
  "is_valid",
  "expiry_time",
  "minimum_order_amount",
  "maximum_order_amount",
  "usage_count",
  "maximum_usage_count",
  "vendor_id",
] as const;

export type AccountPromo = Record<string, unknown> & { code: string; vendor_ids: number[]; listed_in: string };

export type PromoListResult = {
  promo_codes: (AccountPromo & { chowbot_check: { problems: string[]; looks_usable: boolean } })[];
  discounts: (AccountPromo & { chowbot_check: { problems: string[]; looks_usable: boolean } })[];
  basis: string[];
  errors?: string[];
};

/*
 * Payment choices whose order fields are known from the storefront code:
 * wallet sends no payment_method_id (observed methods carry no id), and
 * pay_for_me sends has_external_payment instead. "Pay online" opens a
 * sub-method picker whose shape was never observed, so it is not offered.
 */
export const PREVIEW_PAYMENT_METHODS = ["wallet", "pay_for_me"] as const;
export type PreviewPaymentMethod = (typeof PREVIEW_PAYMENT_METHODS)[number];

const WITHHELD_FEE_ID =
  "<withheld: a submission would first request a fresh delivery-fee quote, which creates a fee record, so a dry run requests none>";
const WITHHELD_ADDRESS_ID = "<withheld: your selected saved address>";
/*
 * Draft extras for a preview, from tool arguments (see ./draft.ts).
 */
export type CheckoutDraftInput = {
  promo_code?: string;
  tip?: "none" | { amount_naira: number };
  gift?: GiftRecipientInput;
};

export type OrderPreviewResult = {
  dry_run: true;
  submitted: false;
  restaurant: Record<string, ScalarValue>;
  cart: Record<string, ScalarValue>;
  validations: string[];
  payload_preview: Record<string, unknown>;
  checkout_draft: {
    confirmed_by_chowdeck: Record<string, unknown>;
    provided_by_you: Record<string, unknown>;
    not_confirmed: string[];
  };
  omitted_fields: Record<string, string>;
  not_performed: string[];
  assumptions: string[];
};

/*
 * A quote ChowBot refuses to request. Messages never include address IDs,
 * source/destination IDs or fee IDs.
 */
/*
 * Chowdeck's discount calculation for one cart with a promo code, without a
 * fee quote. code_discount is the sum of the discounts Chowdeck attributes to
 * the code (each returned discount names its promo_code).
 */
export type PromoCheckResult = {
  promo_code: string;
  status: "discount" | "no_discount" | "rejected";
  rejection?: string;
  discounts?: AppliedDiscount[];
  code_discount: number;
  total_off: number;
  cart_total: ScalarValue;
  basis: string[];
};

const isDefiniteHttpRejection = (error: unknown): error is ChowdeckApiError =>
  error instanceof ChowdeckApiError &&
  error.kind === "http" &&
  error.status !== undefined &&
  error.status < 500 &&
  error.status !== 401;

export class CheckoutRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutRefusedError";
  }
}

const isPositiveId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/*
 * Each delivery-fee request appears to create a new fee record on Chowdeck,
 * so an unknown outcome is reported as possibly having created one.
 */
const uncertainQuote = (detail: string) =>
  new ChowdeckApiError(
    "invalid_response",
    `${detail}; a delivery-fee quote may have been created on Chowdeck but could not be confirmed, so no fee or total is reported`,
  );

const isDefiniteRejection = (error: ChowdeckApiError) =>
  error.kind === "http" && error.status !== undefined && error.status < 500;

/*
 * Only explicit negative flags count as closed. operationally_open is
 * passed through but not used: only its open value (1) was observed.
 */
const isClearlyClosed = (vendor: Record<string, unknown>) =>
  vendor.is_open === false ||
  vendor.current_is_open_state === false ||
  vendor.is_closed_by_operations === true ||
  vendor.is_temporarily_unavailable === true;

const numbers = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is number => Number.isSafeInteger(v)) : [];

const parsePromoList = (body: unknown, path: string): AccountPromo[] => {
  const entries = isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
  if (!entries || !entries.every((entry) => isRecord(entry) && typeof entry.code === "string")) {
    throw new ChowdeckApiError("invalid_response", `GET ${path} returned an unexpected response shape`);
  }
  return (entries as Record<string, unknown>[]).map((entry) => ({
    ...pickScalarFields(entry, PROMO_FIELDS),
    code: entry.code as string,
    vendor_ids: numbers(entry.vendor_ids),
    listed_in: path,
  }));
};

/*
 * ChowBot's own reading of a code's fields. Only Chowdeck's discount
 * calculation decides whether it takes anything off; a minimum order is left
 * to that calculation, as what Chowdeck compares it with is unknown.
 */
export const promoProblems = (promo: AccountPromo, restaurantId?: number, now = Date.now()) => {
  const problems: string[] = [];
  if (promo.is_valid === 0 || promo.is_valid === false) problems.push("Chowdeck marks it not valid");
  if (typeof promo.expiry_time === "string") {
    const expiry = Date.parse(promo.expiry_time);
    if (!Number.isNaN(expiry) && expiry <= now) problems.push(`it expired at ${promo.expiry_time}`);
  }
  const max = promo.maximum_usage_count;
  const used = promo.usage_count;
  if (typeof max === "number" && max > 0 && typeof used === "number" && used >= max) {
    problems.push("it has been used the maximum number of times");
  }
  const vendors = [...promo.vendor_ids, ...(typeof promo.vendor_id === "number" ? [promo.vendor_id] : [])];
  if (restaurantId !== undefined && vendors.length > 0 && !vendors.includes(restaurantId)) {
    problems.push("it is limited to other restaurants");
  }
  return problems;
};

class CheckoutService {
  private readonly carts: CartService;
  private readonly addresses: AddressService;

  constructor(
    private readonly session: UserSession,
    private readonly client = new ChowdeckClient(),
    private readonly submissions?: UserOrderSubmissions,
  ) {
    this.carts = new CartService(session, client);
    this.addresses = new AddressService(session, client);
  }

  private async authHeaders() {
    const headers = await chowdeckAuthHeaders(this.session);
    if (!headers.authorization) throw new NotSignedInError();
    return headers;
  }

  private async vendorDetails(restaurantId: number) {
    const path = vendorPath(restaurantId);
    const body = await this.client.request(path, {
      headers: await this.authHeaders(),
    });
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const idMatches = data?.id === undefined || data.id === restaurantId;
    if (!data || !idMatches || !isPositiveId(data.address_id)) {
      throw new ChowdeckApiError(
        "invalid_response",
        `GET ${path} returned an unexpected response shape`,
      );
    }
    return { sourceId: data.address_id, fields: data };
  }

  private async requestQuote(body: Record<string, unknown>) {
    let response: unknown;
    try {
      response = await this.client.request(DELIVERY_AMOUNT_PATH, {
        method: "POST",
        headers: await this.authHeaders(),
        body,
      });
    } catch (error) {
      if (error instanceof ChowdeckApiError && !isDefiniteRejection(error)) {
        throw uncertainQuote(error.message);
      }
      throw error;
    }

    const data =
      isRecord(response) &&
      response.status === "success" &&
      isRecord(response.data)
        ? response.data
        : undefined;
    if (
      !data ||
      !isAmount(data.final_delivery_amount) ||
      !isAmount(data.final_service_amount)
    ) {
      throw uncertainQuote(
        `POST ${DELIVERY_AMOUNT_PATH} returned an unexpected response`,
      );
    }
    return data;
  }

  private async paymentMethods(amount: number) {
    try {
      const body = await this.client.request(PAYMENT_METHODS_PATH, {
        headers: await this.authHeaders(),
        query: {
          currency: CHECKOUT_CURRENCY,
          order_class: ORDER_CLASS,
          amount,
        },
      });
      const methods =
        isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
      if (
        !methods ||
        !methods.every((m) => isRecord(m) && typeof m.type === "string")
      ) {
        return {
          error: `GET ${PAYMENT_METHODS_PATH} returned an unexpected response shape`,
        };
      }
      return {
        methods: (methods as Record<string, unknown>[]).map((m) =>
          pickScalarFields(m, PAYMENT_METHOD_FIELDS),
        ),
      };
    } catch (error) {
      return {
        error:
          error instanceof ChowdeckApiError
            ? error.message
            : "unexpected error",
      };
    }
  }

  /*
   * Everything the quote is built from comes from the signed-in user's own
   * data: their cart (and its ID), one of their saved addresses, and the
   * restaurant's own address as the source. The delivery-fee request is
   * sent at most once and never retried. Its fee ID is not returned or
   * stored.
   */
  async getQuote(
    restaurantId: number,
    addressId: number,
    promoInput?: string,
  ): Promise<CheckoutQuoteResult> {
    let promoCode: string | undefined;
    if (promoInput !== undefined) {
      const checked = validatePromoCode(promoInput);
      if (!checked.ok) throw new CheckoutRefusedError(`the promo code ${checked.error}`);
      promoCode = checked.value;
    }
    const { cart, raw, vendor, restaurant } = await this.validateCheckout(
      restaurantId,
      addressId,
    );
    const total = cart.total_price;
    /*
     * Everything that can refuse the promo code without Chowdeck's
     * calculation runs before the fee quote, which creates a fee record.
     */
    if (promoCode) {
      await this.refuseSecondOrderForPromo(restaurantId);
      promoCode = await this.accountPromoCode(promoCode, restaurantId);
    }

    const quoteData = await this.requestQuote({
      destination_id: addressId,
      order_class: ORDER_CLASS,
      source_id: vendor.sourceId,
      vendor_id: restaurantId,
      currency: CHECKOUT_CURRENCY,
      country_code: CHECKOUT_COUNTRY_CODE,
      cart_id: cart.id,
    });

    const result = await this.buildQuoteResult(cart, restaurant, quoteData, total);
    if (promoCode) {
      result.promo = await this.applyPromo(promoCode, {
        raw,
        restaurantId,
        addressId,
        orderClass: vendor.fields.self_delivery === true ? "vendor_delivery" : ORDER_CLASS,
        feeId: quoteData.id,
        deliveryFee: quoteData.final_delivery_amount as number,
        computedTotal: result.computed_total,
      });
    }
    return this.recordOrderableQuote(result, {
      restaurantId,
      addressId,
      cart,
      raw,
      vendorCurrency: vendor.fields.currency,
      feeId: quoteData.id,
    });
  }

  /*
   * A promo code cannot be added to an order that already exists, and
   * ChowBot never creates a second order just to apply one.
   */
  private async refuseSecondOrderForPromo(restaurantId: number) {
    if (!this.submissions) return;
    const open = (await this.submissions.listOpen(restaurantId)).filter((attempt) =>
      ["submitting", "unknown", "created"].includes(attempt.state),
    );
    if (open.length === 0) return;
    const ids = open.map((attempt) => (attempt.chowdeckOrderId ? `order ${attempt.chowdeckOrderId}` : `attempt ${attempt.id}`));
    throw new CheckoutRefusedError(
      `you already have an unpaid or unresolved order from this restaurant (${ids.join(", ")}). A promo code cannot be added to an order that was already created, and ChowBot does not create a second order just to apply one. Pay that order with start_payment, cancel it with cancel_order if it is unpaid, or check it with get_order_submission first`,
    );
  }

  /*
   * The website only submits codes already on the account (it redeems a new
   * code first), so ChowBot applies only a code listed there, in the exact
   * case Chowdeck lists it. Redeeming a new code is not supported.
   */
  private async accountPromoCode(code: string, restaurantId: number) {
    const lists = await this.readPromoLists();
    const all = [...lists.promoCodes, ...lists.discounts];
    const match = all.find((promo) => String(promo.code).toUpperCase() === code.toUpperCase());
    if (!match) {
      if (lists.errors.length > 0) {
        throw new CheckoutRefusedError(
          `ChowBot could not check the promo code ${code} against your account (${lists.errors.join("; ")}); no fee quote was requested`,
        );
      }
      throw new CheckoutRefusedError(
        `the promo code ${code} is not on your Chowdeck account. Add it in the Chowdeck app first (ChowBot does not redeem new codes), or call list_promo_codes to see the codes you have`,
      );
    }
    const problems = promoProblems(match, restaurantId);
    if (problems.length > 0) {
      throw new CheckoutRefusedError(`the promo code ${match.code} cannot be used: ${problems.join("; ")} (from Chowdeck's promo code list)`);
    }
    return String(match.code);
  }

  private async readPromoLists() {
    const headers = await this.authHeaders();
    const errors: string[] = [];
    const read = async (path: string) => {
      try {
        return parsePromoList(await this.client.request(path, { headers }), path);
      } catch (error) {
        if (error instanceof NotSignedInError) throw error;
        errors.push(error instanceof ChowdeckApiError ? error.message : `GET ${path} failed`);
        return [];
      }
    };
    const promoCodes = await read(PROMO_CODE_LIST_PATH);
    const discounts = await read(DISCOUNT_LIST_PATH);
    return { promoCodes, discounts, errors };
  }

  /*
   * The signed-in user's promo codes and discounts (vouchers), read-only.
   * Each carries ChowBot's reading of its fields; only Chowdeck's discount
   * calculation in get_checkout_quote confirms a discount.
   */
  async listPromoCodes(restaurantId?: number): Promise<PromoListResult> {
    const lists = await this.readPromoLists();
    if (lists.errors.length === 2) {
      throw new ChowdeckApiError("invalid_response", `neither promo list could be read (${lists.errors.join("; ")})`);
    }
    const annotate = (promo: AccountPromo) => {
      const problems = promoProblems(promo, restaurantId);
      return { ...promo, chowbot_check: { problems, looks_usable: problems.length === 0 } };
    };
    return {
      promo_codes: lists.promoCodes.map(annotate),
      discounts: lists.discounts.map(annotate),
      basis: [
        `promo_codes from GET ${PROMO_CODE_LIST_PATH}; discounts (vouchers) from GET ${DISCOUNT_LIST_PATH}, whose entries have only been observed empty`,
        "chowbot_check is ChowBot's reading of validity, expiry, usage and restaurant limits; it is not a promise of a discount",
        "a minimum order amount is left to Chowdeck's calculation; amounts are raw Chowdeck values (divide by 100 for naira)",
        "to apply one, call get_checkout_quote with promo_code: Chowdeck's calculation then gives the discount, which is shown before ordering",
      ],
      ...(lists.errors.length > 0 && { errors: lists.errors }),
    };
  }

  /*
   * Chowdeck's discount calculation with the code and the fresh quote's fee,
   * as the website sends it. The code counts as applied only when Chowdeck
   * returns a discount carrying that promo_code. Sent once, never retried.
   */
  private async applyPromo(
    code: string,
    input: {
      raw: Record<string, unknown>;
      restaurantId: number;
      addressId: number;
      orderClass: string;
      feeId: unknown;
      deliveryFee: number;
      computedTotal: ComputedTotal | null;
    },
  ): Promise<QuotePromo> {
    if (!isPositiveId(input.feeId)) {
      return { promo_code: code, status: "unconfirmed", detail: "Chowdeck returned no usable delivery-fee record, so the discount calculation was not requested" };
    }
    let discounts: AppliedDiscount[];
    try {
      ({ discounts } = await this.calculateDiscounts({
        raw: input.raw,
        vendorId: input.restaurantId,
        addressId: input.addressId,
        orderClass: input.orderClass,
        promoCode: code,
        fee: { id: input.feeId, deliveryFee: input.deliveryFee },
      }));
    } catch (error) {
      if (isDefiniteHttpRejection(error)) {
        return { promo_code: code, status: "rejected", detail: `Chowdeck refused the promo code (${error.message})` };
      }
      return {
        promo_code: code,
        status: "unconfirmed",
        detail: `Chowdeck's discount calculation could not be read (${error instanceof ChowdeckApiError ? error.message : "unexpected error"})`,
      };
    }
    const shown = discounts.map((d) => ({ ...d, amount: formatNaira(d.amount_off + d.bogof_amount_off) }));
    const forCode = discountsForCode(discounts, code);
    const off = totalOff(discounts);
    if (forCode.length === 0 || totalOff(forCode) <= 0) {
      return {
        promo_code: code,
        status: "not_applied",
        detail: "Chowdeck's discount calculation returned no discount for this code on this cart (for example, its minimum order may not be met)",
        chowdeck_discounts: shown,
      };
    }
    const after = input.computedTotal ? input.computedTotal.amount - off : undefined;
    return {
      promo_code: code,
      status: "applied",
      detail: "Chowdeck's discount calculation (POST /customer/discount/apply) returned this discount for the code with this quote's delivery fee",
      chowdeck_discounts: shown,
      discount: formatNaira(off),
      discount_raw: off,
      ...(after !== undefined &&
        after > 0 && {
          estimated_total_after_discount: {
            amount: after,
            display: formatNaira(after),
            source:
              "ChowBot's arithmetic: computed_total minus the discounts Chowdeck's calculation returned, as the Chowdeck website displays it. The amount to pay is read from Chowdeck's order record before payment.",
          },
        }),
    };
  }

  /*
   * A quote becomes orderable only when every value a submission needs is
   * confidently known and its durable record has been saved. Otherwise it
   * stays informational: no quote_ref, no record. The fee id is stored
   * internally and never returned.
   */
  private async recordOrderableQuote(
    result: CheckoutQuoteResult,
    context: {
      restaurantId: number;
      addressId: number;
      cart: CartDetail;
      raw: Record<string, unknown>;
      vendorCurrency: unknown;
      feeId: unknown;
    },
  ): Promise<CheckoutQuoteResult> {
    const { cart, raw } = context;
    const reasons: string[] = [];
    if (!this.submissions) reasons.push("ordering is only available on the hosted ChowBot server");
    if (!result.computed_total) reasons.push("no total could be computed confidently");
    if (!isPositiveId(context.feeId)) reasons.push("Chowdeck returned no usable delivery-fee record");
    if (!isPositiveId(cart.id)) reasons.push("the cart has no usable id");
    if (!isAmount(raw.bag_quantity)) reasons.push("the cart has no numeric bag_quantity");
    if (context.vendorCurrency !== undefined && context.vendorCurrency !== CHECKOUT_CURRENCY) {
      reasons.push(`only ${CHECKOUT_CURRENCY} orders are supported`);
    }
    const promo = result.promo;
    if (promo && (promo.status !== "applied" || promo.discount_raw === undefined || !promo.estimated_total_after_discount)) {
      reasons.push(
        `the promo code ${promo.promo_code} was not confirmed by Chowdeck (${promo.detail}); call get_checkout_quote without promo_code to order without it`,
      );
    }
    if (reasons.length > 0 || !this.submissions || !result.computed_total) {
      return { ...result, orderable: false, not_orderable_reasons: reasons };
    }

    try {
      const saved = await this.submissions.createQuote({
        vendorId: context.restaurantId,
        cartId: cart.id as number,
        feeId: context.feeId as number,
        addressId: context.addressId,
        cartFingerprint: cartFingerprint(cart),
        computedTotal: result.computed_total.amount,
        ...(promo?.discount_raw !== undefined && { promo: { code: promo.promo_code, discount: promo.discount_raw } }),
      });
      /*
       * Older unclaimed quotes for this cart can no longer be confirmed, so a
       * stale total (with or without a discount) is never ordered.
       */
      await this.submissions.supersedeQuotes(cart.id as number, saved.id);
      return {
        ...result,
        orderable: true,
        quote_ref: saved.id,
        quote_valid_until: saved.quoteExpiresAt.toISOString(),
      };
    } catch (error) {
      logger.error(
        "Saving an orderable checkout quote failed:",
        error instanceof Error ? error.name : typeof error,
      );
      return {
        ...result,
        orderable: false,
        not_orderable_reasons: ["the quote could not be saved for ordering"],
      };
    }
  }

  /*
   * Checks shared by the quote and the order preview, in the order the
   * website applies them: the user's own valid cart, one of their saved
   * addresses, an open restaurant, and the restaurant's minimum order.
   * Only GET requests are made.
   */
  private async validateCheckout(restaurantId: number, addressId: number) {
    const snapshot = await this.carts.getVendorCartSnapshot(restaurantId);
    const cartResult = snapshot.result;
    if (!cartResult.exists) {
      throw new CheckoutRefusedError("there is no cart for this restaurant");
    }
    const { cart } = cartResult;
    if (cart.is_valid === false || cart.validation_issues.length > 0) {
      throw new CheckoutRefusedError(
        `the cart is not valid for checkout; validation issues: ${JSON.stringify(cart.validation_issues)}`,
      );
    }

    const { addresses } = await this.addresses.list();
    if (!addresses.some((address) => address.id === addressId)) {
      throw new CheckoutRefusedError(
        "address_id is not one of your saved delivery addresses; call list_addresses to choose one",
      );
    }

    const vendor = await this.vendorDetails(restaurantId);
    const restaurant = {
      id: restaurantId,
      ...pickScalarFields(vendor.fields, VENDOR_FIELDS),
    };
    if (isClearlyClosed(vendor.fields)) {
      throw new CheckoutRefusedError("this restaurant is currently closed");
    }

    const minimum = vendor.fields.minimum_order_amount;
    const total = cart.total_price;
    if (isAmount(minimum) && isAmount(total) && total < minimum) {
      throw new CheckoutRefusedError(
        `the cart total_price (${total}) is below this restaurant's minimum_order_amount (${minimum}); both are raw Chowdeck amounts`,
      );
    }

    return { cart, raw: snapshot.raw ?? {}, vendor, restaurant };
  }

  /*
   * For order placement: exactly the checks a quote applies, without
   * requesting a quote. Only GET requests.
   */
  validateForOrder(restaurantId: number, addressId: number) {
    return this.validateCheckout(restaurantId, addressId);
  }

  /*
   * The pre-order validation gate the website sends before creating an
   * order: one fresh delivery-fee quote, never retried. Its fee id is
   * discarded; the order uses the quote the user confirmed. A 4xx is
   * rethrown as Chowdeck's rejection; anything else comes back as an
   * uncertain-outcome error.
   */
  async requestGateQuote(
    restaurantId: number,
    addressId: number,
    cartId: unknown,
    sourceId: number,
  ) {
    await this.requestQuote({
      destination_id: addressId,
      order_class: ORDER_CLASS,
      source_id: sourceId,
      vendor_id: restaurantId,
      currency: CHECKOUT_CURRENCY,
      country_code: CHECKOUT_COUNTRY_CODE,
      cart_id: cartId,
    });
  }

  private async buildQuoteResult(
    cart: CartDetail,
    restaurant: Record<string, ScalarValue>,
    quoteData: Record<string, unknown>,
    total: unknown,
  ): Promise<CheckoutQuoteResult> {
    const quote: CheckoutQuoteResult["quote"] = pickScalarFields(
      quoteData,
      QUOTE_FIELDS,
    );
    if (Array.isArray(quoteData.additional_order_fees)) {
      quote.additional_order_fees = quoteData.additional_order_fees
        .filter(isRecord)
        .map((fee) => pickScalarFields(fee, FEE_FIELDS));
    }

    /*
     * Chowdeck returns no grand total. The website's payment-methods lookup
     * used cart total + final delivery + final service, which matched the
     * total it displayed. small_order_amount and safety_fee were 0 then, so
     * how they combine is unknown and no total is computed when either isn't.
     */
    const extrasAreZero = [
      quoteData.small_order_amount,
      quoteData.safety_fee,
    ].every((value) => value === undefined || value === null || value === 0);
    const computedTotal =
      isAmount(total) && extrasAreZero
        ? {
            amount:
              total +
              (quoteData.final_delivery_amount as number) +
              (quoteData.final_service_amount as number),
            formula:
              "cart.total_price + quote.final_delivery_amount + quote.final_service_amount",
            source:
              "computed by ChowBot from raw Chowdeck amounts; not a total returned by Chowdeck",
          }
        : null;

    const result: CheckoutQuoteResult = {
      restaurant,
      cart,
      quote,
      orderable: false,
      computed_total: computedTotal,
      payment_methods: null,
    };
    if (!computedTotal) {
      result.computed_total_unavailable_reason = isAmount(total)
        ? "small_order_amount or safety_fee is non-zero, and how Chowdeck combines them is unknown"
        : "the cart has no numeric total_price";
      result.payment_methods_error =
        "payment methods were not looked up because no total could be computed";
      return result;
    }

    const lookup = await this.paymentMethods(computedTotal.amount);
    if (lookup.methods) {
      result.payment_methods = lookup.methods;
    } else {
      result.payment_methods_error = `payment methods could not be retrieved (${lookup.error}); the quote above is still valid`;
    }
    return result;
  }

  /*
   * Builds the normal cart-based delivery order the storefront would send,
   * without sending it. Only GET requests are made: no delivery-fee quote,
   * no order, no payment and no cart change. Private values in the payload
   * are replaced by placeholders.
   */
  /*
   * Chowdeck's tip limits, or undefined when they cannot be read.
   */
  async readTipConfig(): Promise<TipConfig | undefined> {
    try {
      return parseTipConfig(await this.client.request(CONFIG_PATH, { headers: await this.authHeaders() }));
    } catch {
      return undefined;
    }
  }

  /*
   * The website's check of a gift recipient's phone:
   * POST /auth/phone/validate {phone, country_code} and data.is_valid. Only
   * an explicit true passes; anything else stops the gift.
   */
  async validateGiftPhone(gift: GiftRecipient) {
    let body: unknown;
    try {
      body = await this.client.request(PHONE_VALIDATE_PATH, {
        method: "POST",
        headers: await this.authHeaders(),
        body: { phone: gift.phone, country_code: gift.country_code },
      });
    } catch (error) {
      throw new CheckoutRefusedError(
        `the gift recipient's phone could not be checked with Chowdeck (${error instanceof ChowdeckApiError ? error.message : "unexpected error"})`,
      );
    }
    const valid = isRecord(body) && isRecord(body.data) ? body.data.is_valid : undefined;
    if (valid === true) return;
    throw new CheckoutRefusedError(
      valid === false
        ? "Chowdeck says the gift recipient's phone number is not valid for that country"
        : `POST ${PHONE_VALIDATE_PATH} returned an unexpected response, so the gift recipient's phone is unchecked`,
    );
  }

  /*
   * One discount calculation for a cart, as the website requests it.
   */
  async calculateDiscounts(input: {
    raw: Record<string, unknown>;
    vendorId: number;
    addressId: number;
    orderClass: string;
    promoCode?: string;
    fee?: { id: number; deliveryFee: number };
  }) {
    const body = await this.client.request(DISCOUNT_APPLY_PATH, {
      method: "POST",
      headers: await this.authHeaders(),
      body: discountRequestBody({ ...input, cart: input.raw }),
    });
    if (isRecord(body) && body.status !== undefined && body.status !== "success") {
      throw new ChowdeckApiError(
        "invalid_response",
        `POST ${DISCOUNT_APPLY_PATH} answered status ${String(body.status)}${typeof body.message === "string" ? `: ${body.message}` : ""}`,
      );
    }
    const discounts = parseAppliedDiscounts(body);
    return { discounts, total_off: totalOff(discounts) };
  }

  /*
   * Runs Chowdeck's discount calculation for the cart with the code, without
   * a fee quote. A 4xx for the code is Chowdeck refusing it, reported
   * verbatim. Nothing is retried; an unclear result is an error.
   */
  async promoCheck(
    checked: { raw: Record<string, unknown>; vendorId: number; addressId: number; orderClass: string; cartTotal: ScalarValue },
    promoCode: string,
  ): Promise<PromoCheckResult> {
    const basis = [
      "Chowdeck's discount calculation (POST /customer/discount/apply), requested as the Chowdeck website builds it; this is a calculation, not a guarantee",
      "no fee quote was requested, so discounts on delivery fees (such as free delivery) are not included; get_checkout_quote with promo_code includes them",
      "code_discount is the sum of the discounts Chowdeck attributes to this code",
    ];
    let result;
    try {
      result = await this.calculateDiscounts({ ...checked, promoCode });
    } catch (error) {
      if (isDefiniteHttpRejection(error)) {
        return { promo_code: promoCode, status: "rejected", rejection: error.message, code_discount: 0, total_off: 0, cart_total: checked.cartTotal, basis };
      }
      throw error;
    }
    const codeDiscount = totalOff(discountsForCode(result.discounts, promoCode));
    return {
      promo_code: promoCode,
      status: codeDiscount > 0 ? "discount" : "no_discount",
      discounts: result.discounts,
      code_discount: codeDiscount,
      total_off: result.total_off,
      cart_total: checked.cartTotal,
      basis,
    };
  }

  async checkPromoCode(restaurantId: number, addressId: number, input: string): Promise<PromoCheckResult> {
    const code = validatePromoCode(input);
    if (!code.ok) throw new CheckoutRefusedError(`the promo code ${code.error}`);
    const { cart, raw, vendor } = await this.validateCheckout(restaurantId, addressId);
    if (cart.packs.length === 0) throw new CheckoutRefusedError("the cart has no items");
    return this.promoCheck(
      {
        raw,
        vendorId: restaurantId,
        addressId,
        orderClass: vendor.fields.self_delivery === true ? "vendor_delivery" : ORDER_CLASS,
        cartTotal: (cart.total_price ?? null) as ScalarValue,
      },
      code.value,
    );
  }

  async previewOrder(
    restaurantId: number,
    addressId: number,
    paymentMethod: PreviewPaymentMethod,
    draft: CheckoutDraftInput = {},
  ): Promise<OrderPreviewResult> {
    // Draft values are checked before anything is asked of Chowdeck.
    let promoCode: string | undefined;
    if (draft.promo_code !== undefined) {
      const checked = validatePromoCode(draft.promo_code);
      if (!checked.ok) throw new CheckoutRefusedError(`the promo code ${checked.error}`);
      promoCode = checked.value;
    }
    let gift: GiftRecipient | undefined;
    if (draft.gift !== undefined) {
      const checked = validateGiftRecipient(draft.gift);
      if (!checked.ok) throw new CheckoutRefusedError(`the gift recipient's ${checked.error}`);
      gift = checked.value;
    }
    if (typeof draft.tip === "object") {
      const pre = tipFromNaira(draft.tip.amount_naira, { available: true, minimum: 0, maximum: 0 });
      if (!pre.ok) throw new CheckoutRefusedError(`the tip ${pre.error}`);
    }

    const { cart, raw, vendor, restaurant } = await this.validateCheckout(
      restaurantId,
      addressId,
    );
    if (cart.packs.length === 0) {
      throw new CheckoutRefusedError("the cart has no items");
    }

    const vendorCurrency = vendor.fields.currency;
    if (vendorCurrency !== undefined && vendorCurrency !== CHECKOUT_CURRENCY) {
      throw new CheckoutRefusedError(
        `only ${CHECKOUT_CURRENCY} orders can be previewed; this restaurant uses a different currency`,
      );
    }

    const orderClass =
      vendor.fields.self_delivery === true ? "vendor_delivery" : ORDER_CLASS;

    /*
     * A tip amount is checked against Chowdeck's own limits, read only when
     * one is given. "none", 0, or no tip argument all send no tip.
     */
    let tip: TipChoice;
    let tipLimits: Record<string, unknown> | undefined;
    if (typeof draft.tip === "object" && Math.round(draft.tip.amount_naira * 100) !== 0) {
      const config = await this.readTipConfig();
      const checked = tipFromNaira(draft.tip.amount_naira, config);
      if (!checked.ok) throw new CheckoutRefusedError(`the tip ${checked.error}`);
      tip = checked.value;
      if (config) {
        tipLimits = {
          minimum: formatNaira(config.minimum),
          maximum: config.maximum > 0 ? formatNaira(config.maximum) : "none set",
          source: `GET ${CONFIG_PATH}`,
        };
      }
    } else {
      tip = {
        kind: "none",
        reason:
          typeof draft.tip === "object"
            ? "a tip of 0 is no tip"
            : draft.tip === "none"
              ? "you chose no tip"
              : "no tip was chosen; ChowBot never adds one",
      };
    }

    // The notes are sent exactly as stored on the cart, as the website does.
    const vendorNote = raw.customer_vendor_note ?? null;
    const deliveryNote = raw.customer_delivery_note ?? null;

    if (gift) await this.validateGiftPhone(gift);

    /*
     * A promo code is shown in the payload only when Chowdeck's discount
     * calculation attributes a discount to it, the same rule a quote applies.
     */
    let promo: PromoCheckResult | undefined;
    if (promoCode) {
      promo = await this.promoCheck(
        { raw, vendorId: restaurantId, addressId, orderClass, cartTotal: (cart.total_price ?? null) as ScalarValue },
        promoCode,
      );
    }
    const submittedPromo = promo?.status === "discount" ? promo.promo_code : undefined;

    const payload: Record<string, unknown> = {
      source: "web",
      vendor_id: restaurantId,
      cart_id: cart.id,
      checkout_from_cart: true,
      class: orderClass,
      payment_method: paymentMethod,
      ...(paymentMethod === "pay_for_me" && { has_external_payment: true }),
      promo_codes: submittedPromo ? [submittedPromo] : [],
      customer_vendor_note: vendorNote,
      customer_delivery_note: deliveryNote,
      ...(isAmount(raw.bag_quantity) && { bag_quantity: raw.bag_quantity }),
      requires_delivery_pin: true,
      fee_id: WITHHELD_FEE_ID,
      address_id: WITHHELD_ADDRESS_ID,
      split_payment_with_wallet: false,
      gift_recipient: gift ?? null,
      country_code: CHECKOUT_COUNTRY_CODE,
      currency: CHECKOUT_CURRENCY,
      ...(tip.kind === "amount" && { tip: tip.raw }),
    };

    const omitted: Record<string, string> = {
      payment_method_id:
        paymentMethod === "pay_for_me"
          ? "replaced by has_external_payment for pay_for_me"
          : "not sent for wallet: the payment methods Chowdeck lists carry no id",
      ...(tip.kind === "none" && { tip: `${tip.reason}, so tip is left out, as the website does` }),
    };
    if (!isAmount(raw.bag_quantity)) {
      omitted.bag_quantity = "the cart has no numeric bag_quantity";
    }

    return {
      dry_run: true,
      submitted: false,
      restaurant,
      cart: {
        id: cart.id as ScalarValue,
        total_price: (cart.total_price ?? null) as ScalarValue,
        currency: (cart.currency ?? null) as ScalarValue,
        pack_count: cart.packs.length,
      },
      validations: [
        "you are signed in to Chowdeck",
        "a cart exists for this restaurant and belongs to it",
        "the cart is valid and has items",
        "address_id is one of your saved delivery addresses",
        "the restaurant is not marked closed",
        "the cart total meets the restaurant's minimum order",
        `the restaurant's currency is ${CHECKOUT_CURRENCY}`,
        `${paymentMethod} is a supported payment choice`,
      ],
      payload_preview: payload,
      checkout_draft: {
        confirmed_by_chowdeck: {
          cart_total: (cart.total_price ?? null) as ScalarValue,
          restaurant_note_on_cart: vendorNote,
          delivery_note_on_cart: deliveryNote,
          ...(tipLimits && { tip_limits: tipLimits }),
          ...(promo && { discount_calculation: promo }),
          ...(gift && { gift_phone: "valid (POST /auth/phone/validate returned is_valid: true)" }),
        },
        provided_by_you: {
          promo_code: promoCode ?? null,
          tip: tip.kind === "amount" ? { amount: tip.display, raw: tip.raw } : "none",
          gift_recipient: gift ?? null,
        },
        not_confirmed: [
          "delivery and service fees: no quote is requested in a preview; use get_checkout_quote",
          ...(promo
            ? [
                promo.status === "discount"
                  ? `promo code ${promo.promo_code}: Chowdeck's calculation shows ${formatNaira(promo.code_discount)} off the items; the discount is only final in Chowdeck's order record`
                  : promo.status === "rejected"
                    ? `promo code ${promo.promo_code}: Chowdeck refused it (${promo.rejection}), so it would not be submitted`
                    : `promo code ${promo.promo_code}: Chowdeck's calculation shows no discount, so it would not be submitted`,
                "a preview does not apply the code: to order with it, call get_checkout_quote with promo_code, which checks it is on your account and runs Chowdeck's calculation with the delivery fee",
              ]
            : []),
          ...(tip.kind === "amount" ? [`the ${tip.display} tip would be added on top of the quoted total`] : []),
        ],
      },
      omitted_fields: omitted,
      not_performed: [
        "no delivery-fee quote was requested (it would create a fee record on Chowdeck)",
        "no order was created",
        "no payment was started",
        "the cart was not changed",
      ],
      assumptions: [
        "the payload copies the Chowdeck website's code; the server's required fields have never been observed",
        "the server is assumed to build the order from the stored cart (checkout_from_cart), so no items or prices are sent",
        "a submission would need a fresh delivery-fee quote first; whether Chowdeck accepts an older fee_id is unknown",
        "splitting with the wallet is left off",
        "the notes are copied from your cart as Chowdeck stores them; set them with set_cart_notes",
      ],
    };
  }
}

export default CheckoutService;
