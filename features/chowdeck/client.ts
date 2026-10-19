import {
  CHOWDECK_API_BASE_URL,
  CHOWDECK_REQUEST_TIMEOUT_MS,
  CHOWDECK_STOREFRONT_HEADERS,
} from "../../constants/chowdeck";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type QueryValue = string | number | boolean | undefined;

export type ChowdeckRequestOptions = {
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
};

export type ChowdeckClientConfig = {
  baseUrl: string;
  timeoutMs: number;
};

export type ChowdeckErrorKind = "http" | "timeout" | "network" | "invalid_response";

/*
 * Carries only the status and a short upstream message, never the raw
 * response body, so callers can surface it without leaking upstream data.
 */
export class ChowdeckApiError extends Error {
  constructor(
    readonly kind: ChowdeckErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ChowdeckApiError";
  }
}

const upstreamMessage = (body: unknown) => {
  if (body && typeof body === "object" && "message" in body) {
    const { message } = body;
    if (typeof message === "string" && message.trim()) return message;
  }
  return undefined;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/*
 * Requests are never retried here: some Chowdeck endpoints (e.g. order
 * creation) are not idempotent, so retry decisions belong to the caller.
 */
export class ChowdeckClient {
  private readonly baseUrl: string;

  constructor(
    private readonly config: ChowdeckClientConfig = {
      baseUrl: CHOWDECK_API_BASE_URL,
      timeoutMs: CHOWDECK_REQUEST_TIMEOUT_MS,
    },
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  async request<T = unknown>(
    path: string,
    { method = "GET", query, body, headers }: ChowdeckRequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const label = `${method} ${url.pathname}`;
    let response: Response;
    let text: string;

    try {
      response = await fetch(url, {
        method,
        headers: {
          ...CHOWDECK_STOREFRONT_HEADERS,
          accept: "application/json",
          ...(body !== undefined && { "content-type": "application/json" }),
          ...headers,
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new ChowdeckApiError(
          "timeout",
          `${label} timed out after ${this.config.timeoutMs}ms`,
        );
      }
      throw new ChowdeckApiError("network", `${label} failed: network error`);
    }

    const parsed = text ? parseJson(text) : undefined;

    if (!response.ok) {
      const reason = upstreamMessage(parsed) ?? response.statusText;
      throw new ChowdeckApiError(
        "http",
        `${label} failed with status ${response.status}${reason ? `: ${reason}` : ""}`,
        response.status,
      );
    }

    if (text && parsed === undefined) {
      throw new ChowdeckApiError(
        "invalid_response",
        `${label} returned a non-JSON response`,
        response.status,
      );
    }

    return parsed as T;
  }
}
