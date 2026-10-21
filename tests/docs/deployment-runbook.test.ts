import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { RECOVERY_REASON_CODES } from "../../lib/postgres/schema";
import { LIVENESS_PATH, READINESS_PATH } from "../../mcp/http-app";
import { RELEASED_WARNING_DAYS, UNKNOWN_RECOVERY_WAIT_HOURS } from "../../lib/order-submissions";

/*
 * Keeps the runbook's concrete values in step with the code it describes.
 */

const ROOT = join(import.meta.dir, "..", "..");
const read = (path: string) => Bun.file(join(ROOT, path)).text();

describe("docs/deployment-runbook.md", () => {
  test("names the latest migration and the right migration count", async () => {
    const runbook = await read("docs/deployment-runbook.md");
    const { entries } = JSON.parse(await read("drizzle/meta/_journal.json"));
    const last = entries.at(-1);

    expect(runbook).toContain(`${entries.length} rows, the last \`created_at\` = \`${last.when}\``);
    expect(runbook).toContain(last.tag);
  });

  test("uses the server's probe paths and the CLI's commands", async () => {
    const runbook = await read("docs/deployment-runbook.md");
    const cli = await read("cli/recovery.ts");

    expect(runbook).toContain(`GET ${LIVENESS_PATH}`);
    expect(runbook).toContain(`GET ${READINESS_PATH}`);
    for (const command of ["operator add <name>", "operator disable <name>", "show <attempt-id>", "abandon <attempt-id>"]) {
      expect(cli).toContain(command);
    }
  });

  test("only names reason codes the database accepts", async () => {
    const runbook = await read("docs/deployment-runbook.md");
    const named = [...runbook.matchAll(/--reason (\w+)|`(user_[a-z_]+|order_not_retrievable)`/g)].map((m) => m[1] ?? m[2]);

    expect(named.length).toBeGreaterThan(0);
    for (const code of named) expect(RECOVERY_REASON_CODES).toContain(code as never);
  });

  test("states the recovery waiting periods the code enforces", async () => {
    const runbook = await read("docs/deployment-runbook.md");

    expect(UNKNOWN_RECOVERY_WAIT_HOURS).toBe(24);
    expect(RELEASED_WARNING_DAYS).toBe(7);
    expect(runbook).toContain("**24 hours**");
    expect(runbook).toContain("For 7 days");
  });

  test("documents only environment variables the code reads, including every place_order setting", async () => {
    const runbook = await read("docs/deployment-runbook.md");
    const sources = (
      await Promise.all(["http.ts", "features/order-placement/config.ts", "lib/lifecycle.ts", "lib/postgres/database.ts", "constants/oauth/index.ts", "constants/app/index.ts", "cli/recovery.ts"].map(read))
    ).join("\n");
    const documented = new Set([...runbook.matchAll(/\b(CHOWBOT_[A-Z_]+|DATABASE_URL|MCP_SERVER_URL|OAUTH_ISSUER_URL)\b/g)].map((m) => m[1]!));

    for (const name of documented) {
      if (name === "CHOWBOT_HTTP_ARTIFACT") continue;
      expect(sources).toContain(name);
    }
    for (const name of ["CHOWBOT_PLACE_ORDER_ENABLED", "CHOWBOT_PAYMENT_CHANNEL_METHODS", "CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER", "CHOWBOT_SHUTDOWN_GRACE_MS"]) {
      expect(documented.has(name)).toBe(true);
    }
  });
});
