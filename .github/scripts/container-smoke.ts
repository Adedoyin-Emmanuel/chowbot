/*
 * Runs the built image the way production does and checks it, against a
 * throwaway database (created from TEST_DATABASE_URL and dropped afterwards):
 * the container applies every migration itself, answers /healthz and
 * /readyz, has no CHOWBOT_* settings baked in (so place_order is off), and
 * drains and exits 0 on `docker stop -t 40`. Chowdeck's URL points at a
 * closed port; nothing is sent anywhere. Prints no secrets.
 *
 *   TEST_DATABASE_URL=… bun .github/scripts/container-smoke.ts <image>
 */
import { randomBytes } from "node:crypto";

const image = process.argv[2];
const adminUrl = process.env.TEST_DATABASE_URL?.trim();
if (!image || !adminUrl) {
  console.error("usage: TEST_DATABASE_URL=… bun .github/scripts/container-smoke.ts <image>");
  process.exit(2);
}

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const docker = (args: string[]) => Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });

const database = `chowbot_container_${randomBytes(6).toString("hex")}`;
const admin = new Bun.SQL(adminUrl);
await admin.unsafe(`CREATE DATABASE "${database}"`);

const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${database}`;
const appUrl = new URL(dbUrl);
appUrl.hostname = "host.docker.internal";

const port = 28_000 + Math.floor(Math.random() * 1000);
const name = `chowbot-smoke-${port}`;
const envFile = `${process.env.RUNNER_TEMP ?? "/tmp"}/${name}.env`;
await Bun.write(
  envFile,
  [
    `DATABASE_URL=${appUrl.href}`,
    `CHOWBOT_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    "PORT=2800",
    `MCP_SERVER_URL=http://127.0.0.1:${port}/mcp`,
    "CHOWDECK_API_BASE_URL=http://127.0.0.1:9",
  ].join("\n") + "\n",
);

let logs = "";
try {
  const baked = docker(["image", "inspect", image, "--format", "{{json .Config.Env}}"]).stdout.toString();
  check(!baked.includes("CHOWBOT_"), "no CHOWBOT_* settings are baked into the image");

  const run = docker([
    "run", "-d", "--name", name, "--env-file", envFile,
    "--add-host=host.docker.internal:host-gateway", "-p", `127.0.0.1:${port}:2800`, image,
  ]);
  if (run.exitCode !== 0) throw new Error(`docker run failed: ${run.stderr}`);

  let live = false;
  for (let i = 0; i < 60 && !live; i++) {
    await Bun.sleep(500);
    live = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
  }
  check(live, "GET /healthz answers 200");

  const ready = await fetch(`http://127.0.0.1:${port}/readyz`).then(async (r) => ({ status: r.status, body: (await r.json()) as { status?: string } }), () => undefined);
  check(ready?.status === 200 && ready.body?.status === "ready", "GET /readyz answers 200 ready");

  const { entries } = await Bun.file("drizzle/meta/_journal.json").json();
  const db = new Bun.SQL(dbUrl.href);
  const [applied] = await db`SELECT count(*)::int AS n, max(created_at)::text AS last FROM drizzle.__drizzle_migrations`;
  await db.close();
  check(
    applied?.n === entries.length && applied?.last === String(entries.at(-1).when),
    `the container applied all ${entries.length} migrations (last ${entries.at(-1).tag})`,
  );

  const stopped = docker(["stop", "-t", "40", name]);
  const exitCode = docker(["inspect", name, "--format", "{{.State.ExitCode}}"]).stdout.toString().trim();
  check(stopped.exitCode === 0 && exitCode === "0", "docker stop -t 40 drains and exits 0");

  const out = docker(["logs", name]);
  logs = out.stdout.toString() + out.stderr.toString();
  for (const line of ["Connected to PostgreSQL", "up and running", "Shutting down (SIGTERM)", "Shutdown complete."]) {
    check(logs.includes(line), `logs contain "${line}"`);
  }
  check(!logs.includes("place_order"), "no place_order configuration warning (it is not configured)");
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  if (failures.length > 0 && !logs) {
    const out = docker(["logs", name]);
    logs = out.stdout.toString() + out.stderr.toString();
  }
  docker(["rm", "-f", name]);
  Bun.spawnSync(["rm", "-f", envFile]);
  await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}\n\ncontainer logs:\n${logs}`);
  process.exit(1);
}
console.log("\ncontainer smoke test passed");
