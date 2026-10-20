import {
  isRecord,
  pickScalarFields,
  type ScalarValue,
} from "../../utils/object";
import CartService, { type CartDetail } from "../carts/service";
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
    const cartResult = await this.carts.getVendorCart(restaurantId);
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

    const quoteData = await this.requestQuote({
      destination_id: addressId,
      order_class: ORDER_CLASS,
      source_id: vendor.sourceId,
      vendor_id: restaurantId,
      currency: CHECKOUT_CURRENCY,
      country_code: CHECKOUT_COUNTRY_CODE,
      cart_id: cart.id,
    });

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
}

export default CheckoutService;
