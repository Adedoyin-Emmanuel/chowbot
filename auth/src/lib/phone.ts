/*
 * Nigerian mobile numbers, entered after a fixed +234 prefix. Mirrors
 * NIGERIAN_PHONE_PATTERN in mcp-server/features/auth/service.ts, which has
 * the final say.
 */
export const COUNTRIES = [
  { code: "NG", name: "Nigeria", dialCode: "+234" },
] as const;

export type CountryCode = (typeof COUNTRIES)[number]["code"];

const NATIONAL_NUMBER = /^[789][01]\d{8}$/;
export const NATIONAL_NUMBER_LENGTH = 10;

/*
 * Accepts what people paste or type: 0801…, 801…, +234 801…, 234801…,
 * with spaces or dashes. A Nigerian national number never starts with 2,
 * so dropping a leading 234 is safe.
 */
export const nationalDigits = (input: string) => {
  let digits = input.replace(/\D/g, "");
  if (digits.startsWith("234")) digits = digits.slice(3);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return digits.slice(0, NATIONAL_NUMBER_LENGTH);
};

/*
 * What the phone field shows: the digits as typed, keeping a leading 0 so
 * 0801… reads the way people write it. A pasted +234 is dropped, since the
 * field already shows the dial code.
 */
export const localDigits = (input: string) => {
  const national = nationalDigits(input);
  return input.replace(/\D/g, "").startsWith("0") ? `0${national}` : national;
};

export const isValidNational = (digits: string) => NATIONAL_NUMBER.test(digits);

export const toInternational = (digits: string, dialCode = "+234") =>
  `${dialCode}${digits}`;
