/*
 * Nigerian mobile numbers, entered after a fixed +234 prefix. Mirrors
 * NIGERIAN_PHONE_PATTERN in mcp-server/features/auth/service.ts, which has
 * the final say.
 */
export const COUNTRIES = [
  { code: "NG", name: "Nigeria", dialCode: "+234", flag: "🇳🇬" },
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

// 8012345678 → "801 234 5678", as the number is typed.
export const formatNational = (digits: string) =>
  [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)]
    .filter(Boolean)
    .join(" ");

export const isValidNational = (digits: string) => NATIONAL_NUMBER.test(digits);

export const toInternational = (digits: string, dialCode = "+234") =>
  `${dialCode}${digits}`;
