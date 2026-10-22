import {
  isRecord,
  pickScalarFields,
  type ScalarValue,
} from "../../utils/object";
import { NotSignedInError } from "../addresses/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import { chowdeckAuthHeaders, type UserSession } from "../../lib/session";
import { classifyOrder } from "./status";

const ORDER_LIST_PATH = "/customer/order";
const orderPath = (orderId: string) =>
  `/customer/order/${encodeURIComponent(orderId)}`;

/*
 * The two list filters observed: completed (order history) and active
 * (2026-10-22: orders in progress, which also returned an unpaid order with
 * status "abandoned").
 */
export const ORDER_LIST_STATUSES = ["completed", "active"] as const;
export type OrderListStatus = (typeof ORDER_LIST_STATUSES)[number];

type Fields = Record<string, ScalarValue>;

/*
 * Explicit allowlists of observed fields. Nested objects (customer, address,
 * driver, vendorAddress) are never copied, and fee_id, order_pin, code,
 * references and user/customer/address IDs are never listed. tracking_url
 * and pay_for_me_url are listed only in the form Chowdeck was seen to send
 * (see trackingLinkOf and payForMeLinkOf).
 */
const SUMMARY_FIELDS = [
  "id",
  "vendor_id",
  "vendor_name",
  "status",
  "class",
  "currency",
  "total_price",
  "service_price",
  "order_items_count",
  "created_at",
] as const;

const ORDER_FIELDS = [
  "id",
  "vendor_id",
  "vendor_name",
  "status",
  "previous_status",
  "class",
  "type",
  "currency",
  "total_price",
  "original_total_price",
  "items_price",
  "original_items_price",
  "delivery_price",
  "service_price",
  "small_order_price",
  "bag_fee",
  "safety_fee",
  "container_fee",
  "tip_amount",
  "tips_total",
  "discount_price",
  "promo_code_price",
  "voucher_amount",
  "vendor_discount_amount",
  "promo_codes",
  "refund_amount",
  "has_external_payment",
  "time_payment_confirmed",
  "estimated_delivery_time",
  "actual_delivery_time",
  "time_customer_received_order",
  "is_failed_delivery",
  "customer_vendor_note",
  "customer_delivery_note",
  "created_at",
] as const;

/*
 * Card metadata (last4, brand) and processor references are left out.
 */
const PAYMENT_FIELDS = ["status", "amount", "method", "channel"] as const;

const ITEM_FIELDS = [
  "type",
  "item_id",
  "name",
  "quantity",
  "pack_id",
  "price_per_quantity",
  "total_price",
  "discount_price_per_quantity",
  "discount_total_price",
  "menugroup_id",
  "menugroup_name",
] as const;

const TIMELINE_FIELDS = [
  "heading",
  "description",
  "level",
  "action",
  "eta",
  "time",
] as const;

export type OrderListResult = {
  status_filter: OrderListStatus;
  returned: number;
  orders: Fields[];
};

export type OrderDetail = Fields & { payment?: Fields; items?: Fields[] };

/*
 * Observed 2026-10-22 from GET /customer/order/{id}/live-tracking, on an
 * unpaid order where every delivery field was null. user_id, delivery_id,
 * customer_location, vendor_location, route, socket_room and pusher_channel
 * are left out. The rider and rider_location objects were only seen as null,
 * so their fields below are an allowlist of likely names, kept only when
 * they are scalars.
 */
const LIVE_FIELDS = [
  "order_status",
  "order_class",
  "placed_at",
  "delivered_at",
  "delivery_status",
  "delivery_is_terminal",
] as const;
const RIDER_FIELDS = ["name", "first_name", "last_name", "phone", "rating", "vehicle_type", "plate_number"] as const;
const RIDER_LOCATION_FIELDS = ["latitude", "longitude", "lat", "lng", "heading", "updated_at"] as const;

export type LiveTracking = Fields & { rider?: Fields; rider_location?: Fields };

/*
 * Every order Chowdeck created carried a tracking_url of the form
 * https://chowdeck.com/store/track/<token> (2026-10-22). Only that form is
 * passed on, as a clickable link for the user; anything else is dropped.
 * Anyone with the link can follow the order, so it is shown only to the
 * order's owner.
 */
export const trackingLinkOf = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const ok =
    url.protocol === "https:" &&
    url.hostname === "chowdeck.com" &&
    !url.port &&
    !url.username &&
    !url.password &&
    /^\/store\/track\/[A-Za-z0-9_=+%-]+$/.test(url.pathname);
  return ok ? url.href : undefined;
};

/*
 * A pay-for-me order carried pay_for_me_url
 * https://chowdeck.com/store/pay/<token> (2026-10-22): a page where anyone
 * with the link can pay the order. Only that form is passed on.
 */
export const payForMeLinkOf = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const ok =
    url.protocol === "https:" &&
    url.hostname === "chowdeck.com" &&
    !url.port &&
    !url.username &&
    !url.password &&
    /^\/store\/pay\/[A-Za-z0-9_=+%-]+$/.test(url.pathname);
  return ok ? url.href : undefined;
};

export type OrderResult = { order: OrderDetail };

export type OrderTimelineResult = {
  order_id: string;
  returned: number;
  timeline: Fields[];
};

const hasOrderId = (value: Record<string, unknown>) =>
  (Number.isSafeInteger(value.id) && (value.id as number) > 0) ||
  (typeof value.id === "string" && value.id.length > 0);

const unexpectedShape = (path: string) =>
  new ChowdeckApiError(
    "invalid_response",
    `GET ${path} returned an unexpected response shape`,
  );

/*
 * Read-only lookups of the signed-in user's own orders. Requests are sent
 * once with the client's existing behaviour; nothing here writes.
 */
class OrderService {
  constructor(
    private readonly session: UserSession,
    private readonly client = new ChowdeckClient(),
  ) {}

  private async authHeaders() {
    const headers = await chowdeckAuthHeaders(this.session);
    if (!headers.authorization) throw new NotSignedInError();
    return headers;
  }

  async listOrders(status: OrderListStatus = "completed"): Promise<OrderListResult> {
    const body = await this.client.request(ORDER_LIST_PATH, {
      headers: await this.authHeaders(),
      query: { status },
    });

    const orders = isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
    if (!orders || !orders.every((order) => isRecord(order) && hasOrderId(order))) {
      throw unexpectedShape(ORDER_LIST_PATH);
    }

    return {
      status_filter: status,
      returned: orders.length,
      orders: (orders as Record<string, unknown>[]).map((order) =>
        pickScalarFields(order, SUMMARY_FIELDS),
      ),
    };
  }

  async getOrder(orderId: string): Promise<OrderResult> {
    const path = orderPath(orderId);
    const body = await this.client.request(path, {
      headers: await this.authHeaders(),
    });

    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    if (!data || !hasOrderId(data) || String(data.id) !== orderId) {
      throw unexpectedShape(path);
    }

    const order: OrderDetail = pickScalarFields(data, ORDER_FIELDS);
    if (order.vendor_name === undefined && isRecord(data.vendor)) {
      const { name } = data.vendor;
      if (typeof name === "string") order.vendor_name = name;
    }
    if (isRecord(data.payment)) {
      order.payment = pickScalarFields(data.payment, PAYMENT_FIELDS);
    }
    const tracking = trackingLinkOf(data.tracking_url);
    if (tracking) order.tracking_url = tracking;
    const payForMe = payForMeLinkOf(data.pay_for_me_url);
    if (payForMe) order.pay_for_me_url = payForMe;
    if (Array.isArray(data.items)) {
      order.items = data.items
        .filter(isRecord)
        .map((item) => pickScalarFields(item, ITEM_FIELDS));
    }
    return { order };
  }

  async getLiveTracking(orderId: string): Promise<LiveTracking> {
    const path = `${orderPath(orderId)}/live-tracking`;
    const body = await this.client.request(path, {
      headers: await this.authHeaders(),
    });
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    if (!data || (data.order_id !== undefined && String(data.order_id) !== orderId)) {
      throw unexpectedShape(path);
    }
    const live: LiveTracking = pickScalarFields(data, LIVE_FIELDS);
    if (isRecord(data.rider)) live.rider = pickScalarFields(data.rider, RIDER_FIELDS);
    if (isRecord(data.rider_location)) live.rider_location = pickScalarFields(data.rider_location, RIDER_LOCATION_FIELDS);
    return live;
  }

  /*
   * The storefront's edit of a placed order's rider note (storefront code,
   * read 2026-10-21): PUT /customer/order/{id}/delivery with
   * {customer_delivery_note}. Never observed on the wire. Sent once; the
   * caller confirms the change by reading the order again.
   */
  async sendDeliveryNote(orderId: string, note: string) {
    return this.client.request(`${orderPath(orderId)}/delivery`, {
      method: "PUT",
      headers: await this.authHeaders(),
      body: { customer_delivery_note: note },
    });
  }

  async getOrderTimeline(orderId: string): Promise<OrderTimelineResult> {
    const path = `${orderPath(orderId)}/timeline`;
    const body = await this.client.request(path, {
      headers: await this.authHeaders(),
    });

    const rawEntries = isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
    const entries = rawEntries?.filter(isRecord);
    if (!rawEntries || !entries || entries.length !== rawEntries.length) {
      throw unexpectedShape(path);
    }

    return {
      order_id: orderId,
      returned: entries.length,
      timeline: entries.map((entry) => pickScalarFields(entry, TIMELINE_FIELDS)),
    };
  }
}

/*
 * Payment evidence from Chowdeck for a known order id: paid only when the
 * order's payment status is success (see ./status.ts). The timeline is not
 * evidence: Chowdeck lists a MADE_PAYMENT step on orders that were never
 * paid (observed 2026-10-22, orders 43584305 and 43591071, whose status was
 * "abandoned" seconds after creation while awaiting payment). Lookup
 * failures are thrown, never read as unpaid.
 */
export const readPaymentEvidence = async (orders: OrderService, orderId: number) => {
  const { paid, evidence } = (await readOrderState(orders, orderId)).classification;
  return { paid, evidence };
};

/*
 * One fresh read of an order's record, with its classification.
 */
export const readOrderState = async (orders: OrderService, orderId: number) => {
  const { order } = await orders.getOrder(String(orderId));
  return { order, classification: classifyOrder(order) };
};

export default OrderService;
