import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";

import { callTool } from "../../helpers/mcp";
import { ChowdeckClient } from "../../../lib/client";
import { registerPaymentTools } from "../../../features/payments/tools";
import { createPaymentStartConfig, paymentRedirects } from "../../../features/payments/service";
import {
  ORDER_ID,
  PAYMENT_LINK,
  mock,
  orderRecord,
  parse,
  paymentStarted,
  route,
  sent,
  signedIn,
  slow,
  useMockChowdeck,
} from "../../helpers/ordering";

useMockChowdeck();

const START_PATH = "/customer/payment/start/v2";
const ORDER_PATH = `/customer/order/${ORDER_ID}`;

const payAs = async (args: Record<string, unknown> = {}, timeoutMs = 1000) => {
  const session = await signedIn();
  return callTool(
    () => {
      const server = new McpServer({ name: "ChowBot", version: "test" });
      registerPaymentTools(server, {
        session,
        paymentStartConfig: createPaymentStartConfig(),
        client: new ChowdeckClient({ baseUrl: mock.url, timeoutMs }),
      });
      return server;
    },
    "start_payment",
    { order_id: ORDER_ID, payment_channel: "card", ...args },
  );
};

const starts = () => sent("POST", START_PATH);

describe("start_payment", () => {
  test("is registered only with a session and the payment redirects", async () => {
    const names = (options: Parameters<typeof registerPaymentTools>[1]) => {
      const server = new McpServer({ name: "ChowBot", version: "test" });
      registerPaymentTools(server, options);
      return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    };
    const session = await signedIn();

    expect(names({ session, paymentStartConfig: createPaymentStartConfig() })).toEqual(["start_payment"]);
    expect(names({ session })).toEqual([]);
    expect(names({ paymentStartConfig: createPaymentStartConfig() })).toEqual([]);
  });

  test("reads the order from Chowdeck first, starts the payment once, and returns the link with Chowdeck's total", async () => {
    route(`GET ${ORDER_PATH}`, orderRecord());
    route(`POST ${START_PATH}`, paymentStarted());

    const result = await payAs();
    const report = parse(result);

    expect(result.isError).toBeUndefined();
    expect(mock.received.map((r) => `${r.method} ${r.path}`)).toEqual([`GET ${ORDER_PATH}`, `POST ${START_PATH}`]);
    expect(starts()[0]!.body).toEqual({ method: "card", order_id: ORDER_ID, ...paymentRedirects(createPaymentStartConfig(), ORDER_ID, "card") });
    expect(report).toMatchObject({
      outcome: "payment_link_generated",
      payment_link: PAYMENT_LINK,
      amount: { total: "₦5,540.00" },
      status: { order_state: "awaiting_payment" },
      safe_to_retry: false,
    });
    expect(report).not.toHaveProperty("confirmed_total");
    expect(result.content[0]!.text).not.toContain("PRIVATE-reference");
  });

  test("uses OPay's own redirects", async () => {
    route(`GET ${ORDER_PATH}`, orderRecord());
    route(`POST ${START_PATH}`, paymentStarted());

    await payAs({ payment_channel: "opay" });

    expect(starts()[0]!.body).toMatchObject({
      method: "opay",
      return_url: `https://chowdeck.com/store/ongoing-order?orderId=${ORDER_ID}`,
      cancel_url: "https://chowdeck.com/store/checkout?status=failed",
    });
  });

  test.each([
    ["paid", { payment: { status: "success" } }, "already_paid"],
    ["cancelled", { status: "cancelled" }, "not_sent"],
    ["inconclusive", { payment: { status: "reversed" } }, "not_sent"],
    ["a pay-for-me order", { has_external_payment: true }, "not_sent"],
    ["without a total", { total_price: null }, "not_sent"],
  ])("starts nothing when Chowdeck's order record shows it %s", async (_, fields, outcome) => {
    route(`GET ${ORDER_PATH}`, orderRecord(fields));

    const report = parse(await payAs());

    expect(report.outcome).toBe(outcome);
    expect(starts()).toHaveLength(0);
  });

  test("starts nothing when the order cannot be read, and says the state is unknown", async () => {
    route(`GET ${ORDER_PATH}`, () => Response.json({ message: "Server Error" }, { status: 500 }));

    const report = parse(await payAs());

    expect(report).toMatchObject({ outcome: "not_sent", status: { order_state: "unknown" } });
    expect(starts()).toHaveLength(0);
  });

  test("a pocket payment needs the payer's tag and sends it without the @", async () => {
    route(`GET ${ORDER_PATH}`, orderRecord());
    route(`POST ${START_PATH}`, paymentStarted({ display_type: "inapp" }));

    expect(parse(await payAs({ payment_channel: "pocket" })).outcome).toBe("not_sent");
    expect(mock.received).toHaveLength(0);

    const report = parse(await payAs({ payment_channel: "pocket", pocket_tag: "@ada_pays" }));
    expect(starts()[0]!.body).toMatchObject({ method: "pocket", pocket_tag: "ada_pays" });
    expect(report.message).toContain("Pocket app");
  });

  test("warns when Chowdeck already shows an unfinished payment", async () => {
    route(`GET ${ORDER_PATH}`, orderRecord({ payment: { status: "pending" } }));
    route(`POST ${START_PATH}`, paymentStarted());

    const report = parse(await payAs());

    expect(report.status.order_state).toBe("payment_pending");
    expect(report.warnings.join(" ")).toContain("rather than pay again");
  });

  test("reports Chowdeck's definite refusal without retrying", async () => {
    route(`GET ${ORDER_PATH}`, orderRecord());
    route(`POST ${START_PATH}`, () => Response.json({ message: "Order already paid" }, { status: 422 }));

    const report = parse(await payAs());

    expect(report.outcome).toBe("rejected_by_chowdeck");
    expect(starts()).toHaveLength(1);
  });

  /*
   * An unclear payment start is never repeated: the order record is read
   * once more for evidence, and the outcome stays unknown.
   */
  test.each([
    ["a timeout", slow(paymentStarted())],
    ["a server error", () => Response.json({ message: "Server Error" }, { status: 502 })],
    ["a 401", () => Response.json({ message: "Unauthenticated" }, { status: 401 })],
    ["a non-https link", paymentStarted({ authorization_url: "http://pay.example/PRIVATE-PAYMENT-LINK" })],
  ])("after %s, reads the order again and reports an unknown outcome without retrying", async (_, handler) => {
    route(`GET ${ORDER_PATH}`, orderRecord(), orderRecord({ payment: { status: "pending" } }));
    route(`POST ${START_PATH}`, handler);

    const result = await payAs({}, 100);
    const report = parse(result);

    expect(result.isError).toBe(true);
    expect(report).toMatchObject({ outcome: "unknown_outcome", outcome_uncertain: true, safe_to_retry: false, status: { order_state: "payment_pending" } });
    expect(report.message).toContain("now shows an unfinished payment");
    expect(report.next_step).toContain("Do not start another payment straight away");
    expect(starts()).toHaveLength(1);
    expect(sent("GET", ORDER_PATH)).toHaveLength(2);
    expect(result.content[0]!.text).not.toContain("PRIVATE-PAYMENT-LINK");
  });

  test("an unclear start after which Chowdeck shows the order paid is reported as paid", async () => {
    route(`GET ${ORDER_PATH}`, orderRecord(), orderRecord({ payment: { status: "success" } }));
    route(`POST ${START_PATH}`, () => Response.json({ message: "Server Error" }, { status: 502 }));

    const report = parse(await payAs());

    expect(report).toMatchObject({ outcome: "already_paid", status: { order_state: "payment_confirmed" } });
    expect(starts()).toHaveLength(1);
  });
});
