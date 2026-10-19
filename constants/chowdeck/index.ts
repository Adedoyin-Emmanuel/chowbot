export const CHOWDECK_API_BASE_URL =
  process.env.CHOWDECK_API_BASE_URL || "https://api.chowdeck.com";

export const CHOWDECK_REQUEST_TIMEOUT_MS = Number(
  process.env.CHOWDECK_REQUEST_TIMEOUT_MS || 15000,
);

export const CHOWDECK_STOREFRONT_HEADERS = {
  "x-app-name": "storefront",
  "x-app-os": "web",
} as const;
