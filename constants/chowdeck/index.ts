export const CHOWDECK_API_BASE_URL =
  process.env.CHOWDECK_API_BASE_URL || "https://api.chowdeck.com";

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

export const parseRequestTimeoutMs = (value: string | undefined) => {
  const raw = value?.trim();
  if (!raw) return DEFAULT_REQUEST_TIMEOUT_MS;

  const timeoutMs = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `CHOWDECK_REQUEST_TIMEOUT_MS must be a positive whole number of milliseconds, got "${value}"`,
    );
  }
  return timeoutMs;
};

export const CHOWDECK_REQUEST_TIMEOUT_MS = parseRequestTimeoutMs(
  process.env.CHOWDECK_REQUEST_TIMEOUT_MS,
);

export const CHOWDECK_STOREFRONT_HEADERS = {
  "x-app-name": "storefront",
  "x-app-os": "web",
} as const;
