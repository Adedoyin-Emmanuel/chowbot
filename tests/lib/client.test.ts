import {
  test,
  expect,
  describe,
  afterAll,
  beforeAll,
  beforeEach,
} from "bun:test";
import type { Server } from "bun";

import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";

type ReceivedRequest = {
  url: URL;
  body: string;
  method: string;
  headers: Headers;
};

let server: Server<undefined>;
let received: ReceivedRequest | undefined;

const json = (body: unknown, status = 200) => Response.json(body, { status });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      received = {
        method: req.method,
        url,
        headers: req.headers,
        body: await req.text(),
      };

      switch (url.pathname) {
        case "/ok":
          return json({ status: "success", data: { id: 1 } });
        case "/empty":
          return new Response(null, { status: 204 });
        case "/not-found":
          return json({ status: "fail", message: "Vendor not found" }, 404);
        case "/server-error":
          return new Response("<html>oops</html>", {
            status: 502,
            statusText: "Bad Gateway",
          });
        case "/html":
          return new Response("<html>ok</html>");
        case "/slow":
          await Bun.sleep(200);
          return json({ late: true });
        default:
          return json({ message: "unexpected path" }, 500);
      }
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  received = undefined;
});

const createClient = (timeoutMs = 1000) =>
  new ChowdeckClient({ baseUrl: `${server.url.origin}/`, timeoutMs });

const captureError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChowdeckApiError) return error;
    throw error;
  }
  throw new Error("Expected request to fail");
};

describe("ChowdeckClient", () => {
  test("sends storefront headers and query params, and returns parsed JSON", async () => {
    const result = await createClient().request("/ok", {
      query: { currency: "NGN", page: 2, skipped: undefined },
      headers: { "x-chowdeck-api-version": "v2" },
    });

    expect(result).toEqual({ status: "success", data: { id: 1 } });
    expect(received?.method).toBe("GET");
    expect(received?.url.searchParams.get("currency")).toBe("NGN");
    expect(received?.url.searchParams.get("page")).toBe("2");
    expect(received?.url.searchParams.has("skipped")).toBe(false);
    expect(received?.headers.get("x-app-name")).toBe("storefront");
    expect(received?.headers.get("x-app-os")).toBe("web");
    expect(received?.headers.get("accept")).toBe("application/json");
    expect(received?.headers.get("x-chowdeck-api-version")).toBe("v2");
    expect(received?.headers.has("content-type")).toBe(false);
  });

  test("serialises a JSON body", async () => {
    await createClient().request("/ok", {
      method: "POST",
      body: { phone: "08012345678" },
    });

    expect(received?.method).toBe("POST");
    expect(received?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(received?.body ?? "")).toEqual({ phone: "08012345678" });
  });

  test("returns undefined for an empty response body", async () => {
    expect(await createClient().request("/empty")).toBeUndefined();
  });

  test("raises an http error with the upstream message", async () => {
    const error = await captureError(createClient().request("/not-found"));

    expect(error.kind).toBe("http");
    expect(error.status).toBe(404);
    expect(error.message).toBe(
      "GET /not-found failed with status 404: Vendor not found",
    );
  });

  test("falls back to the status text when the error body is not JSON", async () => {
    const error = await captureError(createClient().request("/server-error"));

    expect(error.kind).toBe("http");
    expect(error.status).toBe(502);
    expect(error.message).toBe(
      "GET /server-error failed with status 502: Bad Gateway",
    );
    expect(error.message).not.toContain("<html>");
  });

  test("raises invalid_response for a non-JSON success body", async () => {
    const error = await captureError(createClient().request("/html"));

    expect(error.kind).toBe("invalid_response");
    expect(error.status).toBe(200);
  });

  test("raises a timeout error when the upstream is too slow", async () => {
    const error = await captureError(createClient(50).request("/slow"));

    expect(error.kind).toBe("timeout");
    expect(error.status).toBeUndefined();
    expect(error.message).toBe("GET /slow timed out after 50ms");
  });

  test("raises a network error when the upstream is unreachable", async () => {
    const unreachable = Bun.serve({ port: 0, fetch: () => new Response() });
    const baseUrl = unreachable.url.origin;
    await unreachable.stop(true);

    const error = await captureError(
      new ChowdeckClient({ baseUrl, timeoutMs: 1000 }).request("/ok"),
    );

    expect(error.kind).toBe("network");
    expect(error.message).toBe("GET /ok failed: network error");
  });
});
