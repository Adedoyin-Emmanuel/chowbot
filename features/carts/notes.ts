/*
 * The two checkout notes Chowdeck keeps on the cart; the order copies both
 * from it. Clearing sends "". The length limit is ChowBot's own.
 */

export const NOTE_FIELDS = {
  vendor: "customer_vendor_note",
  delivery: "customer_delivery_note",
} as const;

export type NoteKind = keyof typeof NOTE_FIELDS;

export const MAX_NOTE_LENGTH = 500;

// Control characters other than newline and tab.
const DISALLOWED = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export type NoteValidation = { ok: true; value: string } | { ok: false; error: string };

// null, "" or whitespace-only clears the note. Length is in code points.
export const validateNote = (input: string | null): NoteValidation => {
  if (input === null) return { ok: true, value: "" };
  const value = input.trim();
  if (DISALLOWED.test(value)) return { ok: false, error: "contains control characters" };
  if ([...value].length > MAX_NOTE_LENGTH) {
    return { ok: false, error: `is longer than ${MAX_NOTE_LENGTH} characters (ChowBot's limit; Chowdeck's own limit is unknown)` };
  }
  return { ok: true, value };
};

export const storedNote = (raw: Record<string, unknown> | undefined, kind: NoteKind) => {
  const value = raw?.[NOTE_FIELDS[kind]];
  return typeof value === "string" ? value : "";
};
