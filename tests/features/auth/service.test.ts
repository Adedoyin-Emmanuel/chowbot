import type { Server } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { ChowdeckClient } from "../../../lib/client";
import { sendLoginOtp, verifyLoginOtpToken } from "../../../features/auth/service";

/*
 * Chowdeck answers 403 "Security check failed" to a login that carries the
 * website's app headers without a Turnstile token (observed 2026-10-23), and
 * succeeds without them. The mock enforces the same rule.
 */
type Received = { path: string; appName: string | null; appOs: string | null };

let upstream: Server<undefined>;
let received: Received[];

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const appName = req.headers.get("x-app-name");
      received.push({ path, appName, appOs: req.headers.get("x-app-os") });
      if (path === "/auth/login" && appName === "storefront" && !req.headers.get("cf-turnstile-response")) {
        return Response.json({ status: "failed", message: "Security check failed. Please refresh the page and try again." }, { status: 403 });
      }
      return path === "/auth/login/validate-otp"
        ? Response.json({ status: "success", data: { token: "secret-token" } })
        : Response.json({ status: "success", message: "Login OTP has been sent to user" });
    },
  });
});

afterAll(() => upstream.stop(true));

beforeEach(() => {
  received = [];
});

const client = () => new ChowdeckClient({ baseUrl: upstream.url.origin, timeoutMs: 1000 });

describe("Chowdeck login", () => {
  test("requests and verifies the code without the website's app headers", async () => {
    expect(await sendLoginOtp(client(), "08012345678")).toBe("08012345678");
    expect(await verifyLoginOtpToken(client(), "08012345678", "1234")).toEqual({ phone: "08012345678", token: "secret-token" });

    expect(received).toEqual([
      { path: "/auth/login", appName: null, appOs: null },
      { path: "/auth/login/validate-otp", appName: null, appOs: null },
    ]);
  });

  test("other requests still identify as the website", async () => {
    await client().request("/customer/address");

    expect(received[0]).toMatchObject({ appName: "storefront", appOs: "web" });
  });
});
