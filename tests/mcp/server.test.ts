import { describe, expect, test } from "bun:test";

import { rpc } from "../helpers/mcp";
import { createServer, SERVER_INSTRUCTIONS } from "../../mcp/server";

describe("ChowBot server", () => {
  test("gives connecting clients the ordering guidance", async () => {
    const result = await rpc(() => createServer(), "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });

    expect(result.instructions).toBe(SERVER_INSTRUCTIONS);
    for (const option of ["note for the restaurant", "note for the rider", "rider tip", "promo code", "brown bags", "gift", "how to pay", "delivery PIN"]) {
      expect(SERVER_INSTRUCTIONS).toContain(option);
    }
    expect(SERVER_INSTRUCTIONS).toContain("Do not add uncertainty of your own");
    expect(SERVER_INSTRUCTIONS).toContain("whether to save them as a beneficiary");
  });
});
