import {
  isRecord,
  pickScalarFields,
  type ScalarValue,
} from "../../utils/object";
import { NotSignedInError } from "../addresses/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import { chowdeckAuthHeaders, type UserSession } from "../../lib/session";

const ORDER_LIST_PATH = "/customer/order";
const orderPath = (orderId: string) =>
  `/customer/order/${encodeURIComponent(orderId)}`;

const LISTED_STATUS = "completed";

type Fields = Record<string, ScalarValue>;

/*
 * Explicit allowlists of observed fields. Nested objects (customer, address,
 * driver, vendorAddress) are never copied, and fee_id, order_pin, code,
 * tracking_url, pay_for_me_url, references and user/customer/address IDs are
 * never listed.
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
  "refund_amount",
  "has_external_payment",
  "time_payment_confirmed",
  "estimated_delivery_time",
  "actual_delivery_time",
  "time_customer_received_order",
  "is_failed_delivery",
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
  status_filter: string;
  returned: number;
  orders: Fields[];
};

export type OrderDetail = Fields & { payment?: Fields; items?: Fields[] };

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

  async listOrders(): Promise<OrderListResult> {
    const body = await this.client.request(ORDER_LIST_PATH, {
      headers: await this.authHeaders(),
      query: { status: LISTED_STATUS },
    });

    const orders = isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
    if (!orders || !orders.every((order) => isRecord(order) && hasOrderId(order))) {
      throw unexpectedShape(ORDER_LIST_PATH);
    }

    return {
      status_filter: LISTED_STATUS,
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
    if (Array.isArray(data.items)) {
      order.items = data.items
        .filter(isRecord)
        .map((item) => pickScalarFields(item, ITEM_FIELDS));
    }
    return { order };
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

export default OrderService;
