import { isRecord } from "../../utils/object";
import type { UserSession } from "../../lib/session";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";

export const NIGERIAN_PHONE_PATTERN = /^(?:\+?234|0)?([789][01]\d{8})$/;

const LOGIN_PATH = "/auth/login";
const VERIFY_OTP_PATH = "/auth/login/validate-otp";

const LOGIN_DEFAULTS = { country_code: "NG", role: "customer" } as const;

/*
 * Since 2026-10-22 Chowdeck asks callers that identify as the website for a
 * Turnstile token on login, so login is sent without the website headers.
 * The session token it returns works with them on every other request.
 */
const LOGIN_REQUEST = { method: "POST", storefront: false } as const;

/*
 * The reference implementation reports that Chowdeck rejects E.164 numbers
 * on these endpoints and expects the local 0XXXXXXXXXX format.
 */
export const toLocalPhone = (phone: string) => {
  const match = NIGERIAN_PHONE_PATTERN.exec(phone);
  if (!match) throw new Error("Invalid Nigerian phone number");
  return `0${match[1]}`;
};

export const maskPhone = (phone: string) =>
  `${phone.slice(0, 4)}****${phone.slice(-3)}`;

const sessionToken = (body: unknown) => {
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data)) return undefined;
  const token = data.token ?? data.access_token;
  return typeof token === "string" && token ? token : undefined;
};

export const sendLoginOtp = async (client: ChowdeckClient, phone: string) => {
  const localPhone = toLocalPhone(phone);
  await client.request(LOGIN_PATH, {
    ...LOGIN_REQUEST,
    body: { phone: localPhone, ...LOGIN_DEFAULTS },
  });
  return localPhone;
};

export const verifyLoginOtpToken = async (
  client: ChowdeckClient,
  phone: string,
  otp: string,
) => {
  const localPhone = toLocalPhone(phone);
  const body = await client.request(VERIFY_OTP_PATH, {
    ...LOGIN_REQUEST,
    body: { otp, phone: localPhone, ...LOGIN_DEFAULTS },
  });

  const token = sessionToken(body);
  if (!token) {
    throw new ChowdeckApiError(
      "invalid_response",
      `POST ${VERIFY_OTP_PATH} did not return a session token`,
    );
  }
  return { phone: localPhone, token };
};

class AuthService {
  constructor(
    private readonly session: UserSession,
    private readonly client = new ChowdeckClient(),
  ) {}

  async requestLoginOtp(phone: string) {
    return { phone: maskPhone(await sendLoginOtp(this.client, phone)) };
  }

  async verifyLoginOtp(phone: string, otp: string) {
    const { phone: localPhone, token } = await verifyLoginOtpToken(
      this.client,
      phone,
      otp,
    );
    const existing = await this.session.get();
    await this.session.save({ ...existing, token, phone: localPhone });
    return { phone: maskPhone(localPhone) };
  }
}

export default AuthService;
