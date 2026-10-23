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
 * completed is order history; active is orders in progress, unpaid ones included.
 */
export const ORDER_LIST_STATUSES = ["completed", "active"] as const;
export type OrderListStatus = (typeof ORDER_LIST_STATUSES)[number];

type Fields = Record<string, ScalarValue>;

/*
 * Allowlists: nested objects, fee_id, code, references and
 * user/customer/address IDs are never listed. order_pin is kept only as
 * delivery_pin, which the tools show once the order is paid.
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
 * Rider and rider_location fields are likely names, not confirmed ones; only
 * scalars are kept.
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
 * Only https://chowdeck.com/store/track/<token> is passed on. Anyone with the
 * link can follow the order, so it is shown only to its owner.
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
 * Only https://chowdeck.com/store/pay/<token> is passed on.
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
    // The PIN the rider asks for at handover: order_pin, equal to the create response's delivery_pin.
    const pin = data.order_pin ?? data.delivery_pin;
    if ((Number.isSafeInteger(pin) && (pin as number) >= 0) || (typeof pin === "string" && /^\d{4,8}$/.test(pin))) {
      order.delivery_pin = String(pin);
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
   * Sent once; the caller confirms the change by reading the order again.
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

export const readOrderState = async (orders: OrderService, orderId: number) => {
  const { order } = await orders.getOrder(String(orderId));
  return { order, classification: classifyOrder(order) };
};

export default OrderService;
