import {
  isRecord,
  pickScalarFields,
  type ScalarValue,
} from "../../utils/object";
import MenuService, { type OptionGroup } from "../menus/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import AddressService, { NotSignedInError } from "../addresses/service";
import { chowdeckAuthHeaders, type UserSession } from "../../lib/session";

export type CartRow = Record<string, ScalarValue>;

export type CartPack = {
  rows: CartRow[];
  pack_reference: string | null;
};

export type CartDetail = Record<
  string,
  ScalarValue | CartPack[] | CartRow[]
> & {
  packs: CartPack[];
  validation_issues: CartRow[];
};

export type VendorCartResult =
  | { restaurant_id: number; exists: false }
  | { restaurant_id: number; exists: true; cart: CartDetail };

export type CartSummary = Record<string, ScalarValue>;

export type CartListResult = {
  returned: number;
  carts: CartSummary[];
};

export type ModifierChoice = { groupId: number; optionId: number };

export type AddToCartParams = {
  restaurantId: number;
  addressId: number;
  menuItemId: number;
  quantity: number;
  modifiers: ModifierChoice[];
};

export type AddToCartResult = {
  created_cart: boolean;
  added: { menu_item_id: number; quantity: number; modifiers: number };
  cart: CartDetail;
};

/*
 * A request ChowBot refuses before writing to Chowdeck. Messages never
 * include private values such as address IDs.
 */
export class CartRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartRequestError";
  }
}

const CART_LIST_PATH = "/customer/cart";
const vendorCartPath = (restaurantId: number) =>
  `/customer/cart/vendor/${restaurantId}`;

/*
 * Values the Chowdeck web client sent when adding items (sanitized capture,
 * 2026-10-20). Whether Chowdeck requires or validates them is unknown.
 */
const WEB_CLIENT_FIELDS = {
  source: "web",
  app_version: "2.0.0",
  class: "delivery",
} as const;

/*
 * Observed cart fields only. user_id, address_id, the address object and
 * notes are private and never returned; source, app_version, bag_quantity
 * and current_pack_reference have no known meaning for callers.
 */
const CART_FIELDS = [
  "id",
  "vendor_id",
  "total_price",
  "currency",
  "is_valid",
  "status",
  "type",
  "created_at",
  "updated_at",
  "last_validated_at",
] as const;

const ROW_FIELDS = [
  "item_id",
  "name",
  "type",
  "quantity",
  "price_per_quantity",
  "discount_price",
  "listing_price_factor",
  "mark_up_price",
  "group_name",
  "menu_group_id",
] as const;

const ISSUE_FIELDS = [
  "code",
  "type",
  "menu_id",
  "group_id",
  "group_name",
  "selection_count",
  "selections_required",
] as const;

const isPositiveId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const unexpectedShape = (method: string, path: string) =>
  new ChowdeckApiError(
    "invalid_response",
    `${method} ${path} returned an unexpected response shape`,
  );

/*
 * Rows are grouped into packs by their shared pack_reference, which is how
 * Chowdeck links a menu row to its option rows. The row id is returned as
 * cart_item_id so it cannot be confused with item_id (the menu or option id).
 */
const parsePacks = (rows: unknown[]): CartPack[] | undefined => {
  const packs = new Map<string | null, CartRow[]>();
  for (const row of rows) {
    if (!isRecord(row) || !isPositiveId(row.id) || !isPositiveId(row.item_id))
      return undefined;
    const reference =
      typeof row.pack_reference === "string" ? row.pack_reference : null;
    const pack = packs.get(reference) ?? [];
    pack.push({ cart_item_id: row.id, ...pickScalarFields(row, ROW_FIELDS) });
    packs.set(reference, pack);
  }
  return [...packs].map(([pack_reference, packRows]) => ({
    pack_reference,
    rows: packRows,
  }));
};

const parseValidationIssues = (value: unknown): CartRow[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((entry) => {
    const reference =
      typeof entry.pack_reference === "string" ? entry.pack_reference : null;
    const issues = Array.isArray(entry.issues)
      ? entry.issues.filter(isRecord)
      : [];
    return issues.map((issue) => ({
      pack_reference: reference,
      ...pickScalarFields(issue, ISSUE_FIELDS),
    }));
  });
};

const parseCart = (value: unknown): CartDetail | undefined => {
  if (
    !isRecord(value) ||
    !isPositiveId(value.id) ||
    !isPositiveId(value.vendor_id)
  )
    return undefined;
  if (!Array.isArray(value.cart_items)) return undefined;
  const packs = parsePacks(value.cart_items);
  if (!packs) return undefined;

  const vendorName =
    isRecord(value.vendor) && typeof value.vendor.name === "string"
      ? value.vendor.name
      : undefined;

  return {
    ...pickScalarFields(value, CART_FIELDS),
    ...(vendorName !== undefined && { vendor_name: vendorName }),
    packs,
    validation_issues: parseValidationIssues(value.validation_result),
  };
};

const summarizeCart = (cart: CartDetail): CartSummary => {
  const { packs, validation_issues, ...fields } = cart;
  return {
    ...(fields as Record<string, ScalarValue>),
    pack_count: packs.length,
    row_count: packs.reduce((count, pack) => count + pack.rows.length, 0),
  };
};

const numberField = (group: OptionGroup, field: string) =>
  typeof group[field] === "number" ? (group[field] as number) : undefined;

const isUnavailable = (fields: Record<string, unknown>) =>
  fields.in_stock === false || fields.is_active === false;

class CartService {
  private readonly addresses: AddressService;
  private readonly menus: MenuService;

  constructor(
    private readonly session: UserSession,
    private readonly client = new ChowdeckClient(),
  ) {
    this.addresses = new AddressService(session, client);
    this.menus = new MenuService(session, client);
  }

  private async authHeaders() {
    const headers = await chowdeckAuthHeaders(this.session);
    if (!headers.authorization) throw new NotSignedInError();
    return headers;
  }

  async getVendorCart(restaurantId: number): Promise<VendorCartResult> {
    const headers = await this.authHeaders();
    const path = vendorCartPath(restaurantId);
    const body = await this.client.request(path, { headers });

    const data = isRecord(body) ? body.data : undefined;
    if (isRecord(data) && Object.keys(data).length === 0) {
      return { restaurant_id: restaurantId, exists: false };
    }

    const cart = parseCart(data);
    if (!cart || cart.vendor_id !== restaurantId)
      throw unexpectedShape("GET", path);
    return { restaurant_id: restaurantId, exists: true, cart };
  }

  async listCarts(): Promise<CartListResult> {
    const headers = await this.authHeaders();
    const body = await this.client.request(CART_LIST_PATH, { headers });

    const rawCarts =
      isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
    const carts = rawCarts?.map(parseCart);
    if (!carts || carts.some((cart) => cart === undefined)) {
      throw unexpectedShape("GET", CART_LIST_PATH);
    }

    return {
      returned: carts.length,
      carts: (carts as CartDetail[]).map(summarizeCart),
    };
  }

  /*
   * Only rules supported by the observed contract are enforced: options must
   * belong to their group, per-group selection counts must respect
   * minimum_selection/maximum_selection, and explicitly unavailable items or
   * options are refused. Modifier quantity is always 1; larger quantities and
   * maximum_free_selection have unknown semantics.
   */
  private async resolveModifiers({
    restaurantId,
    menuItemId,
    modifiers,
  }: AddToCartParams) {
    const { item, option_groups: groups } = await this.menus.getMenuItem({
      restaurantId,
      menuItemId,
    });
    if (isUnavailable(item))
      throw new CartRequestError("this menu item is not currently available");

    const chosen = new Set<number>();
    const counts = new Map<number, number>();
    for (const { groupId, optionId } of modifiers) {
      const group = groups.find((g) => g.id === groupId);
      if (!group)
        throw new CartRequestError(
          `option group ${groupId} does not belong to this menu item`,
        );
      const option = group.options.find((o) => o.id === optionId);
      if (!option)
        throw new CartRequestError(
          `option ${optionId} does not belong to option group ${groupId}`,
        );
      if (isUnavailable(option))
        throw new CartRequestError(
          `option ${optionId} is not currently available`,
        );
      if (chosen.has(optionId))
        throw new CartRequestError(
          `option ${optionId} is selected more than once`,
        );
      chosen.add(optionId);
      counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
    }

    for (const group of groups) {
      const count = counts.get(group.id as number) ?? 0;
      const min = numberField(group, "minimum_selection");
      const max = numberField(group, "maximum_selection");
      const label =
        typeof group.name === "string"
          ? `"${group.name}" (${group.id})`
          : `${group.id}`;
      if (min !== undefined && count < min) {
        throw new CartRequestError(
          `option group ${label} requires at least ${min} selection(s)`,
        );
      }
      if (max !== undefined && count > max) {
        throw new CartRequestError(
          `option group ${label} allows at most ${max} selection(s)`,
        );
      }
    }

    return modifiers.map(({ groupId, optionId }) => ({
      id: optionId,
      quantity: 1,
      menu_group_id: groupId,
    }));
  }

  private async assertOwnAddress(addressId: number) {
    const { addresses } = await this.addresses.list();
    if (!addresses.some((address) => address.id === addressId)) {
      throw new CartRequestError(
        "address_id is not one of your saved delivery addresses; call list_addresses to choose one",
      );
    }
  }

  /*
   * Chowdeck creates a cart with POST /customer/cart and adds a new pack to an
   * existing one with POST /customer/cart/vendor/{id}; neither write returns
   * the updated cart, so it is re-read. The existence check and the write are
   * not atomic: a cart created elsewhere in between is not detected here.
   */
  async addToCart(params: AddToCartParams): Promise<AddToCartResult> {
    await this.authHeaders();
    await this.assertOwnAddress(params.addressId);
    const modifiers = await this.resolveModifiers(params);

    const existing = await this.getVendorCart(params.restaurantId);
    const path = existing.exists
      ? vendorCartPath(params.restaurantId)
      : CART_LIST_PATH;
    const response = await this.client.request(path, {
      method: "POST",
      headers: await this.authHeaders(),
      body: {
        ...WEB_CLIENT_FIELDS,
        vendor_id: params.restaurantId,
        items: [
          {
            item_id: params.menuItemId,
            quantity: params.quantity,
            type: "menu",
            modifiers,
          },
        ],
        address_id: params.addressId,
      },
    });

    if (!isRecord(response) || response.status !== "success") {
      throw new ChowdeckApiError(
        "invalid_response",
        `POST ${path} returned an unexpected response; check the cart with get_cart before retrying`,
      );
    }

    const after = await this.getVendorCart(params.restaurantId);
    if (!after.exists)
      throw unexpectedShape("GET", vendorCartPath(params.restaurantId));

    return {
      created_cart: !existing.exists,
      added: {
        menu_item_id: params.menuItemId,
        quantity: params.quantity,
        modifiers: modifiers.length,
      },
      cart: after.cart,
    };
  }
}

export default CartService;
