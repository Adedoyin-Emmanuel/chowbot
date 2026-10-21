import { parseArgs } from "node:util";

import {
  PostgresOperatorStore,
  PostgresRecoveryStore,
} from "../lib/postgres/recovery";
import RecoveryService, {
  reasonsFor,
  disclosureFor,
} from "../features/recovery/service";
import {
  createDrizzle,
  connectDatabase,
  readDatabaseConfig,
} from "../lib/postgres/database";
import {
  OPERATOR_NAME_PATTERN,
  authenticateOperator,
  hashOperatorCredential,
  generateOperatorCredential,
  type Operator,
  type RecoverableAttempt,
} from "../lib/recovery";
import { ChowdeckClient } from "../lib/client";
import { PostgresSessionStore } from "../lib/postgres/sessions";
import { createKeyring, parseEncryptionKey } from "../lib/encryption";
import { PostgresOrderSubmissionStore } from "../lib/postgres/order-submissions";

/*
 * Operator recovery CLI. Marking a stuck attempt abandoned means ChowBot
 * stops tracking it and releases its cart lock; it never cancels anything on
 * Chowdeck. There is no HTTP admin endpoint: it needs database access, the server's encryption key (to read the
 * user's Chowdeck session for the read-only lookup), and an operator
 * credential verified against its argon2id hash. The credential is read from
 * CHOWBOT_OPERATOR and CHOWBOT_OPERATOR_TOKEN, never from the command line,
 * so it stays out of shell history and process listings.
 *
 *   bun cli/recovery.ts operator add <name>      (the first operator needs no credential)
 *   bun cli/recovery.ts operator disable <name>
 *   bun cli/recovery.ts show <attempt-id>
 *   bun cli/recovery.ts abandon <attempt-id> --reason <code> --note <text> --acknowledge-duplicate-risk
 */

type Env = Record<string, string | undefined>;
type Io = { out: (line: string) => void; err: (line: string) => void };
export type CliDeps = { sql?: Bun.SQL; client?: ChowdeckClient };

const USAGE = [
  "Usage:",
  "  operator add <name>",
  "  operator disable <name>",
  "  show <attempt-id>",
  "  abandon <attempt-id> --reason <code> --note <text> --acknowledge-duplicate-risk",
  "Operator credentials are read from CHOWBOT_OPERATOR and CHOWBOT_OPERATOR_TOKEN.",
].join("\n");

const AUTH_FAILED = "Operator authentication failed.";

const describeAttempt = (attempt: RecoverableAttempt) => [
  `attempt:            ${attempt.id}`,
  `state:              ${attempt.state}`,
  `restaurant:         ${attempt.vendorId}`,
  `cart:               ${attempt.cartId}`,
  `chowdeck order:     ${attempt.chowdeckOrderId ?? "none recorded"}`,
  `order request sent: ${attempt.orderRequestStartedAt?.toISOString() ?? "no"}`,
  `payment start:      ${attempt.paymentStartedAt ? `${attempt.paymentStartState ?? "outcome not recorded"} at ${attempt.paymentStartedAt.toISOString()}` : "none"}`,
  `lock:               ${attempt.lockReleasedAt ? attempt.lockReleaseReason === "operator_released" ? `abandoned at ${attempt.lockReleasedAt.toISOString()}` : `released (${attempt.lockReleaseReason}) at ${attempt.lockReleasedAt.toISOString()}` : "held"}`,
];

export const runRecoveryCli = async (
  argv: string[],
  env: Env,
  io: Io,
  deps: CliDeps = {},
) => {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        reason: { type: "string" },
        note: { type: "string" },
        "acknowledge-duplicate-risk": { type: "boolean" },
      },
    });
  } catch (error) {
    io.err(
      `${error instanceof Error ? error.message : "Invalid arguments"}\n${USAGE}`,
    );
    return 2;
  }
  const [command, ...rest] = parsed.positionals;
  const known =
    (command === "operator" &&
      (rest[0] === "add" || rest[0] === "disable") &&
      rest.length === 2) ||
    ((command === "show" || command === "abandon") && rest.length === 1);
  if (!known) {
    io.err(USAGE);
    return 2;
  }

  const ownsSql = !deps.sql;
  let sql: Bun.SQL;
  try {
    sql = deps.sql ?? (await connectDatabase(readDatabaseConfig(env)));
  } catch (error) {
    io.err(
      error instanceof Error
        ? error.message
        : "Could not connect to PostgreSQL",
    );
    return 1;
  }

  try {
    const db = createDrizzle(sql);
    const operators = new PostgresOperatorStore(db);
    const authenticate = () =>
      authenticateOperator(
        operators,
        env.CHOWBOT_OPERATOR,
        env.CHOWBOT_OPERATOR_TOKEN,
      );

    if (command === "operator") {
      const [action, name] = rest as [string, string];
      if (!OPERATOR_NAME_PATTERN.test(name)) {
        io.err(
          "Operator names are 2-63 characters: lowercase letters, digits, '.', '_' or '-'.",
        );
        return 2;
      }
      const actor = await authenticate();
      if (!actor && action === "disable") {
        io.err(AUTH_FAILED);
        return 1;
      }
      if (action === "disable") {
        if (!(await operators.disable(name))) {
          io.err(`No active operator named ${name}.`);
          return 1;
        }
        io.out(`Operator ${name} disabled by ${actor!.name}.`);
        return 0;
      }
      const credential = generateOperatorCredential();
      const hash = await hashOperatorCredential(credential);
      if (!actor) {
        // Only the very first operator may be added without a credential;
        // the database decides atomically whether this is that one.
        if (!(await operators.bootstrap(name, hash))) {
          io.err(AUTH_FAILED);
          return 1;
        }
      } else {
        if (await operators.find(name)) {
          io.err(`Operator ${name} already exists.`);
          return 1;
        }
        await operators.add(name, hash);
      }
      io.out(
        `Operator ${name} added${actor ? ` by ${actor.name}` : " (first operator)"}.`,
      );
      io.out("Credential (shown once; only its hash is stored):");
      io.out(credential);
      return 0;
    }

    const operator: Operator | undefined = await authenticate();
    if (!operator) {
      io.err(AUTH_FAILED);
      return 1;
    }

    const keyring = createKeyring(
      parseEncryptionKey(env.CHOWBOT_ENCRYPTION_KEY),
    );
    const service = new RecoveryService(
      new PostgresRecoveryStore(db),
      new PostgresOrderSubmissionStore(db, keyring),
      new PostgresSessionStore(db, keyring),
      deps.client ?? new ChowdeckClient(),
    );
    const attemptId = rest[0]!;

    if (command === "show") {
      const attempt = await service.getAttempt(attemptId);
      if (!attempt) {
        io.err("No order attempt has that id.");
        return 1;
      }
      for (const line of describeAttempt(attempt)) io.out(line);
      const reasons = reasonsFor(attempt);
      io.out(
        `abandon reasons:    ${reasons.length > 0 ? reasons.join(", ") : "none (cannot be marked abandoned)"}`,
      );
      io.out(
        `24-hour wait:       ${attempt.state === "created" ? "not required" : attempt.waitElapsed ? "elapsed" : "not elapsed"}`,
      );
      io.out("");
      io.out(`Risk to acknowledge: ${disclosureFor(attempt)}`);
      return 0;
    }

    const options = parsed.values as {
      reason?: string;
      note?: string;
      "acknowledge-duplicate-risk"?: boolean;
    };
    const outcome = await service.release({
      operator,
      attemptId,
      reasonCode: options.reason ?? "",
      note: options.note ?? "",
      acknowledgeDuplicateRisk: options["acknowledge-duplicate-risk"] === true,
    });
    const lookup = outcome.lookup;
    const lookupLine =
      lookup?.outcome === "unpaid"
        ? `Chowdeck lookup: unpaid (order status: ${lookup.orderStatus ?? "not reported"}, payment status: ${lookup.paymentStatus ?? "not reported"})`
        : lookup?.outcome === "failed"
          ? `Chowdeck lookup: failed (${lookup.error}); whether the order exists or is paid is unknown`
          : lookup?.outcome === "not_applicable"
            ? "Chowdeck lookup: not applicable (no Chowdeck order id was recorded for this attempt)"
            : undefined;
    if (!outcome.released) {
      if (lookupLine) io.err(lookupLine);
      io.err(`Not marked abandoned: ${outcome.detail}.`);
      return 1;
    }
    if (lookupLine) io.out(lookupLine);
    io.out(
      `Marked abandoned by ${operator.name} at ${outcome.releasedAt.toISOString()} (audit record ${outcome.recoveryId}). This is not a cancellation on Chowdeck.`,
    );
    io.out(`Acknowledged risk: ${outcome.disclosure}`);
    return 0;
  } catch (error) {
    io.err(
      `Recovery failed: ${error instanceof Error ? error.name : "unexpected error"}. Nothing was marked abandoned unless reported above.`,
    );
    return 1;
  } finally {
    if (ownsSql) await sql.close({ timeout: 5 }).catch(() => {});
  }
};

if (import.meta.main) {
  const code = await runRecoveryCli(process.argv.slice(2), process.env, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  process.exit(code);
}
