import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import { chowdeckAuthHeaders, type UserSession } from "../../lib/session";
import { isRecord, pickScalarFields, type ScalarValue } from "../../utils/object";

const VENDOR_LIST_PATH = "/customer/vendor/v2";
const SPECIAL_VENDORS_PATH = "/customer/vendor/special/v2";
const FREQUENT_VENDORS_PATH = "/customer/vendor/frequent";
const SEARCH_PATH = "/customer/search/product";

/*
 * The search filters the website offers and Chowdeck accepts (checked
 * 2026-10-23). Shops are "supermarket"; vouchers and packages (relay) are
 * left out because ChowBot cannot order them.
 */
export const SEARCH_TYPES = ["restaurant", "supermarket", "pharmacy", "chowstore"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const COLLECTIONS = ["nearby", "handpicked", "featured", "order_again"] as const;
export type Collection = (typeof COLLECTIONS)[number];

export type RestaurantSummary = Record<string, ScalarValue>;
export type ProductSummary = Record<string, ScalarValue>;

/*
 * Captured vendor fields (v2 list, special lists and search share them).
 * delivery_price and minimum_order_amount are kobo; delivery times are
 * minutes. Logos, cover images, hours objects and tags are left out.
 */
const VENDOR_FIELDS = [
  "id",
  "name",
  "vendor_type",
  "vendor_class",
  "location",
  "city",
  "average_rating",
  "number_of_rating",
  "is_open",
  "is_temporarily_unavailable",
  "opening_time_text",
  "delivery_price",
  "minimum_order_amount",
  "minimum_delivery_time",
  "maximum_delivery_time",
  "distance",
  "offers_pickup",
  "can_pre_order",
] as const;

const PRODUCT_FIELDS = ["id", "name", "description", "price", "discount_price", "in_stock"] as const;

const FREQUENT_FIELDS = ["vendor_id", "vendor_name", "vendor_type", "location", "order_id", "total_price"] as const;

const MAX_PRODUCTS_PER_VENDOR = 5;

const unexpectedShape = (path: string) =>
  new ChowdeckApiError("invalid_response", `GET ${path} returned an unexpected response shape`);

const listOf = (body: unknown, path: string) => {
  const raw = isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
  const entries = raw?.filter(isRecord);
  if (!raw || !entries || entries.length !== raw.length) throw unexpectedShape(path);
  return entries;
};

const summarizeVendor = (vendor: Record<string, unknown>): RestaurantSummary => {
  const summary = pickScalarFields(vendor, VENDOR_FIELDS);
  if (vendor.is_temporarily_unavailable === true && typeof vendor.temporarily_unavailable_tag === "string") {
    summary.unavailable_reason = vendor.temporarily_unavailable_tag;
  }
  if (typeof vendor.discount_text === "string" && vendor.discount_text.trim()) summary.discount_text = vendor.discount_text;
  return summary;
};

const isOpenNow = (vendor: Record<string, unknown>) =>
  vendor.is_open === true && vendor.is_temporarily_unavailable !== true;

export type ListFilters = { vendorType?: string; openNow?: boolean; limit: number };

const filterVendors = (vendors: Record<string, unknown>[], { vendorType, openNow }: ListFilters) =>
  vendors.filter(
    (vendor) => (!vendorType || vendor.vendor_type === vendorType) && (!openNow || isOpenNow(vendor)),
  );

/*
 * Read-only lookups of what Chowdeck lists for a delivery address. A listing
 * does not settle delivery: only the checkout quote does.
 */
class RestaurantService {
  constructor(
    private readonly session?: UserSession,
    private readonly client = new ChowdeckClient(),
  ) {}

  private async get(path: string, query: Record<string, string | number | undefined>) {
    return this.client.request(path, { query, headers: await chowdeckAuthHeaders(this.session) });
  }

  /*
   * The website's search bar: places whose name matches, and places with
   * matching dishes or products, which are listed under each place.
   */
  async search(addressId: number, query: string, type: SearchType | undefined, limit: number) {
    const entries = listOf(await this.get(SEARCH_PATH, { address_id: addressId, query, type }), SEARCH_PATH);
    return {
      address_id: addressId,
      query,
      ...(type && { type }),
      returned: entries.length,
      truncated: entries.length > limit,
      results: entries.slice(0, limit).map((vendor) => {
        const products = (Array.isArray(vendor.products) ? vendor.products.filter(isRecord) : []).filter(
          (product) => product.is_active !== false && product.is_published !== false,
        );
        return {
          ...summarizeVendor(vendor),
          ...(products.length > 0 && {
            matching_items: products.slice(0, MAX_PRODUCTS_PER_VENDOR).map((product) => pickScalarFields(product, PRODUCT_FIELDS)),
          }),
        };
      }),
    };
  }

  async browse(addressId: number, collection: Collection, filters: ListFilters, nextCursor?: string) {
    if (collection === "order_again") return this.orderAgain(addressId, filters.limit);
    const path = collection === "nearby" ? VENDOR_LIST_PATH : SPECIAL_VENDORS_PATH;
    const body = await this.get(path, {
      address_id: addressId,
      ...(collection === "nearby" ? { next_cursor: nextCursor } : { tag: collection }),
    });
    const vendors = filterVendors(listOf(body, path), filters);
    const meta = isRecord(body) && isRecord(body.meta) ? body.meta : undefined;
    const cursor = meta?.has_more === true && typeof meta.next_cursor === "string" ? meta.next_cursor : undefined;
    return {
      address_id: addressId,
      collection,
      returned: vendors.length,
      truncated: vendors.length > filters.limit,
      restaurants: vendors.slice(0, filters.limit).map(summarizeVendor),
      ...(cursor && { next_cursor: cursor }),
    };
  }

  // The user's frequent vendors, each with its latest order's items.
  private async orderAgain(addressId: number, limit: number) {
    const entries = listOf(await this.get(FREQUENT_VENDORS_PATH, { address_id: addressId }), FREQUENT_VENDORS_PATH);
    return {
      address_id: addressId,
      collection: "order_again",
      returned: entries.length,
      truncated: entries.length > limit,
      restaurants: entries.slice(0, limit).map((vendor) => ({
        ...pickScalarFields(vendor, FREQUENT_FIELDS),
        last_order_items: (Array.isArray(vendor.items) ? vendor.items.filter(isRecord) : []).map((item) =>
          pickScalarFields(item, ["item_id", "name", "is_available"] as const),
        ),
      })),
    };
  }
}

export default RestaurantService;
