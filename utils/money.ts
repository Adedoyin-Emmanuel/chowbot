/*
 * Chowdeck sends money in kobo (₦1 = 100). Tool results show naira only:
 * every money field below becomes a "₦1,234.50" string when the result is
 * serialised, and *_raw fields kept for internal comparisons are left out.
 */
export const formatNaira = (raw: number) =>
  `₦${(raw / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MONEY_FIELDS = new Set([
  "amount",
  "amount_off",
  "bag_fee",
  "bogof_amount_off",
  "container_fee",
  "delivery_fee",
  "delivery_price",
  "discount_price",
  "discount_price_per_quantity",
  "discount_total_price",
  "final_delivery_amount",
  "final_service_amount",
  "items_price",
  "mark_up_price",
  "maximum_order_amount",
  "minimum_order_amount",
  "original_items_price",
  "original_total_price",
  "price",
  "price_per_quantity",
  "promo_code_price",
  "refund_amount",
  "safety_fee",
  "service_amount",
  "service_price",
  "small_order_amount",
  "small_order_price",
  "tip_amount",
  "tips_total",
  "total_balance",
  "total_price",
  "voucher_amount",
  "vendor_discount_amount",
]);

export const nairaReplacer = (key: string, value: unknown) => {
  if (key.endsWith("_raw")) return undefined;
  return typeof value === "number" && Number.isFinite(value) && MONEY_FIELDS.has(key) ? formatNaira(value) : value;
};

export const toNairaJson = (value: unknown) => JSON.stringify(value, nairaReplacer);
