import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import { chowdeckAuthHeaders, type UserSession } from "../../lib/session";
import { isRecord, pickScalarFields, type ScalarValue } from "../../utils/object";

export type RestaurantSearchParams = {
  page?: number;
  limit: number;
  query?: string;
  addressId: number;
};

export type RestaurantSummary = Record<string, ScalarValue>;

export type RestaurantSearchResult = {
  page?: number;
  returned: number;
  truncated: boolean;
  address_id: number;
  restaurants: RestaurantSummary[];
};

const VENDOR_LIST_PATH = "/customer/vendor/v2";

const SUMMARY_FIELDS = [
  "id",
  "name",
  "status",
  "rating",
  "is_open",
  "price_range",
  "vendor_type",
  "delivery_fee",
  "is_available",
  "delivery_time",
  "minimum_order",
] as const;

const summarizeVendor = (vendor: Record<string, unknown>): RestaurantSummary =>
  pickScalarFields(vendor, SUMMARY_FIELDS);

class RestaurantService {
  constructor(
    private readonly session?: UserSession,
    private readonly client = new ChowdeckClient(),
  ) {}

  async search({
    addressId,
    query,
    page,
    limit,
  }: RestaurantSearchParams): Promise<RestaurantSearchResult> {
    const body = await this.client.request(VENDOR_LIST_PATH, {
      query: { address_id: addressId, q: query, page },
      headers: await chowdeckAuthHeaders(this.session),
    });

    const rawVendors = isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
    const vendors = rawVendors?.filter(isRecord);

    if (!rawVendors || !vendors || (rawVendors.length > 0 && vendors.length === 0)) {
      throw new ChowdeckApiError(
        "invalid_response",
        `GET ${VENDOR_LIST_PATH} returned an unexpected response shape`,
      );
    }

    return {
      address_id: addressId,
      ...(page !== undefined && { page }),
      returned: vendors.length,
      truncated: vendors.length > limit,
      restaurants: vendors.slice(0, limit).map(summarizeVendor),
    };
  }
}

export default RestaurantService;
