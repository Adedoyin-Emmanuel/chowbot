import {
  isRecord,
  pickScalarFields,
  type ScalarValue,
} from "../../utils/object";
import MenuService, { type OptionGroup } from "../menus/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import AddressService, { NotSignedInError } from "../addresses/service";
import { NOTE_FIELDS, storedNote, validateNote, type NoteKind } from "./notes";
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
  quantity: number;
  addressId: number;
  menuItemId: number;
  restaurantId: number;
  modifiers: ModifierChoice[];
};

export type DuplicatePackResult = {
  cart: CartDetail;
  new_pack_reference: string;
  duplicated_pack_reference: string;
};

export type RemovePackResult =
  | {
      cart: CartDetail;
      cart_exists: true;
      restaurant_id: number;
      removed_pack_reference: string;
    }
  | {
      cart_exists: false;
      restaurant_id: number;
      removed_pack_reference: string;
    };

export type ClearCartResult = {
  cleared: boolean;
  removed_packs: number;
  restaurant_id: number;
  cart_existed: boolean;
};

export type AddToCartResult = {
  cart: CartDetail;
  created_cart: boolean;
  added: { menu_item_id: number; quantity: number; modifiers: number };
};

/*
 * A request ChowBot refuses before writing to Chowdeck. Messages never
 * include private values such as address IDs.
 */
export type CartNotes = {
  restaurant_id: number;
  cart_id: ScalarValue;
  vendor_note: string;
  delivery_note: string;
};

/*
 * What set_cart_notes reports per note: what was sent, and whether the cart
 * re-read afterwards holds exactly that ("verified"), something else
 * ("mismatch"), or could not be read ("unverified").
 */
export type NoteUpdate = {
  sent: string;
  stored?: string;
  verification: "verified" | "mismatch" | "unverified";
};

export type SetCartNotesResult = {
  restaurant_id: number;
  updated: Partial<Record<NoteKind, NoteUpdate>>;
  confirmed_by_chowdeck: boolean;
  message: string;
  notes?: CartNotes;
  verification_error?: string;
};

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

/*
 * Whether Chowdeck still treats a cart as an editable basket. Observed
 * 2026-10-22: a cart stays active with order_id null after unpaid orders are
 * created from it (cart 31006911 was reused for six orders), so an order is a
 * copy of the cart and later edits do not reach it. A cart Chowdeck links to
 * an order (order_id set) or reports as not active was never observed; ChowBot
 * does not edit one.
 */
export const cartEditability = (value: Record<string, unknown>): Record<string, ScalarValue> | undefined => {
  const orderId = value.order_id;
  if (orderId !== null && orderId !== undefined) {
    return {
      editable: false,
      linked_order_id: typeof orderId === "number" || typeof orderId === "string" ? orderId : null,
      not_editable_reason: `Chowdeck links this cart to order ${String(orderId)}`,
    };
  }
  if (value.is_active === false || (typeof value.status === "string" && value.status !== "active")) {
    return {
      editable: false,
      not_editable_reason: `Chowdeck reports this cart as ${typeof value.status === "string" ? value.status : "not active"}`,
    };
  }
  return undefined;
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
    ...cartEditability(value),
    packs,
    validation_issues: parseValidationIssues(value.validation_result),
  };
};

/*
 * A stable digest of what a cart would order: every pack, row id, item,
 * type, quantity and option group, plus the server's total. Any add,
 * removal, duplicate, quantity change or repricing changes it.
 */
export const cartFingerprint = (cart: CartDetail) => {
  const packs = cart.packs
    .map((pack) => ({
      pack: pack.pack_reference,
      rows: pack.rows
        .map((row) => [row.cart_item_id, row.item_id, row.type, row.quantity, row.menu_group_id ?? null])
        .sort((a, b) => Number(a[0]) - Number(b[0])),
    }))
    .sort((a, b) => String(a.pack).localeCompare(String(b.pack)));
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ packs, total: cart.total_price ?? null }))
    .digest("hex");
};

/*
 * Refuses a change to a cart Chowdeck no longer treats as editable.
 */
const assertEditable = (cart: CartDetail) => {
  if (cart.editable === false) {
    throw new CartRequestError(
      `${cart.not_editable_reason}; ChowBot does not change it, because editing this cart would not change that order. Check the order with get_order or get_order_submission`,
    );
  }
};

const summarizeCart = (cart: CartDetail): CartSummary => {
  const { packs, validation_issues, ...fields } = cart;
  return {
    ...(fields as Record<string, ScalarValue>),
    pack_count: packs.length,
    row_count: packs.reduce((count, pack) => count + pack.rows.length, 0),
  };
};

const duplicatePackPath = (cartId: number, packReference: string) =>
  `/customer/cart/${cartId}/pack/${encodeURIComponent(packReference)}/duplicate`;

/*
 * Rows are compared by what was ordered, not by their server-generated IDs,
 * so a duplicated pack can be recognised in the re-read cart.
 */
const packContents = (pack: CartPack) =>
  pack.rows
    .map((row) =>
      [row.type, row.item_id, row.menu_group_id ?? "", row.quantity].join(":"),
    )
    .sort()
    .join("|");

/*
 * The write may or may not have happened, so the caller must look before
 * repeating it.
 */
const uncertainOutcome = (detail: string) =>
  new ChowdeckApiError(
    "invalid_response",
    `${detail}; check the cart with get_cart before retrying`,
  );

const isDefiniteRejection = (error: ChowdeckApiError) =>
  error.kind === "http" && error.status !== undefined && error.status < 500;

const cartPath = (cartId: number) => `/customer/cart/${cartId}`;

const packPath = (cartId: number, packReference: string) =>
  `/customer/cart/${cartId}/pack/${encodeURIComponent(packReference)}`;

/*
 * A pack's identity (reference and row IDs) plus what it contains, so an
 * untouched pack can be told apart from one that changed or was replaced.
 */
const packFingerprint = (pack: CartPack) =>
  [
    pack.pack_reference,
    pack.rows
      .map((row) => row.cart_item_id)
      .sort()
      .join(","),
    packContents(pack),
  ].join("#");

const samePacks = (left: CartPack[], right: CartPack[]) => {
  const fingerprints = (packs: CartPack[]) =>
    packs.map(packFingerprint).sort().join("\n");
  return (
    left.length === right.length && fingerprints(left) === fingerprints(right)
  );
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
    return (await this.getVendorCartSnapshot(restaurantId)).result;
  }

  /*
   * Also hands back the raw cart for server-side use (an order payload
   * copies fields that the sanitized cart leaves out). The raw object must
   * never be returned to a caller.
   */
  async getVendorCartSnapshot(
    restaurantId: number,
  ): Promise<{ result: VendorCartResult; raw?: Record<string, unknown> }> {
    const headers = await this.authHeaders();
    const path = vendorCartPath(restaurantId);
    const body = await this.client.request(path, { headers });

    const data = isRecord(body) ? body.data : undefined;
    if (isRecord(data) && Object.keys(data).length === 0) {
      return { result: { restaurant_id: restaurantId, exists: false } };
    }

    const cart = parseCart(data);
    if (!cart || cart.vendor_id !== restaurantId)
      throw unexpectedShape("GET", path);
    return {
      result: { restaurant_id: restaurantId, exists: true, cart },
      raw: data as Record<string, unknown>,
    };
  }

  /*
   * The restaurant and delivery notes on the user's own cart at a restaurant.
   */
  async getNotes(restaurantId: number): Promise<CartNotes> {
    const { result, raw } = await this.getVendorCartSnapshot(restaurantId);
    if (!result.exists) {
      throw new CartRequestError("there is no cart for this restaurant; add an item first");
    }
    return {
      restaurant_id: restaurantId,
      cart_id: result.cart.id as ScalarValue,
      vendor_note: storedNote(raw, "vendor"),
      delivery_note: storedNote(raw, "delivery"),
    };
  }

  /*
   * Sets or clears the notes as the storefront does: one
   * POST /customer/cart/vendor/{id} per note, with only that field, on the
   * user's existing cart for this restaurant. Each write is sent once; an
   * unknown outcome stops further writes and is reported, never retried.
   * The cart is then re-read to confirm what Chowdeck stored.
   */
  async setNotes(
    restaurantId: number,
    notes: Partial<Record<NoteKind, string | null>>,
  ): Promise<SetCartNotesResult> {
    const values: Partial<Record<NoteKind, string>> = {};
    for (const kind of ["vendor", "delivery"] as const) {
      if (!(kind in notes)) continue;
      const checked = validateNote(notes[kind] ?? null);
      if (!checked.ok) throw new CartRequestError(`the ${kind} note ${checked.error}`);
      values[kind] = checked.value;
    }
    if (Object.keys(values).length === 0) {
      throw new CartRequestError("give vendor_note and/or delivery_note (null or an empty string clears one)");
    }

    const headers = await this.authHeaders();
    const before = await this.getVendorCart(restaurantId);
    if (!before.exists) {
      throw new CartRequestError("there is no cart for this restaurant; add an item first");
    }
    assertEditable(before.cart);

    const path = vendorCartPath(restaurantId);
    const updated: SetCartNotesResult["updated"] = {};
    for (const kind of ["vendor", "delivery"] as const) {
      const value = values[kind];
      if (value === undefined) continue;
      let response: unknown;
      try {
        response = await this.client.request(path, {
          method: "POST",
          headers,
          body: { [NOTE_FIELDS[kind]]: value },
        });
      } catch (error) {
        if (error instanceof ChowdeckApiError && isDefiniteRejection(error)) {
          throw new ChowdeckApiError(
            "http",
            `${error.message}; the ${kind} note was not saved${Object.keys(updated).length ? " (the earlier note was saved)" : ""}`,
            error.status,
          );
        }
        throw uncertainOutcome(
          `${error instanceof ChowdeckApiError ? error.message : "unexpected error"}; the ${kind} note may or may not have been saved`,
        );
      }
      if (!isRecord(response) || response.status !== "success") {
        throw uncertainOutcome(`POST ${path} returned an unexpected response; the ${kind} note may or may not have been saved`);
      }
      updated[kind] = { sent: value, verification: "unverified" };
    }

    try {
      const after = await this.getNotes(restaurantId);
      for (const kind of ["vendor", "delivery"] as const) {
        const update = updated[kind];
        if (!update) continue;
        update.stored = kind === "vendor" ? after.vendor_note : after.delivery_note;
        update.verification = update.stored === update.sent ? "verified" : "mismatch";
      }
      const confirmed = Object.values(updated).every((update) => update.verification === "verified");
      return {
        restaurant_id: restaurantId,
        updated,
        confirmed_by_chowdeck: confirmed,
        message: confirmed
          ? "Chowdeck's cart, read again after the change, holds exactly these notes; an order placed from this cart carries them."
          : "Chowdeck's cart, read again after the change, holds a different value for at least one note (see updated); do not tell the user it was saved as written.",
        notes: after,
      };
    } catch (error) {
      return {
        restaurant_id: restaurantId,
        updated,
        confirmed_by_chowdeck: false,
        message:
          "Chowdeck answered the change with success, but the cart could not be read again, so the saved notes are not confirmed. Check them with get_cart_notes before ordering; do not tell the user they were saved.",
        verification_error: `the cart could not be re-read to confirm the notes (${error instanceof Error ? error.message : "unexpected error"})`,
      };
    }
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
    if (existing.exists) assertEditable(existing.cart);
    const path = existing.exists
      ? vendorCartPath(params.restaurantId)
      : CART_LIST_PATH;
    /*
     * Each add creates a new pack, so a repeated request after an unknown
     * outcome could add the item twice. Only a 4xx is a definite rejection.
     */
    let response: unknown;
    try {
      response = await this.client.request(path, {
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
    } catch (error) {
      if (error instanceof ChowdeckApiError && !isDefiniteRejection(error)) {
        throw uncertainOutcome(
          `${error.message}; the item may or may not have been added`,
        );
      }
      throw error;
    }

    if (!isRecord(response) || response.status !== "success") {
      throw uncertainOutcome(`POST ${path} returned an unexpected response`);
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

  /*
   * The cart ID comes from the user's own cart, never from the caller. The
   * duplicate endpoint takes no body and returns no cart, so the cart is
   * re-read and the copy is confirmed by its contents. A cart changed
   * elsewhere between the read and the write is not detected.
   */
  async duplicatePack(
    restaurantId: number,
    packReference: string,
  ): Promise<DuplicatePackResult> {
    const before = await this.getVendorCart(restaurantId);
    if (!before.exists) {
      throw new CartRequestError("there is no cart for this restaurant");
    }
    assertEditable(before.cart);
    const original = before.cart.packs.find(
      (pack) => pack.pack_reference === packReference,
    );
    if (!original) {
      throw new CartRequestError(
        "pack_reference is not in your current cart for this restaurant; call get_cart to see its packs",
      );
    }

    const path = duplicatePackPath(before.cart.id as number, packReference);
    let response: unknown;
    try {
      response = await this.client.request(path, {
        method: "POST",
        headers: await this.authHeaders(),
      });
    } catch (error) {
      if (error instanceof ChowdeckApiError && !isDefiniteRejection(error)) {
        throw uncertainOutcome(
          `${error.message}; the pack may or may not have been duplicated`,
        );
      }
      throw error;
    }

    if (!isRecord(response) || response.status !== "success") {
      throw uncertainOutcome(`POST ${path} returned an unexpected response`);
    }

    let after: VendorCartResult;
    try {
      after = await this.getVendorCart(restaurantId);
    } catch (error) {
      const reason =
        error instanceof ChowdeckApiError ? error.message : "unexpected error";
      throw uncertainOutcome(
        `Chowdeck reported the pack duplicated, but re-reading the cart failed (${reason})`,
      );
    }

    const knownReferences = new Set(
      before.cart.packs.map((pack) => pack.pack_reference),
    );
    const copies = after.exists
      ? after.cart.packs.filter(
          (pack) =>
            pack.pack_reference !== null &&
            !knownReferences.has(pack.pack_reference) &&
            packContents(pack) === packContents(original),
        )
      : [];
    const originalKept =
      after.exists &&
      after.cart.packs.some((pack) => pack.pack_reference === packReference);

    if (!after.exists || !originalKept || copies.length !== 1) {
      throw uncertainOutcome(
        "Chowdeck reported the pack duplicated, but the re-read cart does not show exactly one new copy of it",
      );
    }

    return {
      duplicated_pack_reference: packReference,
      new_pack_reference: copies[0]!.pack_reference as string,
      cart: after.cart,
    };
  }

  /*
   * Sends a bodiless DELETE once. A 4xx is a definite rejection; anything
   * else that is not a success envelope leaves the outcome unknown. Never
   * retried.
   */
  private async sendCartDeletion(path: string, outcome: string) {
    let response: unknown;
    try {
      response = await this.client.request(path, {
        method: "DELETE",
        headers: await this.authHeaders(),
      });
    } catch (error) {
      if (error instanceof ChowdeckApiError && !isDefiniteRejection(error)) {
        throw uncertainOutcome(`${error.message}; ${outcome}`);
      }
      throw error;
    }
    if (!isRecord(response) || response.status !== "success") {
      throw uncertainOutcome(`DELETE ${path} returned an unexpected response`);
    }
  }

  private async rereadAfter(restaurantId: number, accepted: string) {
    try {
      return await this.getVendorCart(restaurantId);
    } catch (error) {
      const reason =
        error instanceof ChowdeckApiError ? error.message : "unexpected error";
      throw uncertainOutcome(
        `Chowdeck reported ${accepted}, but re-reading the cart failed (${reason})`,
      );
    }
  }

  /*
   * Removes one pack with the endpoint behind the website's trash icon. The
   * cart ID comes from the user's own cart. Every other pack must survive
   * unchanged. Removing the last pack was never observed, so either an
   * empty cart or no cart afterwards is accepted.
   */
  async removePack(
    restaurantId: number,
    packReference: string,
  ): Promise<RemovePackResult> {
    const before = await this.getVendorCart(restaurantId);
    if (!before.exists) {
      throw new CartRequestError("there is no cart for this restaurant");
    }
    assertEditable(before.cart);
    if (
      !before.cart.packs.some((pack) => pack.pack_reference === packReference)
    ) {
      throw new CartRequestError(
        "pack_reference is not in your current cart for this restaurant; call get_cart to see its packs",
      );
    }
    const others = before.cart.packs.filter(
      (pack) => pack.pack_reference !== packReference,
    );

    await this.sendCartDeletion(
      packPath(before.cart.id as number, packReference),
      "the pack may or may not have been removed",
    );
    const after = await this.rereadAfter(restaurantId, "the pack removed");

    const verified = after.exists
      ? samePacks(after.cart.packs, others)
      : others.length === 0;
    if (!verified) {
      throw uncertainOutcome(
        "Chowdeck reported the pack removed, but the re-read cart does not show only that pack gone",
      );
    }

    return after.exists
      ? {
          restaurant_id: restaurantId,
          removed_pack_reference: packReference,
          cart_exists: true,
          cart: after.cart,
        }
      : {
          restaurant_id: restaurantId,
          removed_pack_reference: packReference,
          cart_exists: false,
        };
  }

  /*
   * Deletes this restaurant's cart, resolved from the user's own cart
   * response, so no other restaurant's cart can be targeted.
   */
  async clearCart(restaurantId: number): Promise<ClearCartResult> {
    const before = await this.getVendorCart(restaurantId);
    if (!before.exists) {
      return {
        restaurant_id: restaurantId,
        cart_existed: false,
        cleared: false,
        removed_packs: 0,
      };
    }
    assertEditable(before.cart);

    await this.sendCartDeletion(
      cartPath(before.cart.id as number),
      "the cart may or may not have been deleted",
    );
    const after = await this.rereadAfter(restaurantId, "the cart deleted");
    if (after.exists) {
      throw uncertainOutcome(
        "Chowdeck reported the cart deleted, but the re-read still shows a cart for this restaurant",
      );
    }

    return {
      restaurant_id: restaurantId,
      cart_existed: true,
      cleared: true,
      removed_packs: before.cart.packs.length,
    };
  }
}

export default CartService;
