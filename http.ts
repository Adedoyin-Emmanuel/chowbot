import { PORT } from "./constants/app";
import { logger } from "./utils/logger";
import { migrate } from "./lib/postgres/migrations";
import { createHttpApp } from "./mcp/http-app";
import { createPostgresStores } from "./lib/postgres";
import { createKeyring, parseEncryptionKey } from "./lib/encryption";
import { MCP_SERVER_URL, OAUTH_ISSUER_URL } from "./constants/oauth";
import {
  connectDatabase,
  describeDatabase,
  readDatabaseConfig,
  deleteExpiredRecords,
} from "./lib/postgres/database";

const EXPIRED_RECORD_SWEEP_MS = 60 * 60 * 1000;

const start = async () => {
  const keyring = createKeyring(parseEncryptionKey(process.env.CHOWBOT_ENCRYPTION_KEY));
  const databaseConfig = readDatabaseConfig();
  const sql = await connectDatabase(databaseConfig);

  const applied = await migrate(sql);
  logger.info(
    `Connected to PostgreSQL at ${describeDatabase(databaseConfig.url)}; ` +
      (applied.length ? `applied migrations ${applied.join(", ")}` : "schema up to date"),
  );

  const sweepExpired = () =>
    deleteExpiredRecords(sql).catch((error) =>
      logger.warn("Expired OAuth record cleanup failed:", error instanceof Error ? error.name : typeof error),
    );
  await sweepExpired();
  setInterval(sweepExpired, EXPIRED_RECORD_SWEEP_MS).unref();

  const app = createHttpApp({
    serverUrl: MCP_SERVER_URL,
    issuerUrl: OAUTH_ISSUER_URL,
    ...createPostgresStores(sql, keyring),
  });

  app.listen(Number(PORT), () => {
    logger.info("ChowBot MCP Server up and running.");
  });
};

start().catch((error) => {
  logger.error(
    "ChowBot failed to start:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exit(1);
});
