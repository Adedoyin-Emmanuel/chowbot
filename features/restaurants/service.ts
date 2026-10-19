import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";

export type RestaurantSearchParams = {
  page?: number;
  limit: number;
  query?: string;
  addressId: number;
};

type SummaryValue = string | number | boolean | null;

export type RestaurantSummary = Record<string, SummaryValue>;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSummaryValue = (value: unknown): value is SummaryValue =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const summarizeVendor = (vendor: Record<string, unknown>) => {
  const summary: RestaurantSummary = {};
  for (const field of SUMMARY_FIELDS) {
    const value = vendor[field];
    if (isSummaryValue(value)) summary[field] = value;
  }
  return summary;
};

class RestaurantService {
  constructor(private readonly client = new ChowdeckClient()) {}

  async search({
    addressId,
    query,
    page,
    limit,
  }: RestaurantSearchParams): Promise<RestaurantSearchResult> {
    const body = await this.client.request(VENDOR_LIST_PATH, {
      query: { address_id: addressId, q: query, page },
    });

    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw new ChowdeckApiError(
        "invalid_response",
        `GET ${VENDOR_LIST_PATH} returned an unexpected response shape`,
      );
    }

    const vendors = body.data.filter(isRecord);

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
