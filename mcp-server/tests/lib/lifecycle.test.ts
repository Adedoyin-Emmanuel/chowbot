import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "bun:test";

import {
  SHUTDOWN_GRACE_MARGIN_MS,
  createGracefulShutdown,
  readShutdownGraceMs,
} from "../../lib/lifecycle";

/*
 * A real node:http server whose /slow handler answers after `delayMs`.
 */
const listen = async (delayMs: number) => {
  const finished: string[] = [];
  const server: Server = createServer((req, res) => {
    setTimeout(() => {
      finished.push(req.url ?? "");
      res.end("done");
    }, req.url === "/slow" ? delayMs : 0);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, finished };
};

const recorder = () => {
  const exits: number[] = [];
  const logs: string[] = [];
  let drained = 0;
  return {
    exits,
    logs,
    drained: () => drained,
    options: {
      exit: (code: number) => void exits.push(code),
      afterDrain: async () => void drained++,
      log: { info: (m: string) => void logs.push(m), error: (m: string) => void logs.push(m) },
    },
  };
};

describe("readShutdownGraceMs", () => {
  test("defaults to the Chowdeck request timeout plus a margin", () => {
    expect(readShutdownGraceMs({}, 15_000)).toBe(15_000 + SHUTDOWN_GRACE_MARGIN_MS);
  });

  test.each([["0"], ["-5"], ["abc"], ["1.5"], [""]])("ignores the invalid value %p", (value) => {
    expect(readShutdownGraceMs({ CHOWBOT_SHUTDOWN_GRACE_MS: value }, 15_000)).toBe(25_000);
  });

  test("accepts an explicit positive integer", () => {
    expect(readShutdownGraceMs({ CHOWBOT_SHUTDOWN_GRACE_MS: "45000" }, 15_000)).toBe(45_000);
  });
});

describe("createGracefulShutdown", () => {
  test("lets a request in flight finish, refuses new connections, drains, then exits 0", async () => {
    const { server, base, finished } = await listen(300);
    const r = recorder();
    const lifecycle = createGracefulShutdown({ server, graceMs: 5_000, ...r.options });

    const inFlight = fetch(`${base}/slow`).then((res) => res.text());
    await Bun.sleep(50);
    lifecycle.shutdown("SIGTERM");

    expect(lifecycle.isShuttingDown()).toBe(true);
    expect(await fetch(`${base}/fast`).then(() => "served", () => "refused")).toBe("refused");
    expect(await inFlight).toBe("done");
    await Bun.sleep(50);
    expect(finished).toEqual(["/slow"]);
    expect(r.drained()).toBe(1);
    expect(r.exits).toEqual([0]);
  });

  test("exits 1 when the grace period expires before requests finish", async () => {
    const { server, base } = await listen(600);
    const r = recorder();
    const lifecycle = createGracefulShutdown({ server, graceMs: 100, ...r.options });

    const inFlight = fetch(`${base}/slow`).then((res) => res.text(), () => "aborted");
    await Bun.sleep(50);
    lifecycle.shutdown("SIGTERM");
    await Bun.sleep(200);

    expect(r.exits[0]).toBe(1);
    expect(r.logs.join("\n")).toContain("never retried");
    await inFlight;
  });

  test("a second signal does not start a second shutdown", async () => {
    const { server } = await listen(0);
    const r = recorder();
    const lifecycle = createGracefulShutdown({ server, graceMs: 1_000, ...r.options });

    lifecycle.shutdown("SIGTERM");
    lifecycle.shutdown("SIGINT");
    await Bun.sleep(50);

    expect(r.exits).toEqual([0]);
    expect(r.drained()).toBe(1);
    expect(r.logs.filter((m) => m.startsWith("Shutting down"))).toHaveLength(1);
  });
});
