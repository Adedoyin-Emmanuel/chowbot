import {
  isRecord,
  pickScalarFields,
  type ScalarValue,
} from "../../utils/object";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import CartService, { type CartDetail } from "../carts/service";
import {
  CONFIG_PATH,
  formatNaira,
  parseTipConfig,
  validatePromoCode,
  type TipConfig,
  type GiftRecipient,
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

export const WALLET_PATH = "/customer/wallet";
export const DISCOUNT_LIST_PATH = "/customer/discount";
const PAYMENT_METHODS_PATH = "/customer/payment/methods";
const DELIVERY_AMOUNT_PATH = "/customer/delivery/amount";
export const PROMO_CODE_LIST_PATH = "/customer/promo-code";
export const BENEFICIARY_PATH = "/customer/beneficiary";

// The user's saved gift recipients (captured: GET /customer/beneficiary).
const BENEFICIARY_FIELDS = ["id", "full_name", "phone", "email", "country_code", "type"] as const;
const vendorPath = (restaurantId: number) => `/customer/vendor/${restaurantId}`;

// The vendor's address_id is needed for the quote but is never returned.
const VENDOR_FIELDS = [
  "name",
  "minimum_order_amount",
  "is_open",
  "current_is_open_state",
  "operationally_open",
  "is_closed_by_operations",
  "is_temporarily_unavailable",
] as const;

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
  orderable: boolean;
  promo?: QuotePromo;
  payment_methods_error?: string;
  not_orderable_reasons?: string[];
  computed_total: ComputedTotal | null;
  restaurant: Record<string, ScalarValue>;
  computed_total_unavailable_reason?: string;
  payment_methods: Record<string, ScalarValue>[] | null;
  quote: Record<string, ScalarValue | Record<string, ScalarValue>[]>;
  checkout_details?: CheckoutDetails;
};

/*
 * What the order would carry as things stand, and what the user has not
 * been asked about yet. There is no checkout screen, so the assistant walks
 * the user through these before placing the order.
 */
export type CheckoutDetails = {
  restaurant_note: string | null;
  rider_note: string | null;
  brown_bags: number;
  promo_code: string | null;
  ask_the_user_about: string[];
};

const noteOf = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

const checkoutDetailsOf = (raw: Record<string, unknown>, promoCode: string | undefined): CheckoutDetails => ({
  restaurant_note: noteOf(raw.customer_vendor_note),
  rider_note: noteOf(raw.customer_delivery_note),
  brown_bags: typeof raw.bag_quantity === "number" ? raw.bag_quantity : 0,
  promo_code: promoCode ?? null,
  ask_the_user_about: [
    "a note for the restaurant (set_cart_notes)",
    "a note for the rider (set_cart_notes)",
    "a tip for the rider, or none (place_order tip)",
    "a promo code or voucher (list_promo_codes, then get_checkout_quote with promo_code)",
    "brown bags (set_cart_bags)",
    "whether it is a gift, e.g. for a saved beneficiary (list_beneficiaries)",
    "how to pay: an online channel, wallet or pay for me (place_order payment_channel)",
  ],
});

export type QuotePromo = {
  detail: string;
  discount?: string;
  promo_code: string;
  discount_raw?: number;
  estimated_total_after_discount?: {
    amount: number;
    display: string;
    source: string;
  };
  status: "applied" | "not_applied" | "rejected" | "unconfirmed";
  chowdeck_discounts?: (AppliedDiscount & { amount: string })[];
};

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

export type AccountPromo = Record<string, unknown> & {
  code: string;
  vendor_ids: number[];
  listed_in: string;
};

export type PromoListResult = {
  promo_codes: (AccountPromo & {
    chowbot_check: { problems: string[]; looks_usable: boolean };
  })[];
  discounts: (AccountPromo & {
    chowbot_check: { problems: string[]; looks_usable: boolean };
  })[];
  basis: string[];
  errors?: string[];
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

// Each delivery-fee request appears to create a fee record on Chowdeck.
const uncertainQuote = (detail: string) =>
  new ChowdeckApiError(
    "invalid_response",
    `${detail}; a delivery-fee quote may have been created on Chowdeck but could not be confirmed, so no fee or total is reported`,
  );

const isDefiniteRejection = (error: ChowdeckApiError) =>
  error.kind === "http" && error.status !== undefined && error.status < 500;

// Only explicit negative flags count as closed.
const isClearlyClosed = (vendor: Record<string, unknown>) =>
  vendor.is_open === false ||
  vendor.current_is_open_state === false ||
  vendor.is_closed_by_operations === true ||
  vendor.is_temporarily_unavailable === true;

const numbers = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((v): v is number => Number.isSafeInteger(v))
    : [];

const parsePromoList = (body: unknown, path: string): AccountPromo[] => {
  const entries =
    isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
  if (
    !entries ||
    !entries.every((entry) => isRecord(entry) && typeof entry.code === "string")
  ) {
    throw new ChowdeckApiError(
      "invalid_response",
      `GET ${path} returned an unexpected response shape`,
    );
  }
  return (entries as Record<string, unknown>[]).map((entry) => ({
    ...pickScalarFields(entry, PROMO_FIELDS),
    code: entry.code as string,
    vendor_ids: numbers(entry.vendor_ids),
    listed_in: path,
  }));
};

// Only Chowdeck's discount calculation decides whether a code takes anything off.
export const promoProblems = (
  promo: AccountPromo,
  restaurantId?: number,
  now = Date.now(),
) => {
  const problems: string[] = [];
  if (promo.is_valid === 0 || promo.is_valid === false)
    problems.push("Chowdeck marks it not valid");
  if (typeof promo.expiry_time === "string") {
    const expiry = Date.parse(promo.expiry_time);
    if (!Number.isNaN(expiry) && expiry <= now)
      problems.push(`it expired at ${promo.expiry_time}`);
  }
  const max = promo.maximum_usage_count;
  const used = promo.usage_count;
  if (
    typeof max === "number" &&
    max > 0 &&
    typeof used === "number" &&
    used >= max
  ) {
    problems.push("it has been used the maximum number of times");
  }
  const vendors = [
    ...promo.vendor_ids,
    ...(typeof promo.vendor_id === "number" ? [promo.vendor_id] : []),
  ];
  if (
    restaurantId !== undefined &&
    vendors.length > 0 &&
    !vendors.includes(restaurantId)
  ) {
    problems.push("it is limited to other restaurants");
  }
  return problems;
};

export type OrderQuote = {
  result: CheckoutQuoteResult;
  feeId: number;
  computedTotal: number;
  cart: CartDetail;
  raw: Record<string, unknown>;
  vendor: { sourceId: number; fields: Record<string, unknown> };
  orderClass: string;
  promo?: { code: string; discountRaw: number };
};

// Why a quote cannot be sent as an order; empty when it can.
const orderabilityProblems = (
  result: CheckoutQuoteResult,
  cart: CartDetail,
  raw: Record<string, unknown>,
  vendorCurrency: unknown,
  feeId: unknown,
) => {
  const reasons: string[] = [];
  if (cart.packs.length === 0) reasons.push("the cart has no items");
  if (!result.computed_total) reasons.push("no total could be computed confidently");
  if (!isPositiveId(feeId)) reasons.push("Chowdeck returned no usable delivery-fee record");
  if (!isPositiveId(cart.id)) reasons.push("the cart has no usable id");
  if (!isAmount(raw.bag_quantity)) reasons.push("the cart has no numeric bag_quantity");
  if (vendorCurrency !== undefined && vendorCurrency !== CHECKOUT_CURRENCY) {
    reasons.push(`only ${CHECKOUT_CURRENCY} orders are supported`);
  }
  const promo = result.promo;
  if (promo && (promo.status !== "applied" || promo.discount_raw === undefined || !promo.estimated_total_after_discount)) {
    reasons.push(
      `the promo code ${promo.promo_code} was not confirmed by Chowdeck (${promo.detail}); leave promo_code out to order without it`,
    );
  }
  return reasons;
};

class CheckoutService {
  private readonly carts: CartService;
  private readonly addresses: AddressService;

  constructor(
    private readonly session: UserSession,
    private readonly client = new ChowdeckClient(),
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

  // The delivery-fee request is sent at most once and never retried.
  async getQuote(restaurantId: number, addressId: number, promoInput?: string): Promise<CheckoutQuoteResult> {
    return (await this.quote(restaurantId, addressId, promoInput, true)).result;
  }

  /*
   * For place_order: a fresh quote built exactly as get_checkout_quote builds
   * it, refused unless orderable. The order uses this quote's fee record.
   */
  async quoteForOrder(restaurantId: number, addressId: number, promoInput?: string): Promise<OrderQuote> {
    const quote = await this.quote(restaurantId, addressId, promoInput, false);
    const { result } = quote;
    if (!result.orderable || !result.computed_total || !isPositiveId(quote.feeId)) {
      throw new CheckoutRefusedError(
        `this checkout cannot be ordered: ${(result.not_orderable_reasons ?? []).join("; ")}`,
      );
    }
    return {
      ...quote,
      feeId: quote.feeId,
      computedTotal: result.computed_total.amount,
      ...(result.promo?.discount_raw !== undefined && {
        promo: { code: result.promo.promo_code, discountRaw: result.promo.discount_raw },
      }),
    };
  }

  private async quote(restaurantId: number, addressId: number, promoInput: string | undefined, lookupPaymentMethods: boolean) {
    let promoCode: string | undefined;
    if (promoInput !== undefined) {
      const checked = validatePromoCode(promoInput);
      if (!checked.ok)
        throw new CheckoutRefusedError(`the promo code ${checked.error}`);
      promoCode = checked.value;
    }
    const { cart, raw, vendor, restaurant } = await this.validateCheckout(
      restaurantId,
      addressId,
    );
    // Account checks run before the fee quote, which creates a fee record.
    if (promoCode) promoCode = await this.accountPromoCode(promoCode, restaurantId);

    const quoteData = await this.requestQuote({
      destination_id: addressId,
      order_class: ORDER_CLASS,
      source_id: vendor.sourceId,
      vendor_id: restaurantId,
      currency: CHECKOUT_CURRENCY,
      country_code: CHECKOUT_COUNTRY_CODE,
      cart_id: cart.id,
    });

    const result = await this.buildQuoteResult(
      cart,
      restaurant,
      quoteData,
      cart.total_price,
      lookupPaymentMethods,
    );
    const orderClass =
      vendor.fields.self_delivery === true ? "vendor_delivery" : ORDER_CLASS;
    if (promoCode) {
      result.promo = await this.applyPromo(promoCode, {
        raw,
        restaurantId,
        addressId,
        orderClass,
        feeId: quoteData.id,
        deliveryFee: quoteData.final_delivery_amount as number,
        computedTotal: result.computed_total,
      });
    }
    const reasons = orderabilityProblems(result, cart, raw, vendor.fields.currency, quoteData.id);
    return {
      result: {
        ...result,
        orderable: reasons.length === 0,
        ...(reasons.length > 0 && { not_orderable_reasons: reasons }),
        checkout_details: checkoutDetailsOf(raw, result.promo?.status === "applied" ? result.promo.promo_code : undefined),
      },
      feeId: quoteData.id,
      cart,
      raw,
      vendor,
      orderClass,
    };
  }

  // Only a code already on the account applies, in the case Chowdeck lists it.
  private async accountPromoCode(code: string, restaurantId: number) {
    const lists = await this.readPromoLists();
    const all = [...lists.promoCodes, ...lists.discounts];
    const match = all.find(
      (promo) => String(promo.code).toUpperCase() === code.toUpperCase(),
    );
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
      throw new CheckoutRefusedError(
        `the promo code ${match.code} cannot be used: ${problems.join("; ")} (from Chowdeck's promo code list)`,
      );
    }
    return String(match.code);
  }

  private async readPromoLists() {
    const headers = await this.authHeaders();
    const errors: string[] = [];
    const read = async (path: string) => {
      try {
        return parsePromoList(
          await this.client.request(path, { headers }),
          path,
        );
      } catch (error) {
        if (error instanceof NotSignedInError) throw error;
        errors.push(
          error instanceof ChowdeckApiError
            ? error.message
            : `GET ${path} failed`,
        );
        return [];
      }
    };
    const promoCodes = await read(PROMO_CODE_LIST_PATH);
    const discounts = await read(DISCOUNT_LIST_PATH);
    return { promoCodes, discounts, errors };
  }

  async listPromoCodes(restaurantId?: number): Promise<PromoListResult> {
    const lists = await this.readPromoLists();
    if (lists.errors.length === 2) {
      throw new ChowdeckApiError(
        "invalid_response",
        `neither promo list could be read (${lists.errors.join("; ")})`,
      );
    }
    const annotate = (promo: AccountPromo) => {
      const problems = promoProblems(promo, restaurantId);
      return {
        ...promo,
        chowbot_check: { problems, looks_usable: problems.length === 0 },
      };
    };
    return {
      promo_codes: lists.promoCodes.map(annotate),
      discounts: lists.discounts.map(annotate),
      basis: [
        `promo_codes from GET ${PROMO_CODE_LIST_PATH}; discounts (vouchers) from GET ${DISCOUNT_LIST_PATH}, whose entries have only been observed empty`,
        "chowbot_check is ChowBot's reading of validity, expiry, usage and restaurant limits; it is not a promise of a discount",
        "a minimum order amount is left to Chowdeck's calculation; amounts are in naira",
        "to apply one, call get_checkout_quote with promo_code: Chowdeck's calculation then gives the discount, which is shown before ordering",
      ],
      ...(lists.errors.length > 0 && { errors: lists.errors }),
    };
  }

  // Applied only when Chowdeck returns a discount carrying that promo_code.
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
      return {
        promo_code: code,
        status: "unconfirmed",
        detail:
          "Chowdeck returned no usable delivery-fee record, so the discount calculation was not requested",
      };
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
        return {
          promo_code: code,
          status: "rejected",
          detail: `Chowdeck refused the promo code (${error.message})`,
        };
      }
      return {
        promo_code: code,
        status: "unconfirmed",
        detail: `Chowdeck's discount calculation could not be read (${error instanceof ChowdeckApiError ? error.message : "unexpected error"})`,
      };
    }
    const shown = discounts.map((d) => ({
      ...d,
      amount: formatNaira(d.amount_off + d.bogof_amount_off),
    }));
    const forCode = discountsForCode(discounts, code);
    const off = totalOff(discounts);
    if (forCode.length === 0 || totalOff(forCode) <= 0) {
      return {
        promo_code: code,
        status: "not_applied",
        detail:
          "Chowdeck's discount calculation returned no discount for this code on this cart (for example, its minimum order may not be met)",
        chowdeck_discounts: shown,
      };
    }
    const after = input.computedTotal
      ? input.computedTotal.amount - off
      : undefined;
    return {
      promo_code: code,
      status: "applied",
      detail:
        "Chowdeck's discount calculation (POST /customer/discount/apply) returned this discount for the code with this quote's delivery fee",
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

  // The website's checkout checks, in its order.
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
        `the cart total (${formatNaira(total)}) is below this restaurant's minimum order (${formatNaira(minimum)})`,
      );
    }

    return { cart, raw: snapshot.raw ?? {}, vendor, restaurant };
  }

  private async buildQuoteResult(
    cart: CartDetail,
    restaurant: Record<string, ScalarValue>,
    quoteData: Record<string, unknown>,
    total: unknown,
    lookupPaymentMethods: boolean,
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
     * Chowdeck returns no grand total. No total is computed when
     * small_order_amount or safety_fee is non-zero.
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
              "computed by ChowBot from Chowdeck's cart total and fees; not a total returned by Chowdeck",
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
    if (!lookupPaymentMethods) return result;

    const lookup = await this.paymentMethods(computedTotal.amount);
    if (lookup.methods) {
      result.payment_methods = lookup.methods;
    } else {
      result.payment_methods_error = `payment methods could not be retrieved (${lookup.error}); the quote above is still valid`;
    }
    return result;
  }

  async readTipConfig(): Promise<TipConfig | undefined> {
    try {
      return parseTipConfig(
        await this.client.request(CONFIG_PATH, {
          headers: await this.authHeaders(),
        }),
      );
    } catch {
      return undefined;
    }
  }

  // The order is compared with total_balance, as the website displays it.
  async listBeneficiaries() {
    const body = await this.client.request(BENEFICIARY_PATH, { headers: await this.authHeaders() });
    const entries = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord) : undefined;
    if (!entries || !entries.every((entry) => isPositiveId(entry.id) && typeof entry.full_name === "string")) {
      throw new ChowdeckApiError("invalid_response", `GET ${BENEFICIARY_PATH} returned an unexpected response shape`);
    }
    return entries.map((entry) => pickScalarFields(entry, BENEFICIARY_FIELDS));
  }

  async readWalletBalance() {
    const body = await this.client.request(WALLET_PATH, {
      headers: await this.authHeaders(),
      query: { currency: CHECKOUT_CURRENCY, new_response: "true" },
    });
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const total = data?.total_balance;
    if (
      !data ||
      typeof total !== "number" ||
      !Number.isFinite(total) ||
      (data.currency !== undefined && data.currency !== CHECKOUT_CURRENCY)
    ) {
      throw new ChowdeckApiError(
        "invalid_response",
        `GET ${WALLET_PATH} returned an unexpected response shape`,
      );
    }
    const balances = isRecord(data.balances) ? data.balances : {};
    const part = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    return {
      total,
      cash: part(balances.cash),
      chowbucks: part(balances.chowbucks),
    };
  }

  // Only an explicit is_valid true passes.
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
    const valid =
      isRecord(body) && isRecord(body.data) ? body.data.is_valid : undefined;
    if (valid === true) return;
    throw new CheckoutRefusedError(
      valid === false
        ? "Chowdeck says the gift recipient's phone number is not valid for that country"
        : `POST ${PHONE_VALIDATE_PATH} returned an unexpected response, so the gift recipient's phone is unchecked`,
    );
  }

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
    if (
      isRecord(body) &&
      body.status !== undefined &&
      body.status !== "success"
    ) {
      throw new ChowdeckApiError(
        "invalid_response",
        `POST ${DISCOUNT_APPLY_PATH} answered status ${String(body.status)}${typeof body.message === "string" ? `: ${body.message}` : ""}`,
      );
    }
    const discounts = parseAppliedDiscounts(body);
    return { discounts, total_off: totalOff(discounts) };
  }

}

export default CheckoutService;
