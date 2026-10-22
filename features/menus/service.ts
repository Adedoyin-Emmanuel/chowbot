import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import { chowdeckAuthHeaders, type UserSession } from "../../lib/session";
import { isRecord, pickScalarFields, type ScalarValue } from "../../utils/object";

export type RestaurantMenuParams = {
  limit: number;
  category?: string;
  restaurantId: number;
};

export type MenuItemSummary = Record<string, ScalarValue>;

export type MenuItemParams = {
  restaurantId: number;
  menuItemId: number;
};

export type OptionSummary = Record<string, ScalarValue>;

export type OptionGroup = {
  [field: string]: ScalarValue | OptionSummary[];
  options: OptionSummary[];
};

export type MenuItemDetailResult = {
  restaurant_id: number;
  item: MenuItemSummary;
  option_groups: OptionGroup[];
};

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

// description is passed through only when present. Amounts are raw.
const DETAIL_ITEM_FIELDS = [
  "id",
  "name",
  "price",
  "discount_price",
  "currency",
  "price_description",
  "listing_price_factor",
  "mark_up_price",
  "in_stock",
  "is_active",
  "is_published",
] as const;
const UNVERIFIED_DETAIL_ITEM_FIELDS = ["description"] as const;

const GROUP_FIELDS = [
  "id",
  "name",
  "minimum_selection",
  "maximum_selection",
  "maximum_free_selection",
  "has_quantity",
  "menugroup_type",
  "is_published",
] as const;

const OPTION_FIELDS = [
  "id",
  "name",
  "price",
  "currency",
  "listing_price_factor",
  "mark_up_price",
  "in_stock",
  "is_active",
] as const;

const isPositiveId = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

/*
 * A malformed group fails the whole response rather than being dropped, so a
 * required choice is never silently hidden from the caller.
 */
const parseOptionGroup = (group: unknown): OptionGroup | undefined => {
  if (!isRecord(group) || !isPositiveId(group.id) || !Array.isArray(group.items)) return undefined;
  const options = group.items;
  if (!options.every((option) => isRecord(option) && isPositiveId(option.id))) return undefined;
  return {
    ...pickScalarFields(group, GROUP_FIELDS),
    options: options.map((option) => pickScalarFields(option, OPTION_FIELDS)),
  };
};

class MenuService {
  constructor(
    private readonly session?: UserSession,
    private readonly client = new ChowdeckClient(),
  ) {}

  async getRestaurantMenu({
    restaurantId,
    category,
    limit,
  }: RestaurantMenuParams): Promise<RestaurantMenuResult> {
    const path = `/customer/vendor/${restaurantId}/menu`;
    const body = await this.client.request(path, {
      headers: await chowdeckAuthHeaders(this.session),
    });

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

  async getMenuItem({ restaurantId, menuItemId }: MenuItemParams): Promise<MenuItemDetailResult> {
    const path = `/customer/vendor/${restaurantId}/menu/${menuItemId}`;
    const body = await this.client.request(path, {
      headers: await chowdeckAuthHeaders(this.session),
    });

    const item = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const groups =
      item?.id === menuItemId && Array.isArray(item.modifiers)
        ? item.modifiers.map(parseOptionGroup)
        : undefined;

    if (!item || !groups || groups.some((group) => group === undefined)) {
      throw new ChowdeckApiError(
        "invalid_response",
        `GET ${path} returned an unexpected response shape`,
      );
    }

    const summary: MenuItemSummary = {
      ...pickScalarFields(item, DETAIL_ITEM_FIELDS),
      ...pickScalarFields(item, UNVERIFIED_DETAIL_ITEM_FIELDS),
    };
    const category = categoryName(item);
    if (category !== undefined) summary.category = category;

    return {
      restaurant_id: restaurantId,
      item: summary,
      option_groups: groups as OptionGroup[],
    };
  }
}

export default MenuService;
