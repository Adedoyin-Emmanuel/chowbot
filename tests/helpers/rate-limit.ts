import { useGolbalRateLimiter } from "../../middlewares/rate-limiter";

/*
 * The global rate limiter is a module singleton shared by every HTTP test
 * file in one bun process, so the suite's combined requests count against
 * one 100-per-minute budget. Files that make HTTP requests reset the
 * loopback keys so their tests are not throttled by earlier files.
 */
export const resetGlobalRateLimit = async () => {
  for (const key of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) {
    await useGolbalRateLimiter.resetKey(key);
  }
};
