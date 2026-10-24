import express, {
  Router,
  type Request,
  type ErrorRequestHandler,
  type Response as ExpressResponse,
} from "express";
import { rateLimit } from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";

import { logger } from "../utils/logger";
import type { UserStore } from "../lib/users";
import { AUTHORIZE_PATH } from "./oauth-router";
import {
  UNBUILT_SHELL,
  renderAuthorizePage,
  AUTHORIZE_ASSETS_PATH,
  type AuthorizeUi,
  type AuthorizeState,
} from "./authorize-ui";
import {
  isRegisteredRedirectUri,
  type ClientStore,
} from "../lib/oauth-clients";
import {
  issueAuthorizationCode,
  type AuthorizationCodeStore,
} from "../lib/oauth-codes";
import {
  maskPhone,
  toLocalPhone,
  sendLoginOtp,
  verifyLoginOtpToken,
  NIGERIAN_PHONE_PATTERN,
} from "../features/auth/service";
import { bindSession, type SessionStore } from "../lib/session";
import { ChowdeckApiError, ChowdeckClient } from "../lib/client";
import { useGolbalRateLimiter } from "../middlewares/rate-limiter";

export const AUTHORIZE_PHONE_PATH = `${AUTHORIZE_PATH}/phone`;
export const AUTHORIZE_RESEND_PATH = `${AUTHORIZE_PATH}/resend`;
export const AUTHORIZE_VERIFY_PATH = `${AUTHORIZE_PATH}/verify`;
export const CSRF_HEADER = "x-csrf-token";

const MAX_OTP_ATTEMPTS = 5;
const JSON_BODY_LIMIT = "4kb";
const OTP_PATTERN = /^\d{4,8}$/;
const STATE_PATTERN = /^[\x20-\x7E]{1,512}$/;
const PKCE_S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PENDING_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

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
    const recent = (this.hits.get(phone) ?? []).filter(
      (at) => at > now - this.windowMs,
    );
    if (recent.length >= this.limit) {
      this.hits.set(phone, recent);
      return false;
    }
    this.hits.set(phone, [...recent, now]);
    return true;
  }
}

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

/*
 * The app is served from this origin and talks only to it. Forms are not
 * used (the app posts JSON), so form-action is closed entirely; the final
 * redirect to the client is a plain navigation, which CSP does not govern.
 * The bundler inlines the brand font into the stylesheet, hence data: fonts.
 */
const PAGE_SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const API_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/*
 * Failures on the JSON endpoints carry a message for the user. restart marks
 * the ones that end the sign-in, so the app shows a final screen instead of
 * letting them retry.
 */
type ApiFailure = { message: string; title?: string; restart?: boolean };

const sendJson = (res: ExpressResponse, status: number, body: object) =>
  res.status(status).set(API_HEADERS).json(body);

const sendFailure = (
  res: ExpressResponse,
  status: number,
  failure: ApiFailure,
) => sendJson(res, status, { error: failure });

const sameResource = (value: string, resource: URL) =>
  value.replace(/\/$/, "") === resource.href.replace(/\/$/, "");

type ValidationFailure = { ok: false; title: string; message: string };
type ValidationSuccess = {
  ok: true;
  pending: Omit<
    PendingAuthorization,
    "csrfToken" | "expiresAt" | "otpAttempts" | "verifying"
  >;
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
    return typeof value === "string"
      ? value
      : value === undefined
        ? undefined
        : null;
  };

  const clientId = param("client_id");
  const client = clientId ? await clients.get(clientId) : undefined;
  if (!client) {
    return failure("Unknown application", "Try again from your assistant.");
  }

  const redirectUri = param("redirect_uri");
  if (!redirectUri || !isRegisteredRedirectUri(client, redirectUri)) {
    return failure(
      "Invalid redirect",
      "This redirect address isn't registered.",
    );
  }

  if (param("response_type") !== "code") {
    return failure("Unsupported request", "Only the code flow is supported.");
  }

  const codeChallenge = param("code_challenge");
  if (
    param("code_challenge_method") !== "S256" ||
    !codeChallenge ||
    !PKCE_S256_CHALLENGE.test(codeChallenge)
  ) {
    return failure("Unsupported request", "PKCE with S256 is required.");
  }

  const state = param("state");
  if (!state || !STATE_PATTERN.test(state)) {
    return failure("Invalid request", "Missing or invalid state.");
  }

  const resource = param("resource");
  if (
    resource === null ||
    (resource !== undefined && !sameResource(resource, resourceUrl))
  ) {
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
      ...(client.client_name !== undefined && {
        clientName: client.client_name,
      }),
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

const EXPIRED: ApiFailure = {
  title: "Sign-in expired",
  message: "Start again from your assistant.",
  restart: true,
};

export type AuthorizeRouterOptions = {
  resourceUrl: URL;
  secureCookies: boolean;
  ui: AuthorizeUi;
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
  ui,
  users,
  clients,
  sessions,
  codes,
  chowdeck = new ChowdeckClient(),
  limits: limitOverrides,
}: AuthorizeRouterOptions) => {
  const limits = { ...DEFAULT_AUTHORIZE_LIMITS, ...limitOverrides };
  const pendingAuthorizations = new PendingAuthorizationStore();
  const phoneLimiter = new PhoneRateLimiter(
    limits.otpRequestsPerPhone,
    limits.windowMs,
  );
  const cookieName = secureCookies
    ? "__Host-chowbot_authorization"
    : "chowbot_authorization";

  const ipLimiter = (limit: number) =>
    rateLimit({
      limit,
      windowMs: limits.windowMs,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      handler: (_req, res) =>
        sendFailure(res, 429, {
          title: "Too many attempts",
          message: "Wait a few minutes and try again.",
        }),
    });

  const jsonParser = express.json({ limit: JSON_BODY_LIMIT });

  const sendPage = async (
    res: ExpressResponse,
    status: number,
    state: AuthorizeState,
  ) => {
    const shell = await ui.shell();
    res
      .status(shell === undefined ? 503 : status)
      .set({
        ...PAGE_SECURITY_HEADERS,
        "content-type": "text/html; charset=utf-8",
      })
      .send(renderAuthorizePage(shell ?? UNBUILT_SHELL, state));
  };

  const sendErrorPage = (
    res: ExpressResponse,
    status: number,
    title: string,
    message: string,
  ) => sendPage(res, status, { view: "error", title, message });

  const stepState = (pending: PendingAuthorization): AuthorizeState => {
    const context = {
      csrfToken: pending.csrfToken,
      ...(pending.clientName !== undefined && {
        clientName: pending.clientName,
      }),
    };
    return pending.phone
      ? { view: "otp", ...context, maskedPhone: maskPhone(pending.phone) }
      : { view: "phone", ...context };
  };

  const clearCookie = (res: ExpressResponse) =>
    res.clearCookie(cookieName, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookies,
    });

  const pendingFromCookie = (req: Request) => {
    const id = readCookie(req, cookieName);
    const pending = id ? pendingAuthorizations.get(id) : undefined;
    return id && pending ? { id, pending } : undefined;
  };

  /*
   * State-changing calls need both the cookie and the CSRF token from the
   * page in a custom header, which a cross-site form or fetch cannot send.
   */
  const loadPending = (req: Request) => {
    const loaded = pendingFromCookie(req);
    const csrfToken = req.get(CSRF_HEADER) ?? "";
    if (!loaded || !safeEqual(csrfToken, loaded.pending.csrfToken))
      return undefined;
    return loaded;
  };

  /*
   * Shared by the phone step and "resend code": both count against the
   * per-phone limit, and a new code resets the attempt counter.
   */
  const sendCode = async (
    res: ExpressResponse,
    pending: PendingAuthorization,
    localPhone: string,
  ) => {
    if (!phoneLimiter.tryConsume(localPhone)) {
      return sendFailure(res, 429, {
        message:
          "Too many codes have been requested for this number. Please wait and try again.",
      });
    }

    try {
      await sendLoginOtp(chowdeck, localPhone);
    } catch (error) {
      logger.warn("Authorization OTP request failed:", describeFailure(error));
      return sendFailure(res, isClientError(error) ? 400 : 502, {
        message:
          "Chowdeck could not send a code to that number. Check it and try again.",
      });
    }

    pending.phone = localPhone;
    pending.otpAttempts = 0;
    sendJson(res, 200, { maskedPhone: maskPhone(localPhone) });
  };

  const router = Router();

  if (ui.assetsDir) {
    router.use(
      AUTHORIZE_ASSETS_PATH,
      express.static(ui.assetsDir, {
        index: false,
        immutable: true,
        maxAge: "365d",
        setHeaders: (res) => res.set("x-content-type-options", "nosniff"),
      }),
      (_req, res) => res.sendStatus(404),
    );
  }

  router.get(AUTHORIZE_PATH, useGolbalRateLimiter, async (req, res) => {
    const result = await validateAuthorizationRequest(
      req.query,
      clients,
      resourceUrl,
    );
    if (!result.ok)
      return sendErrorPage(res, 400, result.title, result.message);

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
    await sendPage(res, 200, stepState(pending));
  });

  // A refresh on the code step lands here and resumes the same sign-in.
  router.get(AUTHORIZE_VERIFY_PATH, useGolbalRateLimiter, async (req, res) => {
    const loaded = pendingFromCookie(req);
    if (!loaded) return sendErrorPage(res, 403, EXPIRED.title!, EXPIRED.message);
    await sendPage(res, 200, stepState(loaded.pending));
  });

  router.post(
    AUTHORIZE_PHONE_PATH,
    ipLimiter(limits.otpRequestsPerIp),
    jsonParser,
    async (req, res) => {
      const loaded = loadPending(req);
      if (!loaded) return sendFailure(res, 403, EXPIRED);

      const phone =
        typeof req.body?.phone === "string"
          ? req.body.phone.replace(/[\s-]/g, "")
          : "";
      if (!NIGERIAN_PHONE_PATTERN.test(phone)) {
        return sendFailure(res, 400, {
          message: "Enter a valid Nigerian mobile number, e.g. 08012345678.",
        });
      }

      await sendCode(res, loaded.pending, toLocalPhone(phone));
    },
  );

  router.post(
    AUTHORIZE_RESEND_PATH,
    ipLimiter(limits.otpRequestsPerIp),
    async (req, res) => {
      const loaded = loadPending(req);
      if (!loaded?.pending.phone) return sendFailure(res, 403, EXPIRED);
      await sendCode(res, loaded.pending, loaded.pending.phone);
    },
  );

  router.post(
    AUTHORIZE_VERIFY_PATH,
    ipLimiter(limits.otpVerificationsPerIp),
    jsonParser,
    async (req, res) => {
      const loaded = loadPending(req);
      if (!loaded || !loaded.pending.phone)
        return sendFailure(res, 403, EXPIRED);
      const { id, pending } = loaded;
      const phone = loaded.pending.phone;

      if (pending.verifying) {
        return sendFailure(res, 409, {
          message: "Your code is already being checked.",
        });
      }

      const otp =
        typeof req.body?.otp === "string" ? req.body.otp.trim() : "";
      if (!OTP_PATTERN.test(otp)) {
        return sendFailure(res, 400, {
          message: "Enter the numeric code Chowdeck sent you.",
        });
      }

      if (pending.otpAttempts >= MAX_OTP_ATTEMPTS) {
        pendingAuthorizations.delete(id);
        clearCookie(res);
        return sendFailure(res, 429, {
          title: "Too many attempts",
          message: "Start again from your assistant.",
          restart: true,
        });
      }

      pending.otpAttempts += 1;
      pending.verifying = true;

      let token: string;
      try {
        ({ token } = await verifyLoginOtpToken(chowdeck, phone, otp));
      } catch (error) {
        pending.verifying = false;
        logger.warn(
          "Authorization OTP verification failed:",
          describeFailure(error),
        );
        return sendFailure(res, isClientError(error) ? 400 : 502, {
          message: "That code did not work. Check it and try again.",
        });
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
        logger.error(
          "Authorization completion failed:",
          describeFailure(error),
        );
        return sendFailure(res, 500, {
          title: "Sign-in failed",
          message: "Start again from your assistant.",
          restart: true,
        });
      }

      const redirect = new URL(pending.redirectUri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", pending.state);
      sendJson(res, 200, { redirectUrl: redirect.href });
    },
  );

  const handleBodyError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    logger.warn("Authorization request rejected:", describeFailure(error));
    sendFailure(res, 400, {
      title: "Invalid request",
      message: "Start again from your assistant.",
      restart: true,
    });
  };

  router.use(AUTHORIZE_PATH, handleBodyError);

  return router;
};
