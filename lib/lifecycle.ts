import type { Server } from "node:http";

/*
 * Graceful shutdown for the HTTP server. On a stop signal the server stops
 * accepting connections, new requests on kept-alive connections are refused
 * (see createHttpApp's lifecycle option), and requests already running get
 * the grace period to finish, so an order request in flight can complete and
 * have its outcome recorded. Nothing is retried or replayed on shutdown or on
 * the next start: an attempt cut off by the grace deadline keeps its marker
 * and is reported as having an unknown outcome.
 */

export const SHUTDOWN_GRACE_MARGIN_MS = 10_000;

/*
 * CHOWBOT_SHUTDOWN_GRACE_MS, or by default the Chowdeck request timeout plus a
 * margin for recording the outcome. The platform's own stop timeout must be
 * longer than this, or it kills the process first.
 */
export const readShutdownGraceMs = (
  env: Record<string, string | undefined>,
  requestTimeoutMs: number,
) => {
  const raw = env.CHOWBOT_SHUTDOWN_GRACE_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : requestTimeoutMs + SHUTDOWN_GRACE_MARGIN_MS;
};

type Log = { info: (message: string) => void; error: (message: string) => void };

export type GracefulShutdownOptions = {
  server: Pick<Server, "close"> & { closeIdleConnections?: () => void };
  graceMs: number;
  /* Runs once requests have drained, e.g. closing the database pool. */
  afterDrain?: () => Promise<void>;
  exit: (code: number) => void;
  log: Log;
};

export const createGracefulShutdown = ({
  server,
  graceMs,
  afterDrain,
  exit,
  log,
}: GracefulShutdownOptions) => {
  let shuttingDown = false;

  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutting down (${reason}); waiting up to ${graceMs}ms for requests in flight.`);

    const deadline = setTimeout(() => {
      log.error(
        "Shutdown grace period expired with requests still running; exiting. Any order attempt cut off here keeps its marker and is reported as an unknown outcome; it is never retried.",
      );
      exit(1);
    }, graceMs);

    server.close(async (error) => {
      clearTimeout(deadline);
      try {
        await afterDrain?.();
      } catch {
        log.error("Closing resources after shutdown failed.");
      }
      log.info("Shutdown complete.");
      exit(error ? 1 : 0);
    });
    server.closeIdleConnections?.();
  };

  return { shutdown, isShuttingDown: () => shuttingDown };
};
