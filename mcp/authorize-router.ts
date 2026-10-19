import express, {
  Router,
  type Request,
  type ErrorRequestHandler,
  type Response as ExpressResponse,
} from "express";
import { rateLimit } from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";

import { logger } from "../utils/logger";
import { AUTHORIZE_PATH } from "./oauth-router";
import type { UserStore } from "../lib/users";
import { bindSession, type SessionStore } from "../lib/session";
import { ChowdeckApiError, ChowdeckClient } from "../lib/client";
import { useGolbalRateLimiter } from "../middlewares/rate-limiter";
import logoPath from "../assets/images/chowbot-logo.svg" with { type: "file" };
import fontPath from "../assets/fonts/plus-jakarta-sans-latin.woff2" with { type: "file" };
import {
  otpPage,
  errorPage,
  phonePage,
  AUTHORIZE_FONT_PATH,
  AUTHORIZE_LOGO_PATH,
  type AuthorizationContext,
} from "./authorize-pages";
import { isRegisteredRedirectUri, type ClientStore } from "../lib/oauth-clients";
import { issueAuthorizationCode, type AuthorizationCodeStore } from "../lib/oauth-codes";
import {
  maskPhone,
  toLocalPhone,
  sendLoginOtp,
  verifyLoginOtpToken,
  NIGERIAN_PHONE_PATTERN,
} from "../features/auth/service";

export const AUTHORIZE_PHONE_PATH = `${AUTHORIZE_PATH}/phone`;
export const AUTHORIZE_VERIFY_PATH = `${AUTHORIZE_PATH}/verify`;

const PENDING_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const FORM_BODY_LIMIT = "4kb";
const PKCE_S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE_PATTERN = /^[\x20-\x7E]{1,512}$/;
const OTP_PATTERN = /^\d{4,8}$/;

export type AuthorizeLimits = {
  windowMs: number;
  otpRequestsPerIp: number;
  otpRequestsPerPhone: number;
  otpVerificationsPerIp: number;
};

export const DEFAULT_AUTHORIZE_LIMITS: AuthorizeLimits = {
  windowMs: 15 * 60 * 1000,
  otpRequestsPerIp: 5,
  otpRequestsPerPhone: 3,
  otpVerificationsPerIp: 10,
};

type PendingAuthorization = {
  state: string;
  scopes: string[];
  clientId: string;
  resource: string;
  expiresAt: number;
  csrfToken: string;
  clientName?: string;
  redirectUri: string;
  otpAttempts: number;
  verifying: boolean;
  codeChallenge: string;
  phone?: string;
};

const randomToken = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/*
 * Pending sign-ins live only in this process and expire after ten minutes.
 * The browser holds an opaque ID in an HttpOnly cookie; OAuth parameters,
 * the phone number and OTP attempts never round-trip through the page.
 */
class PendingAuthorizationStore {
  private readonly pending = new Map<string, PendingAuthorization>();

  create(record: PendingAuthorization) {
    this.sweep();
    const id = randomToken();
    this.pending.set(id, record);
    return id;
  }

  get(id: string) {
    const record = this.pending.get(id);
    if (!record) return undefined;
    if (record.expiresAt <= Date.now()) {
      this.pending.delete(id);
      return undefined;
    }
    return record;
  }

  delete(id: string) {
    this.pending.delete(id);
  }

  private sweep() {
    const now = Date.now();
    for (const [id, record] of this.pending) {
      if (record.expiresAt <= now) this.pending.delete(id);
    }
  }
}

class PhoneRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  tryConsume(phone: string) {
    const now = Date.now();
    const recent = (this.hits.get(phone) ?? []).filter((at) => at > now - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(phone, recent);
      return false;
    }
    this.hits.set(phone, [...recent, now]);
    return true;
  }
}

/*
 * Paths are resolved against this module so they work both from source and
 * from the bundled dist/ output, where Bun rewrites them relative to the bundle.
 */
const staticAsset = (path: string, contentType: string) => {
  let bytes: Promise<Buffer> | undefined;
  const file = Bun.file(new URL(path, import.meta.url));
  return {
    contentType,
    load: () => (bytes ??= file.arrayBuffer().then((buffer) => Buffer.from(buffer))),
  };
};

const STATIC_ASSETS = {
  [AUTHORIZE_FONT_PATH]: staticAsset(fontPath, "font/woff2"),
  [AUTHORIZE_LOGO_PATH]: staticAsset(logoPath, "image/svg+xml"),
};

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const readCookie = (req: Request, name: string) => {
  for (const part of req.headers.cookie?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
};

const redirectSource = (redirectUri: string) => {
  const url = new URL(redirectUri);
  return url.protocol === "http:" || url.protocol === "https:" ? url.origin : url.protocol;
};

const redirectHost = (redirectUri: string) => {
  const url = new URL(redirectUri);
  return url.host || url.protocol.replace(/:$/, "");
};

/*
 * form-action must allow the client's redirect target as well as 'self':
 * browsers apply it to the redirect that follows the OTP form submission.
 */
const sendPage = (
  res: ExpressResponse,
  status: number,
  html: string,
  redirectUri?: string,
) => {
  const formAction = ["'self'", ...(redirectUri ? [redirectSource(redirectUri)] : [])].join(" ");
  res
    .status(status)
    .set({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      "x-frame-options": "DENY",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    })
    .send(html);
};

const sameResource = (value: string, resource: URL) =>
  value.replace(/\/$/, "") === resource.href.replace(/\/$/, "");

type ValidationFailure = { ok: false; title: string; message: string };
type ValidationSuccess = {
  ok: true;
  pending: Omit<PendingAuthorization, "csrfToken" | "expiresAt" | "otpAttempts" | "verifying">;
};

const failure = (title: string, message: string): ValidationFailure => ({
  ok: false,
  title,
  message,
});

/*
 * Every failure renders an error page instead of redirecting: the client is
 * only sent back to its registered redirect URI after a successful sign-in.
 * Repeated parameters are rejected as RFC 6749 §3.1 requires.
 */
const validateAuthorizationRequest = async (
  query: Request["query"],
  clients: ClientStore,
  resourceUrl: URL,
): Promise<ValidationFailure | ValidationSuccess> => {
  const param = (name: string) => {
    const value = query[name];
    return typeof value === "string" ? value : value === undefined ? undefined : null;
  };

  const clientId = param("client_id");
  const client = clientId ? await clients.get(clientId) : undefined;
  if (!client) {
    return failure("Unknown application", "Try again from your assistant.");
  }

  const redirectUri = param("redirect_uri");
  if (!redirectUri || !isRegisteredRedirectUri(client, redirectUri)) {
    return failure("Invalid redirect", "This redirect address isn't registered.");
  }

  if (param("response_type") !== "code") {
    return failure("Unsupported request", "Only the code flow is supported.");
  }

  const codeChallenge = param("code_challenge");
  if (param("code_challenge_method") !== "S256" || !codeChallenge || !PKCE_S256_CHALLENGE.test(codeChallenge)) {
    return failure("Unsupported request", "PKCE with S256 is required.");
  }

  const state = param("state");
  if (!state || !STATE_PATTERN.test(state)) {
    return failure("Invalid request", "Missing or invalid state.");
  }

  const resource = param("resource");
  if (resource === null || (resource !== undefined && !sameResource(resource, resourceUrl))) {
    return failure("Invalid request", "Wrong resource for this server.");
  }

  if (param("scope") === null) {
    return failure("Invalid request", "Scope must appear only once.");
  }

  return {
    ok: true,
    pending: {
      state,
      clientId: client.client_id,
      redirectUri,
      codeChallenge,
      resource: resourceUrl.href,
      scopes: [],
      ...(client.client_name !== undefined && { clientName: client.client_name }),
    },
  };
};

const describeFailure = (error: unknown) =>
  error instanceof ChowdeckApiError
    ? `${error.kind}${error.status ? ` ${error.status}` : ""}`
    : error instanceof Error
      ? error.name
      : typeof error;

const isClientError = (error: unknown) =>
  error instanceof ChowdeckApiError &&
  error.kind === "http" &&
  error.status !== undefined &&
  error.status < 500;

export type AuthorizeRouterOptions = {
  resourceUrl: URL;
  secureCookies: boolean;
  users: UserStore;
  clients: ClientStore;
  sessions: SessionStore;
  codes: AuthorizationCodeStore;
  chowdeck?: ChowdeckClient;
  limits?: Partial<AuthorizeLimits>;
};

export const createAuthorizeRouter = ({
  resourceUrl,
  secureCookies,
  users,
  clients,
  sessions,
  codes,
  chowdeck = new ChowdeckClient(),
  limits: limitOverrides,
}: AuthorizeRouterOptions) => {
  const limits = { ...DEFAULT_AUTHORIZE_LIMITS, ...limitOverrides };
  const pendingAuthorizations = new PendingAuthorizationStore();
  const phoneLimiter = new PhoneRateLimiter(limits.otpRequestsPerPhone, limits.windowMs);
  const cookieName = secureCookies ? "__Host-chowbot_authorization" : "chowbot_authorization";

  const ipLimiter = (limit: number) =>
    rateLimit({
      limit,
      windowMs: limits.windowMs,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      handler: (_req, res) =>
        sendPage(res, 429, errorPage("Too many attempts", "Wait a few minutes and try again.")),
    });

  const formParser = express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT });

  const contextOf = (pending: PendingAuthorization): AuthorizationContext => ({
    clientName: pending.clientName,
    redirectHost: redirectHost(pending.redirectUri),
    csrfToken: pending.csrfToken,
  });

  const clearCookie = (res: ExpressResponse) =>
    res.clearCookie(cookieName, { path: "/", httpOnly: true, sameSite: "strict", secure: secureCookies });

  const sendExpired = (res: ExpressResponse) =>
    sendPage(res, 403, errorPage("Sign-in expired", "Start again from your assistant."));

  const loadPending = (req: Request) => {
    const id = readCookie(req, cookieName);
    const pending = id ? pendingAuthorizations.get(id) : undefined;
    const csrfToken = typeof req.body?.csrf_token === "string" ? req.body.csrf_token : "";
    if (!id || !pending || !safeEqual(csrfToken, pending.csrfToken)) return undefined;
    return { id, pending };
  };

  const router = Router();

  for (const [path, asset] of Object.entries(STATIC_ASSETS)) {
    router.get(path, async (_req, res) => {
      res
        .set({
          "content-type": asset.contentType,
          "cache-control": "public, max-age=86400",
          "x-content-type-options": "nosniff",
        })
        .send(await asset.load());
    });
  }

  router.get(AUTHORIZE_PATH, useGolbalRateLimiter, async (req, res) => {
    const result = await validateAuthorizationRequest(req.query, clients, resourceUrl);
    if (!result.ok) return sendPage(res, 400, errorPage(result.title, result.message));

    const pending: PendingAuthorization = {
      ...result.pending,
      csrfToken: randomToken(),
      expiresAt: Date.now() + PENDING_AUTHORIZATION_TTL_MS,
      otpAttempts: 0,
      verifying: false,
    };
    const id = pendingAuthorizations.create(pending);

    res.cookie(cookieName, id, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookies,
      maxAge: PENDING_AUTHORIZATION_TTL_MS,
    });
    sendPage(res, 200, phonePage(contextOf(pending)), pending.redirectUri);
  });

  router.post(
    AUTHORIZE_PHONE_PATH,
    ipLimiter(limits.otpRequestsPerIp),
    formParser,
    async (req, res) => {
      const loaded = loadPending(req);
      if (!loaded) return sendExpired(res);
      const { pending } = loaded;
      const context = contextOf(pending);

      const phone = typeof req.body.phone === "string" ? req.body.phone.replace(/[\s-]/g, "") : "";
      if (!NIGERIAN_PHONE_PATTERN.test(phone)) {
        return sendPage(res, 400, phonePage(context, "Enter a valid Nigerian mobile number, e.g. 08012345678."), pending.redirectUri);
      }

      const localPhone = toLocalPhone(phone);
      if (!phoneLimiter.tryConsume(localPhone)) {
        return sendPage(res, 429, phonePage(context, "Too many codes have been requested for this number. Please wait and try again."), pending.redirectUri);
      }

      try {
        await sendLoginOtp(chowdeck, localPhone);
      } catch (error) {
        logger.warn("Authorization OTP request failed:", describeFailure(error));
        return sendPage(
          res,
          isClientError(error) ? 400 : 502,
          phonePage(context, "Chowdeck could not send a code to that number. Check it and try again."),
          pending.redirectUri,
        );
      }

      pending.phone = localPhone;
      pending.otpAttempts = 0;
      sendPage(res, 200, otpPage(context, maskPhone(localPhone)), pending.redirectUri);
    },
  );

  router.post(
    AUTHORIZE_VERIFY_PATH,
    ipLimiter(limits.otpVerificationsPerIp),
    formParser,
    async (req, res) => {
      const loaded = loadPending(req);
      if (!loaded || !loaded.pending.phone) return sendExpired(res);
      const { id, pending } = loaded;
      const phone = loaded.pending.phone;
      const context = contextOf(pending);
      const maskedPhone = maskPhone(phone);

      if (pending.verifying) {
        return sendPage(res, 409, errorPage("Sign-in in progress", "Your code is being checked."));
      }

      const otp = typeof req.body.otp === "string" ? req.body.otp.trim() : "";
      if (!OTP_PATTERN.test(otp)) {
        return sendPage(res, 400, otpPage(context, maskedPhone, "Enter the numeric code Chowdeck sent you."), pending.redirectUri);
      }

      if (pending.otpAttempts >= MAX_OTP_ATTEMPTS) {
        pendingAuthorizations.delete(id);
        clearCookie(res);
        return sendPage(res, 429, errorPage("Too many attempts", "Start again from your assistant."));
      }

      pending.otpAttempts += 1;
      pending.verifying = true;

      let token: string;
      try {
        ({ token } = await verifyLoginOtpToken(chowdeck, phone, otp));
      } catch (error) {
        pending.verifying = false;
        logger.warn("Authorization OTP verification failed:", describeFailure(error));
        return sendPage(
          res,
          isClientError(error) ? 400 : 502,
          otpPage(context, maskedPhone, "That code did not work. Check it and try again."),
          pending.redirectUri,
        );
      }

      pendingAuthorizations.delete(id);
      clearCookie(res);

      let code: string;
      try {
        const userId = await users.findOrCreateByPhone(phone);
        const session = bindSession(sessions, userId);
        await session.save({ ...(await session.get()), token, phone });

        code = await issueAuthorizationCode(codes, {
          userId,
          clientId: pending.clientId,
          redirectUri: pending.redirectUri,
          codeChallenge: pending.codeChallenge,
          codeChallengeMethod: "S256",
          resource: pending.resource,
          scopes: pending.scopes,
        });
      } catch (error) {
        logger.error("Authorization completion failed:", describeFailure(error));
        return sendPage(res, 500, errorPage("Sign-in failed", "Start again from your assistant."));
      }

      const redirect = new URL(pending.redirectUri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", pending.state);
      res.set("cache-control", "no-store").redirect(303, redirect.href);
    },
  );

  const handleFormError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    logger.warn("Authorization form rejected:", describeFailure(error));
    sendPage(res, 400, errorPage("Invalid request", "Start again from your assistant."));
  };

  router.use(AUTHORIZE_PATH, handleFormError);

  return router;
};
