export type ScalarValue = string | number | boolean | null;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScalarValue = (value: unknown): value is ScalarValue =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

export const pickScalarFields = (
  source: Record<string, unknown>,
  fields: readonly string[],
) => {
  const picked: Record<string, ScalarValue> = {};
  for (const field of fields) {
    const value = source[field];
    if (isScalarValue(value)) picked[field] = value;
  }
  return picked;
};
