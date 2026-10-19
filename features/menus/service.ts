import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import { isRecord, pickScalarFields, type ScalarValue } from "../../utils/object";

export type RestaurantMenuParams = {
  limit: number;
  category?: string;
  restaurantId: number;
};

export type MenuItemSummary = Record<string, ScalarValue>;

export type RestaurantMenuResult = {
  category?: string;
  returned: number;
  truncated: boolean;
  restaurant_id: number;
  items: MenuItemSummary[];
};

const ITEM_FIELDS = [
  "id",
  "name",
  "price",
  "status",
  "in_stock",
  "description",
  "is_available",
] as const;

const categoryName = (item: Record<string, unknown>) => {
  const { category } = item;
  if (isRecord(category) && typeof category.name === "string") {
    return category.name;
  }
  return undefined;
};

const summarizeItem = (item: Record<string, unknown>) => {
  const summary: MenuItemSummary = pickScalarFields(item, ITEM_FIELDS);
  const category = categoryName(item);
  if (category !== undefined) summary.category = category;
  return summary;
};

class MenuService {
  constructor(private readonly client = new ChowdeckClient()) {}

  async getRestaurantMenu({
    restaurantId,
    category,
    limit,
  }: RestaurantMenuParams): Promise<RestaurantMenuResult> {
    const path = `/customer/vendor/${restaurantId}/menu`;
    const body = await this.client.request(path);

    const rawItems = isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
    const items = rawItems?.filter(isRecord);

    if (!rawItems || !items || (rawItems.length > 0 && items.length === 0)) {
      throw new ChowdeckApiError(
        "invalid_response",
        `GET ${path} returned an unexpected response shape`,
      );
    }

    const needle = category?.toLowerCase();
    const matching = needle
      ? items.filter((item) => categoryName(item)?.toLowerCase().includes(needle))
      : items;

    return {
      restaurant_id: restaurantId,
      ...(category !== undefined && { category }),
      returned: matching.length,
      truncated: matching.length > limit,
      items: matching.slice(0, limit).map(summarizeItem),
    };
  }
}

export default MenuService;
