import { z } from "zod";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/server";

export type RegisteredClient = {
  client_id: string;
  client_name?: string;
  grant_types: string[];
  redirect_uris: string[];
  response_types: string[];
  client_id_issued_at: number;
  token_endpoint_auth_method: string;
};

export interface ClientStore {
  save(client: RegisteredClient): Promise<void>;
  get(clientId: string): Promise<RegisteredClient | undefined>;
}

const copyClient = (client: RegisteredClient): RegisteredClient => ({
  ...client,
  grant_types: [...client.grant_types],
  redirect_uris: [...client.redirect_uris],
  response_types: [...client.response_types],
});

export class InMemoryClientStore implements ClientStore {
  private readonly clients = new Map<string, RegisteredClient>();

  async get(clientId: string) {
    const client = this.clients.get(clientId);
    return client && copyClient(client);
  }

  async save(client: RegisteredClient) {
    this.clients.set(client.client_id, copyClient(client));
  }
}

export type RegistrationErrorCode =
  "invalid_redirect_uri" | "invalid_client_metadata";

export class ClientRegistrationError extends Error {
  constructor(
    readonly code: RegistrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClientRegistrationError";
  }
}

const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BLOCKED_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "blob:",
  "about:",
]);

/*
 * Accepts https, http only on loopback (RFC 8252 §7.3), and reverse-domain
 * private-use schemes for native apps (RFC 8252 §7.1). URIs are stored as
 * sent and later compared by exact string equality, so wildcards, fragments
 * and surrounding whitespace are rejected rather than normalised.
 */
export const redirectUriProblem = (value: string) => {
  if (value.length > MAX_REDIRECT_URI_LENGTH) return "is too long";
  if (/\s/.test(value)) return "must not contain whitespace";
  if (value.includes("*")) return "must not contain wildcards";
  if (value.includes("#")) return "must not contain a fragment";

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute URI";
  }

  if (url.username || url.password) return "must not contain credentials";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:") {
    return LOOPBACK_HOSTS.has(url.hostname)
      ? undefined
      : "must use https unless it targets a loopback address";
  }
  if (BLOCKED_SCHEMES.has(url.protocol)) return "uses a disallowed scheme";
  return url.protocol.includes(".")
    ? undefined
    : "must use https, loopback http, or a reverse-domain private-use scheme";
};

const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(200).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

const validateRedirectUris = (value: unknown) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ClientRegistrationError(
      "invalid_redirect_uri",
      "redirect_uris must be a non-empty array",
    );
  }
  if (value.length > MAX_REDIRECT_URIS) {
    throw new ClientRegistrationError(
      "invalid_redirect_uri",
      `redirect_uris must contain at most ${MAX_REDIRECT_URIS} entries`,
    );
  }

  value.forEach((uri, index) => {
    const problem =
      typeof uri === "string" ? redirectUriProblem(uri) : "must be a string";
    if (problem) {
      throw new ClientRegistrationError(
        "invalid_redirect_uri",
        `redirect_uris[${index}] ${problem}`,
      );
    }
  });

  return [...new Set(value as string[])];
};

/*
 * Only public clients using the authorization-code flow are registered.
 * RFC 7591 §3.2.1 lets the server replace requested values, so unsupported
 * extras such as refresh_token are dropped and the registered values are
 * returned; requests that cannot work with this server are rejected.
 */
export const registerClient = async (store: ClientStore, body: unknown) => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ClientRegistrationError(
      "invalid_client_metadata",
      "Registration request must be a JSON object",
    );
  }

  const redirectUris = validateRedirectUris(
    (body as { redirect_uris?: unknown }).redirect_uris,
  );
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ClientRegistrationError(
      "invalid_client_metadata",
      `${issue?.path.join(".") || "metadata"}: ${issue?.message ?? "invalid value"}`,
    );
  }

  const {
    client_name,
    grant_types,
    response_types,
    token_endpoint_auth_method,
  } = parsed.data;

  if (
    token_endpoint_auth_method !== undefined &&
    token_endpoint_auth_method !== "none"
  ) {
    throw new ClientRegistrationError(
      "invalid_client_metadata",
      'Only public clients are supported (token_endpoint_auth_method "none")',
    );
  }
  if (
    grant_types !== undefined &&
    !grant_types.includes("authorization_code")
  ) {
    throw new ClientRegistrationError(
      "invalid_client_metadata",
      'grant_types must include "authorization_code"',
    );
  }
  if (response_types !== undefined && !response_types.includes("code")) {
    throw new ClientRegistrationError(
      "invalid_client_metadata",
      'response_types must include "code"',
    );
  }

  const client: RegisteredClient = {
    client_id: crypto.randomUUID(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(client_name !== undefined && { client_name }),
    redirect_uris: redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  } satisfies OAuthClientInformationFull;

  await store.save(client);
  return client;
};

export const isRegisteredRedirectUri = (
  client: RegisteredClient,
  redirectUri: string,
) => client.redirect_uris.includes(redirectUri);
