/*
 * The two checkout notes Chowdeck keeps on the cart. The storefront saves
 * each with POST /customer/cart/vendor/{vendor_id} and a one-field body,
 * {customer_vendor_note} or {customer_delivery_note}, and the order payload
 * copies both from the cart (storefront chunk 3488 handleCheckout and the
 * checkout page chunk, read 2026-10-21). Clearing sends "", as a new cart
 * starts with "". The website's note inputs set no maxLength, so the length
 * limit below is ChowBot's own, not Chowdeck's.
 */

export const NOTE_FIELDS = {
  vendor: "customer_vendor_note",
  delivery: "customer_delivery_note",
} as const;

export type NoteKind = keyof typeof NOTE_FIELDS;

export const MAX_NOTE_LENGTH = 500;

/*
 * Control characters other than newline and tab are refused; any other
 * Unicode text is kept as written, apart from trimming the ends.
 */
const DISALLOWED = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export type NoteValidation = { ok: true; value: string } | { ok: false; error: string };

/*
 * null, "" or whitespace-only clears the note. Length is counted in Unicode
 * code points, so emoji and accented text count as the reader sees them.
 */
export const validateNote = (input: string | null): NoteValidation => {
  if (input === null) return { ok: true, value: "" };
  const value = input.trim();
  if (DISALLOWED.test(value)) return { ok: false, error: "contains control characters" };
  if ([...value].length > MAX_NOTE_LENGTH) {
    return { ok: false, error: `is longer than ${MAX_NOTE_LENGTH} characters (ChowBot's limit; Chowdeck's own limit is unknown)` };
  }
  return { ok: true, value };
};

/*
 * A note as stored on the cart: a string, or absent/null (no note).
 */
export const storedNote = (raw: Record<string, unknown> | undefined, kind: NoteKind) => {
  const value = raw?.[NOTE_FIELDS[kind]];
  return typeof value === "string" ? value : "";
};
