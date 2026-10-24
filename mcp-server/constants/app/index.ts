export const GLOBAL_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const GLOBAL_REQUEST_PER_MINUTE = 100;

export const PORT = process.env.PORT || 2800;

/*
 * CHOWBOT_TRUST_PROXY_HOPS: how many reverse proxies sit in front of the
 * server, so rate limits key on the visitor's address from X-Forwarded-For.
 * Unset or 0 trusts none. Setting it higher than the real number lets
 * clients choose their own address and dodge the limits.
 */
export const parseTrustProxyHops = (value: string | undefined) => {
  const raw = value?.trim();
  if (!raw) return 0;
  const hops = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(hops)) {
    throw new Error(`CHOWBOT_TRUST_PROXY_HOPS must be a whole number of proxies, got "${value}"`);
  }
  return hops;
};
