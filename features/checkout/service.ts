import {
  isRecord,
  pickScalarFields,
  type ScalarValue,
} from "../../utils/object";
import { logger } from "../../utils/logger";
import type { UserOrderSubmissions } from "../../lib/order-submissions";
import CartService, { cartFingerprint, type CartDetail } from "../carts/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import AddressService, { NotSignedInError } from "../addresses/service";
import { chowdeckAuthHeaders, type UserSession } from "../../lib/session";

const ORDER_CLASS = "delivery";
const CHECKOUT_CURRENCY = "NGN";
const CHECKOUT_COUNTRY_CODE = "NG";

const DELIVERY_AMOUNT_PATH = "/customer/delivery/amount";
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
const WITHHELD_NOTE = "<withheld: copied from your cart>";

export type OrderPreviewResult = {
  dry_run: true;
  submitted: false;
  restaurant: Record<string, ScalarValue>;
  cart: Record<string, ScalarValue>;
  validations: string[];
  payload_preview: Record<string, unknown>;
  omitted_fields: Record<string, string>;
  not_performed: string[];
  assumptions: string[];
};

/*
 * A quote ChowBot refuses to request. Messages never include address IDs,
 * source/destination IDs or fee IDs.
 */
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
  ): Promise<CheckoutQuoteResult> {
    const { cart, raw, vendor, restaurant } = await this.validateCheckout(
      restaurantId,
      addressId,
    );
    const total = cart.total_price;

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
      });
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
  async previewOrder(
    restaurantId: number,
    addressId: number,
    paymentMethod: PreviewPaymentMethod,
  ): Promise<OrderPreviewResult> {
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
    const note = (value: unknown) =>
      typeof value === "string" && value.length > 0 ? WITHHELD_NOTE : null;

    const payload: Record<string, unknown> = {
      source: "web",
      vendor_id: restaurantId,
      cart_id: cart.id,
      checkout_from_cart: true,
      class: orderClass,
      payment_method: paymentMethod,
      ...(paymentMethod === "pay_for_me" && { has_external_payment: true }),
      promo_codes: [],
      customer_vendor_note: note(raw.customer_vendor_note),
      customer_delivery_note: note(raw.customer_delivery_note),
      ...(isAmount(raw.bag_quantity) && { bag_quantity: raw.bag_quantity }),
      requires_delivery_pin: true,
      fee_id: WITHHELD_FEE_ID,
      address_id: WITHHELD_ADDRESS_ID,
      split_payment_with_wallet: false,
      gift_recipient: null,
      country_code: CHECKOUT_COUNTRY_CODE,
      currency: CHECKOUT_CURRENCY,
    };

    const omitted: Record<string, string> = {
      payment_method_id:
        paymentMethod === "pay_for_me"
          ? "replaced by has_external_payment for pay_for_me"
          : "not sent for wallet: the payment methods Chowdeck lists carry no id",
      tip: "no tip is added in a preview",
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
        "promo codes, tips, gifting and splitting with the wallet are left off",
      ],
    };
  }
}

export default CheckoutService;
