import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import { createKeyring } from "../lib/encryption";
import { issueAccessToken } from "../lib/oauth";
import { registerClient } from "../lib/oauth-clients";
import { createPostgresStores } from "../lib/postgres";
import { migrate } from "../lib/postgres/migrations";
import { createTestDatabase, describePostgres } from "./helpers/postgres";

/*
 * Runs the production HTTP server against a throwaway test database and
 * lists the tools a signed-in user gets, twice: from the source entry point
 * (http.ts) and from the built artifact the container runs (dist/http.js).
 * The artifact is built with the package's own build script into a temporary
 * directory, so dist/ and tracked files are never touched; set
 * CHOWBOT_HTTP_ARTIFACT to smoke-test an existing artifact instead. The child
 * runs from a directory holding only a link to the migrations, as the
 * container runs from /app, with every variable set explicitly, so the
 * project's .env (and its DATABASE_URL) is never loaded, and Chowdeck's base
 * URL points at a closed local port. Listing tools contacts nothing.
 */

const ROOT = join(import.meta.dir, "..");
/*
 * The captured website values: methods set but empty, country NG.
 */
const CHANNEL = {
  CHOWBOT_PAYMENT_CHANNEL_METHODS: "",
  CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "NG",
};

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

let database: TestDatabase;
let workdir: string;
let artifactDir: string | undefined;
let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
const key = randomBytes(32);

/*
 * Builds with exactly the package's build script, redirected to outdir.
 */
const buildArtifact = async (outdir: string) => {
  const { scripts } = await Bun.file(join(ROOT, "package.json")).json();
  const build = scripts.build as string;
  expect(build).toContain("--outdir dist");
  const argv = build.replace("--outdir dist", `--outdir ${outdir}`).split(" ");
  const proc = Bun.spawn(argv, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`build failed:\n${await new Response(proc.stderr).text()}`);
  return join(outdir, "http.js");
};

const ENTRIES: [string, () => Promise<string>][] = [
  ["source (http.ts)", async () => join(ROOT, "http.ts")],
  [
    "built artifact (dist/http.js)",
    async () => {
      if (process.env.CHOWBOT_HTTP_ARTIFACT) return join(ROOT, process.env.CHOWBOT_HTTP_ARTIFACT);
      artifactDir = await mkdtemp(join(tmpdir(), "chowbot-artifact-"));
      return buildArtifact(artifactDir);
    },
  ],
];

const freePort = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port;
};

let childLog = "";

/*
 * Copies the child's stderr into childLog in the background, and resolves
 * once the server reports it is listening.
 */
const waitForStart = async (process: Bun.Subprocess<"ignore", "pipe", "pipe">) => {
  childLog = "";
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of process.stderr) childLog += decoder.decode(chunk);
  })();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (childLog.includes("up and running")) return childLog;
    if (process.exitCode !== null) break;
    await Bun.sleep(50);
  }
  throw new Error(`http.ts did not start:\n${childLog}`);
};

/*
 * Starts http.ts with the given place_order environment and returns the
 * tool names an authenticated user sees, plus the server's log output.
 */
const toolsWith = async (entry: string, placeOrderEnv: Record<string, string>) => {
  const port = freePort();
  const serverUrl = `http://127.0.0.1:${port}/mcp`;
  child = Bun.spawn(["bun", entry], {
    cwd: workdir,
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      PORT: String(port),
      DATABASE_URL: database.config.url,
      CHOWBOT_ENCRYPTION_KEY: key.toString("base64"),
      MCP_SERVER_URL: serverUrl,
      OAUTH_ISSUER_URL: `http://127.0.0.1:${port}`,
      CHOWDECK_API_BASE_URL: "http://127.0.0.1:9",
      ...placeOrderEnv,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const log = await waitForStart(child);

  const sql = database.connect();
  const stores = createPostgresStores(sql, createKeyring(key));
  const client = await registerClient(stores.clients, { redirect_uris: ["https://app.example.com/cb"] });
  const userId = await stores.users.findOrCreateByPhone(`080${Math.floor(Math.random() * 1e8)}`);
  const token = await issueAccessToken(stores.tokens, {
    userId, clientId: client.client_id, scopes: [], resource: serverUrl, expiresAt: Math.floor(Date.now() / 1000) + 600,
  });

  const response = await fetch(serverUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  const body = JSON.parse(data ? data.slice("data: ".length) : text);
  return { names: (body.result.tools as { name: string }[]).map((tool) => tool.name), log, origin: new URL(serverUrl).origin };
};

const mtime = async (path: string) => (await stat(path).catch(() => undefined))?.mtimeMs;

describePostgres.each(ENTRIES)("the production HTTP server: %s", (_, resolveEntry) => {
  let entry: string;
  let distBefore: number | undefined;
  let packageBefore: string;

  beforeAll(async () => {
    distBefore = await mtime(join(ROOT, "dist", "http.js"));
    packageBefore = await Bun.file(join(ROOT, "package.json")).text();
    entry = await resolveEntry();
    database = await createTestDatabase();
    await migrate(database.connect());
    workdir = await mkdtemp(join(tmpdir(), "chowbot-http-"));
    await symlink(join(ROOT, "drizzle"), join(workdir, "drizzle"));
  }, 120_000);

  afterEach(async () => {
    child?.kill();
    await child?.exited;
    child = undefined;
  });

  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
    if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
    artifactDir = undefined;
    await database.drop();
  });

  test("registers place_order and start_payment by default, alongside the recovery tools", async () => {
    const { names, log } = await toolsWith(entry, {});

    expect(names).toEqual(expect.arrayContaining(["place_order", "start_payment", "get_order_submission", "resolve_order_submission", "preview_order"]));
    expect(log).not.toContain("live ordering is off");
  }, 30_000);

  test("registers both with the captured channel values set explicitly", async () => {
    const { names } = await toolsWith(entry, { ...CHANNEL, CHOWBOT_PLACE_ORDER_ENABLED: "true" });

    expect(names).toEqual(expect.arrayContaining(["place_order", "start_payment"]));
  }, 30_000);

  test.each([
    ["the kill switch", { CHOWBOT_PLACE_ORDER_ENABLED: "false" }, ""],
    ["an unrecognised switch value", { CHOWBOT_PLACE_ORDER_ENABLED: "1" }, 'must be "true" or "false" (or unset)'],
    ["a guessed methods value", { ...CHANNEL, CHOWBOT_PAYMENT_CHANNEL_METHODS: "card" }, "differ from the captured website request"],
    ["a lowercase country", { ...CHANNEL, CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "ng" }, "differ from the captured website request"],
    ["only one channel value", { CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "NG" }, "differ from the captured website request"],
  ])("registers neither with %s", async (_, env, warning) => {
    const { names, log } = await toolsWith(entry, env);

    expect(names).not.toContain("place_order");
    expect(names).not.toContain("start_payment");
    expect(names).toContain("get_order_submission");
    if (warning) expect(log).toContain(warning);
  }, 30_000);

  test("answers liveness and readiness probes, then drains and exits 0 on SIGTERM", async () => {
    const { origin } = await toolsWith(entry, {});

    for (const [path, status, label] of [["/healthz", 200, "ok"], ["/readyz", 200, "ready"]] as const) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ status: label });
    }

    child!.kill("SIGTERM");
    expect(await child!.exited).toBe(0);
    await Bun.sleep(50);
    expect(childLog).toContain("Shutting down (SIGTERM)");
    expect(childLog).toContain("Shutdown complete.");
    expect(await fetch(`${origin}/healthz`).then(() => "served", () => "refused")).toBe("refused");
  }, 30_000);

  test("leaves dist/ and package.json untouched", async () => {
    expect(await mtime(join(ROOT, "dist", "http.js"))).toBe(distBefore);
    expect(await Bun.file(join(ROOT, "package.json")).text()).toBe(packageBefore);
  });
});
