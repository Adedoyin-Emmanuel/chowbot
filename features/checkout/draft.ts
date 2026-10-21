import { isRecord } from "../../utils/object";

/*
 * User-chosen checkout extras that the storefront keeps in local state and
 * sends only with the order (storefront chunk 3488 handleCheckout, read
 * 2026-10-21): promo codes, the rider tip and gift details. ChowBot keeps no
 * draft state: these are validated from tool arguments on every call.
 *
 * Evidence, from the website's code:
 *   promo_codes: [promo?.code, discount?.code].filter(Boolean), else []
 *   tip:         sent only when truthy, as Math.round(100 * naira) (raw x100)
 *   gift_recipient: the gift form's values (below), or null; null for pickup
 */

export const CONFIG_PATH = "/customer/config";
export const PHONE_VALIDATE_PATH = "/auth/phone/validate";

type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });
const CONTROL = /[\u0000-\u001F\u007F]/;
const codePoints = (value: string) => [...value].length;

/*
 * Promo code. Chowdeck's own code format is unknown, so this is ChowBot's
 * conservative rule: 1-40 letters, digits, "_" or "-", trimmed, case kept as
 * entered (the website sends the code object's `code` unchanged).
 */
export const PROMO_CODE_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export const validatePromoCode = (input: string): Validation<string> => {
  const code = input.trim();
  return PROMO_CODE_PATTERN.test(code)
    ? { ok: true, value: code }
    : fail("must be 1-40 letters, digits, '_' or '-' (ChowBot's rule; Chowdeck's own format is unknown)");
};

/*
 * Tip limits from GET /customer/config: data.delivery_driver_tips_config
 * with minimum_tip_amount / maximum_tip_amount (raw x100) and
 * recommendation_percent. The website shows no tip control at all when
 * recommendation_percent is absent, so tips are then unavailable.
 */
export type TipConfig = { available: boolean; minimum: number; maximum: number };

export const parseTipConfig = (body: unknown): TipConfig | undefined => {
  const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
  if (!data) return undefined;
  const tips = isRecord(data.delivery_driver_tips_config) ? data.delivery_driver_tips_config : undefined;
  if (!tips) return { available: false, minimum: 0, maximum: 0 };
  const amount = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0);
  return {
    available: Array.isArray(tips.recommendation_percent) && tips.recommendation_percent.length > 0,
    minimum: amount(tips.minimum_tip_amount),
    maximum: amount(tips.maximum_tip_amount),
  };
};

export type TipChoice =
  | { kind: "none"; reason: string }
  | { kind: "amount"; raw: number; naira: number; display: string };

export const formatNaira = (raw: number) =>
  `₦${(raw / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/*
 * A tip the user chose, in naira, converted to Chowdeck's raw x100 units
 * exactly once (the website's Math.round(100 * value)). Unlike the website,
 * more than two decimal places are refused rather than rounded. 0 is no tip,
 * as the website never sends tip: 0. The website's bounds are inclusive:
 * below the minimum, or above a positive maximum, is refused.
 */
export const tipFromNaira = (naira: number, config: TipConfig | undefined): Validation<TipChoice> => {
  if (!Number.isFinite(naira) || naira < 0) return fail("must be a number of naira, 0 or more");
  const scaled = naira * 100;
  const raw = Math.round(scaled);
  if (Math.abs(scaled - raw) > 1e-6) return fail("must have at most two decimal places (kobo)");
  if (raw === 0) return { ok: true, value: { kind: "none", reason: "a tip of 0 is no tip; the website never sends tip: 0" } };
  if (!Number.isSafeInteger(raw)) return fail("is too large");
  if (!config) return fail("cannot be checked: Chowdeck's tip limits could not be read");
  if (!config.available) return fail("is not available: Chowdeck's configuration offers no rider tips");
  if (raw < config.minimum) return fail(`must be at least ${formatNaira(config.minimum)}`);
  if (config.maximum > 0 && raw > config.maximum) return fail(`must be at most ${formatNaira(config.maximum)}`);
  return { ok: true, value: { kind: "amount", raw, naira: raw / 100, display: formatNaira(raw) } };
};

/*
 * Gift recipient, in the website's gift form shape (storefront module
 * 64834): phone must match /^[0-9]+$/ (digits only; the country is chosen
 * separately as country_code, a two-letter code such as "NG"), donor_name,
 * name and country_code must be non-empty, email must be valid or blank,
 * message is optional, and the object sent is { country_code, phone
 * (trimmed), donor_name, name, email?, message (trimmed),
 * save_as_beneficiary }. The website then checks the phone with
 * POST /auth/phone/validate {phone, country_code} and reads
 * data.data.is_valid; ChowBot does not call it, so the phone is unverified.
 * The 7-15 digit range and the length limits are ChowBot's rules.
 */
export type GiftRecipientInput = {
  donor_name: string;
  name: string;
  phone: string;
  country_code?: string;
  email?: string;
  message?: string;
  save_as_beneficiary?: boolean;
};

export type GiftRecipient = {
  country_code: string;
  phone: string;
  donor_name: string;
  name: string;
  email?: string;
  message: string;
  save_as_beneficiary: boolean;
};

const MAX_NAME = 100;
const MAX_GIFT_MESSAGE = 500;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9]+$/;

/*
 * Only the message may span lines (\n or \r\n); names are single-line.
 */
const textField = (
  label: string,
  value: string | undefined,
  max: number,
  required: boolean,
  multiline = false,
): Validation<string> => {
  const trimmed = (value ?? "").trim();
  if (required && !trimmed) return fail(`${label} is required`);
  if (CONTROL.test(multiline ? trimmed.replace(/\r?\n/g, "") : trimmed)) return fail(`${label} contains control characters`);
  if (codePoints(trimmed) > max) return fail(`${label} is longer than ${max} characters`);
  return { ok: true, value: trimmed };
};

export const validateGiftRecipient = (input: GiftRecipientInput): Validation<GiftRecipient> => {
  const donor = textField("donor_name", input.donor_name, MAX_NAME, true);
  if (!donor.ok) return donor;
  const name = textField("name", input.name, MAX_NAME, true);
  if (!name.ok) return name;
  const message = textField("message", input.message, MAX_GIFT_MESSAGE, false, true);
  if (!message.ok) return message;

  const phone = (input.phone ?? "").trim();
  const digits = phone.replace(/\D/g, "").length;
  if (!phone) return fail("phone is required");
  if (!PHONE.test(phone) || digits < 7 || digits > 15) {
    return fail("phone must be 7-15 digits only, without + or spaces; give the country separately as country_code");
  }
  const country = (input.country_code ?? "NG").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return fail("country_code must be a two-letter country code such as NG");
  const email = (input.email ?? "").trim();
  if (email && (!EMAIL.test(email) || email.length > 254)) return fail("email is not a valid email address");

  return {
    ok: true,
    value: {
      country_code: country,
      phone,
      donor_name: donor.value,
      name: name.value,
      ...(email && { email }),
      message: message.value,
      save_as_beneficiary: input.save_as_beneficiary === true,
    },
  };
};
