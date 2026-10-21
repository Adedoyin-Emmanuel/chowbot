import {
  connectDatabase,
  describeDatabase,
  readDatabaseConfig,
  deleteExpiredRecords,
} from "./lib/postgres/database";
import { PORT } from "./constants/app";
import { logger } from "./utils/logger";
import { createHttpApp } from "./mcp/http-app";
import { migrate } from "./lib/postgres/migrations";
import { createPostgresStores } from "./lib/postgres";
import { MCP_SERVER_URL, OAUTH_ISSUER_URL } from "./constants/oauth";
import { createKeyring, parseEncryptionKey } from "./lib/encryption";
import { createChowbotRequestStateCodec } from "./lib/request-state";
import { readOrderPlacementConfig } from "./features/order-placement/config";
import { createPaymentStartConfig } from "./features/payments/service";
import { CHOWDECK_REQUEST_TIMEOUT_MS } from "./constants/chowdeck";
import { createGracefulShutdown, readShutdownGraceMs } from "./lib/lifecycle";

const EXPIRED_RECORD_SWEEP_MS = 60 * 60 * 1000;
const READINESS_DB_TIMEOUT_MS = 2000;

const start = async () => {
  const keyring = createKeyring(
    parseEncryptionKey(process.env.CHOWBOT_ENCRYPTION_KEY),
  );
  const databaseConfig = readDatabaseConfig();
  const sql = await connectDatabase(databaseConfig);

  await migrate(sql);
  logger.info(
    `Connected to PostgreSQL at ${describeDatabase(databaseConfig.url)}`,
  );

  const sweepExpired = () =>
    deleteExpiredRecords(sql).catch((error) =>
      logger.warn(
        "Expired OAuth record cleanup failed:",
        error instanceof Error ? error.name : typeof error,
      ),
    );

  const { placeOrderEnabled, paymentChannelQuery, warnings } =
    readOrderPlacementConfig(process.env);
  for (const warning of warnings) logger.warn(warning);

  await sweepExpired();
  setInterval(sweepExpired, EXPIRED_RECORD_SWEEP_MS).unref();

  let shuttingDown = () => false;
  const checkDatabase = async () => {
    try {
      await Promise.race([
        sql`SELECT 1`,
        Bun.sleep(READINESS_DB_TIMEOUT_MS).then(() => {
          throw new Error("timeout");
        }),
      ]);
      return true;
    } catch {
      return false;
    }
  };

  const app = createHttpApp({
    serverUrl: MCP_SERVER_URL,
    issuerUrl: OAUTH_ISSUER_URL,
    ...createPostgresStores(sql, keyring),
    requestStateCodec: createChowbotRequestStateCodec(keyring.requestStateKey),
    placeOrderEnabled,
    ...(paymentChannelQuery && { paymentChannelQuery }),
    // start_payment follows the same switch, with the website's redirect pages.
    ...(placeOrderEnabled && { paymentStartConfig: createPaymentStartConfig() }),
    lifecycle: { isShuttingDown: () => shuttingDown(), checkDatabase },
  });

  const server = app.listen(Number(PORT), () => {
    logger.info("ChowBot MCP Server up and running.");
  });

  const lifecycle = createGracefulShutdown({
    server,
    graceMs: readShutdownGraceMs(process.env, CHOWDECK_REQUEST_TIMEOUT_MS),
    afterDrain: () => sql.close({ timeout: 5 }),
    exit: (code) => process.exit(code),
    log: { info: (m) => logger.info(m), error: (m) => logger.error(m) },
  });
  shuttingDown = lifecycle.isShuttingDown;
  process.once("SIGTERM", () => lifecycle.shutdown("SIGTERM"));
  process.once("SIGINT", () => lifecycle.shutdown("SIGINT"));
};

start().catch((error) => {
  logger.error(
    "ChowBot failed to start:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exit(1);
});
