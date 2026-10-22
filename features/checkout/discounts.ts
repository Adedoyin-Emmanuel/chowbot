import { isRecord } from "../../utils/object";
import { ChowdeckApiError } from "../../lib/client";

/*
 * Chowdeck's discount calculation, built exactly as the storefront builds it
 * (chunk 6117 module 64269 `P` for the packs; chunk 3488 for the request;
 * read 2026-10-21). The website runs
 * it on every cart, fee or promo change and on window focus, which is why it
 * is treated as a calculation rather than a change to anything.
 *
 * Observed on the wire 2026-10-22 (promo code 5FOR5, free delivery): the
 * website sends the fee quote's id and final_delivery_amount, and each
 * returned discount carries discount_id, title, description, amount_off,
 * target ("deliveryfees"), discount_terms and the promo_code it came from.
 */

export const DISCOUNT_APPLY_PATH = "/customer/discount/apply";

type Row = Record<string, unknown>;

export type DiscountOrderItem =
  | { item_id: unknown; quantity: unknown; type: unknown; pack_id: number; pack_unique_id: unknown }
  | { item_id: unknown; price: number; quantity: unknown; type: "group"; pack_id: number; group_id: unknown };

export type DiscountContainer = {
  id: unknown;
  quantity: unknown;
  name: unknown;
  price: unknown;
  type: unknown;
  pack_id: number;
};

/*
 * The website's H(price, discount): the discount price when it is
 * non-negative and below the price, otherwise the price (0 when absent).
 */
export const effectivePrice = (price: unknown, discount: unknown) => {
  const base = typeof price === "number" ? price : 0;
  return typeof discount === "number" && discount >= 0 && discount < base ? discount : base;
};

/*
 * JavaScript orders integer-like object keys numerically before other keys,
 * which decides the order the website emits modifier groups in.
 */
const objectKeyOrder = (keys: string[]) => {
  const integer = keys.filter((k) => /^(0|[1-9]\d*)$/.test(k)).sort((a, b) => Number(a) - Number(b));
  return [...integer, ...keys.filter((k) => !/^(0|[1-9]\d*)$/.test(k))];
};

/*
 * order_items and containers from the cart's rows, as the website derives
 * them: packs in order of their first row's pack_reference (pack_id is the
 * 1-based position); each menu row carries every group row of its pack,
 * grouped by menu_group_id; container rows are listed separately.
 */
export const discountOrderLines = (cartItems: unknown[]) => {
  const rows = cartItems.filter(isRecord) as Row[];
  const packOrder: unknown[] = [];
  for (const row of rows) if (!packOrder.includes(row.pack_reference)) packOrder.push(row.pack_reference);

  const order_items: DiscountOrderItem[] = [];
  const containers: DiscountContainer[] = [];
  packOrder.forEach((reference, index) => {
    const packId = index + 1;
    const pack = rows.filter((row) => row.pack_reference === reference);
    const groups = pack.filter((row) => row.type === "group");
    const byGroup = new Map<string, Row[]>();
    for (const group of groups) {
      const key = String(group.menu_group_id);
      byGroup.set(key, [...(byGroup.get(key) ?? []), group]);
    }

    for (const menu of pack.filter((row) => row.type === "menu")) {
      order_items.push({
        item_id: menu.item_id,
        quantity: menu.quantity ?? 0,
        type: menu.type || "menu",
        pack_id: packId,
        pack_unique_id: reference,
      });
      for (const key of objectKeyOrder([...byGroup.keys()])) {
        for (const group of byGroup.get(key)!) {
          order_items.push({
            item_id: group.item_id,
            price: effectivePrice(group.price_per_quantity, group.discount_price),
            quantity: group.quantity,
            type: "group",
            pack_id: packId,
            group_id: group.menu_group_id,
          });
        }
      }
    }
    for (const container of pack.filter((row) => row.type === "container")) {
      containers.push({
        id: container.item_id,
        quantity: container.quantity ?? 0,
        name: container.name,
        price: container.price_per_quantity ?? 0,
        type: container.type,
        pack_id: packId,
      });
    }
  });
  return { order_items, containers };
};

export type AppliedDiscount = {
  target: string | null;
  amount_off: number;
  bogof_amount_off: number;
  promo_code: string | null;
  title?: string;
  description?: string;
  terms?: string;
};

/*
 * The website reads the response's data as a list of applied discounts and
 * totals amount_off + (bogof_amount_off || 0); it treats a missing list as
 * none. Anything else is refused rather than guessed at.
 */
export const parseAppliedDiscounts = (body: unknown): AppliedDiscount[] => {
  const unexpected = new ChowdeckApiError(
    "invalid_response",
    `POST ${DISCOUNT_APPLY_PATH} returned an unexpected response shape`,
  );
  if (!isRecord(body)) throw unexpected;
  if (body.data === undefined || body.data === null) return [];
  if (!Array.isArray(body.data)) throw unexpected;
  return body.data.map((entry) => {
    if (!isRecord(entry) || typeof entry.amount_off !== "number" || !Number.isFinite(entry.amount_off)) throw unexpected;
    const bogof = entry.bogof_amount_off;
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
    const title = text(entry.title);
    const description = text(entry.description);
    const terms = text(entry.discount_terms);
    return {
      target: typeof entry.target === "string" ? entry.target : null,
      amount_off: entry.amount_off,
      bogof_amount_off: typeof bogof === "number" && Number.isFinite(bogof) ? bogof : 0,
      promo_code: text(entry.promo_code) ?? null,
      ...(title && { title }),
      ...(description && { description }),
      ...(terms && { terms }),
    };
  });
};

export const totalOff = (discounts: AppliedDiscount[]) =>
  discounts.reduce((sum, d) => sum + d.amount_off + d.bogof_amount_off, 0);

/*
 * The discounts Chowdeck attributes to a code, matched by the promo_code each
 * returned discount carries (codes compared without regard to case).
 */
export const discountsForCode = (discounts: AppliedDiscount[], code: string) =>
  discounts.filter((d) => d.promo_code !== null && d.promo_code.toUpperCase() === code.toUpperCase());

/*
 * The website's request body. Without a fee quote, fee_id and delivery_fee
 * take the website's own fallbacks (|| 0), and discounts on delivery fees are
 * then not evaluated; get_checkout_quote passes its fresh quote's values.
 */
export const discountRequestBody = (input: {
  promoCode?: string;
  vendorId: number;
  addressId: number;
  cart: Record<string, unknown>;
  orderClass: string;
  fee?: { id: number; deliveryFee: number };
}) => {
  const lines = discountOrderLines(Array.isArray(input.cart.cart_items) ? input.cart.cart_items : []);
  return {
    promo_codes: input.promoCode ? [input.promoCode] : [],
    vendor_id: input.vendorId,
    address_id: input.addressId,
    fee_id: input.fee?.id ?? 0,
    ...(input.cart.id ? { cart_id: input.cart.id } : {}),
    currency: input.cart.currency,
    order_items: lines.order_items,
    containers: lines.containers,
    delivery_fee: input.fee?.deliveryFee ?? 0,
    order_class: input.orderClass === "vendor_delivery" ? "delivery" : input.orderClass,
  };
};
