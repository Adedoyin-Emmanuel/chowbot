/*
 * The sign-in endpoints on the MCP server (mcp-server/mcp/authorize-router.ts).
 * Every call carries the page's CSRF token in a header; the sign-in itself
 * is identified by an HttpOnly cookie the browser sends on its own.
 */
export type ApiFailure = { message: string; title?: string; restart?: boolean };

export class SignInError extends Error {
  readonly title?: string;
  readonly restart: boolean;

  constructor({ message, title, restart }: ApiFailure) {
    super(message);
    this.title = title;
    this.name = "SignInError";
    this.restart = restart ?? false;
  }
}

const OFFLINE: ApiFailure = {
  message: "Couldn't reach ChowBot. Check your connection and try again.",
};

const UNEXPECTED: ApiFailure = {
  message: "Something went wrong. Try again in a moment.",
};

const isFailure = (value: unknown): value is { error: ApiFailure } =>
  typeof value === "object" &&
  value !== null &&
  "error" in value &&
  typeof (value as { error: { message?: unknown } }).error?.message ===
    "string";

const post = async <T>(
  path: string,
  csrfToken: string,
  body?: object,
): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "x-csrf-token": csrfToken,
        ...(body && { "content-type": "application/json" }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
  } catch {
    throw new SignInError(OFFLINE);
  }

  const data: unknown = await response.json().catch(() => undefined);
  if (response.ok && data) return data as T;
  throw new SignInError(isFailure(data) ? data.error : UNEXPECTED);
};

export const requestCode = (csrfToken: string, phone: string) =>
  post<{ maskedPhone: string }>("/authorize/phone", csrfToken, { phone });

export const resendCode = (csrfToken: string) =>
  post<{ maskedPhone: string }>("/authorize/resend", csrfToken);

export const verifyCode = (csrfToken: string, otp: string) =>
  post<{ redirectUrl: string }>("/authorize/verify", csrfToken, { otp });
