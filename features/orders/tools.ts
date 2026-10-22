import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import OrderService, { ORDER_LIST_STATUSES, type LiveTracking, type OrderDetail, type OrderTimelineResult } from "./service";
import { classifyOrder, orderAmounts, stateFromChowdeck } from "./status";
import { logger } from "../../utils/logger";
import { textResult } from "../../utils/tool-result";
import type { UserSession } from "../../lib/session";
import { NotSignedInError } from "../addresses/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";

const SESSION_UNAVAILABLE =
  "Orders are not available on this connection: the server cannot identify individual users on this transport.";

const AMOUNTS_NOTE =
  "Amounts are Chowdeck's raw values, passed through without unit conversion.";

/*
 * Order IDs are redacted in the capture, so both a positive integer and a
 * short path-safe string are accepted and normalized to a string.
 */
const orderIdSchema = {
  order_id: z
    .union([
      z.number().int().positive(),
      z
        .string()
        .regex(
          /^[A-Za-z0-9_-]{1,64}$/,
          "Expected an order id from list_orders",
        ),
    ])
    .describe("Order ID, as returned by list_orders"),
};

const failure = (action: string, tool: string, error: unknown) => {
  if (error instanceof NotSignedInError) {
    return textResult(
      `Failed to ${action}: not signed in to Chowdeck. Sign in, then try again.`,
      true,
    );
  }
  if (error instanceof ChowdeckApiError) {
    return textResult(`Failed to ${action}: ${error.message}`, true);
  }
  logger.error(
    `Unexpected error in ${tool}:`,
    error instanceof Error ? error.name : typeof error,
  );
  return textResult(`Failed to ${action}: unexpected error`, true);
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export const registerOrderTools = (
  server: McpServer,
  session?: UserSession,
  client?: ChowdeckClient,
) => {
  const service = session && new OrderService(session, client);

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description: `List the signed-in user's Chowdeck orders as summaries: completed orders (the default), or active ones (orders in progress; Chowdeck also lists unpaid orders here, with status "abandoned"). Statuses are passed through as Chowdeck reports them; use track_order for one order's progress. ${AMOUNTS_NOTE}`,
      inputSchema: z.object({
        status: z.enum(ORDER_LIST_STATUSES).default("completed").describe("completed (order history) or active (orders in progress)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ status }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return textResult(JSON.stringify(await service.listOrders(status)));
      } catch (error) {
        return failure("list orders", "list_orders", error);
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: `Get one of the signed-in user's Chowdeck orders, freshly read from Chowdeck: status, items, amounts and payment state. Statuses are passed through as Chowdeck reports them; payment_state is ChowBot's reading of that record (paid only when Chowdeck's payment status is success). ${AMOUNTS_NOTE}`,
      inputSchema: z.object(orderIdSchema),
      annotations: READ_ONLY,
    },
    async ({ order_id }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        const { order } = await service.getOrder(String(order_id));
        const classification = classifyOrder(order);
        const amounts = orderAmounts(order);
        // The order's notes are used internally (to verify an order ChowBot placed) but not listed.
        const { customer_vendor_note: _vendorNote, customer_delivery_note: _deliveryNote, ...listed } = order;
        return textResult(
          JSON.stringify({
            order: listed,
            payment_state: {
              state: classification.state,
              detail: classification.reason,
              source: "Chowdeck's order record, read just now",
            },
            ...(amounts && { amount: amounts }),
          }),
        );
      } catch (error) {
        return failure("get order", "get_order", error);
      }
    },
  );

  server.registerTool(
    "get_order_timeline",
    {
      title: "Get order timeline",
      description:
        "Get the customer-facing progress steps of one of the signed-in user's Chowdeck orders, as Chowdeck reports them.",
      inputSchema: z.object(orderIdSchema),
      annotations: READ_ONLY,
    },
    async ({ order_id }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return textResult(
          JSON.stringify(await service.getOrderTimeline(String(order_id))),
        );
      } catch (error) {
        return failure("get order timeline", "get_order_timeline", error);
      }
    },
  );

  server.registerTool(
    "track_order",
    {
      title: "Track order",
      description:
        "Follow one of the signed-in user's Chowdeck orders, read freshly from Chowdeck: its payment state, Chowdeck's order status, the progress steps, the live delivery details (delivery status, rider and rider location when Chowdeck gives them) and the order's tracking link on chowdeck.com. Show the tracking link to the user as a clickable link; it is private to them, as anyone with it can follow the order. Each part is read once; a part Chowdeck cannot give is listed under unavailable, never guessed.",
      inputSchema: z.object(orderIdSchema),
      annotations: READ_ONLY,
    },
    async ({ order_id }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      const id = String(order_id);
      const unavailable: string[] = [];
      const attempt = async <T>(part: string, read: () => Promise<T>) => {
        try {
          return await read();
        } catch (error) {
          if (error instanceof NotSignedInError) throw error;
          unavailable.push(`${part}: ${error instanceof ChowdeckApiError ? error.message : "unexpected error"}`);
          return undefined;
        }
      };
      try {
        const detail = await attempt("order record", () => service.getOrder(id));
        const timeline = await attempt("progress steps", () => service.getOrderTimeline(id));
        const live = await attempt("live tracking", () => service.getLiveTracking(id));
        if (!detail && !timeline && !live) {
          return textResult(`Failed to track order: Chowdeck gave none of the order's details (${unavailable.join("; ")}).`, true);
        }
        return textResult(JSON.stringify(trackingReport(order_id, detail?.order, timeline, live, unavailable)));
      } catch (error) {
        return failure("track order", "track_order", error);
      }
    },
  );
};

/*
 * What track_order reports. Statuses are Chowdeck's; ChowBot adds only the
 * payment reading (paid only on payment status success) and the next step.
 * The timeline lists Chowdeck's stages: on an unpaid order every stage,
 * MADE_PAYMENT included, was listed with time null (2026-10-22), so a listed
 * stage is never reported as reached.
 */
const trackingReport = (
  orderId: string | number,
  order: OrderDetail | undefined,
  timeline: OrderTimelineResult | undefined,
  live: LiveTracking | undefined,
  unavailable: string[],
) => {
  const classification = order && classifyOrder(order);
  const numericId = Number(orderId);
  const status = classification && Number.isSafeInteger(numericId) ? stateFromChowdeck(numericId, classification) : undefined;
  const link = order?.tracking_url;
  const nextStep = !classification
    ? "Chowdeck's order record could not be read, so the payment state is unknown. Try again later, or use the Chowdeck app."
    : classification.state === "payment_confirmed"
      ? `Tell the user the order's status and delivery details as Chowdeck reports them${link ? ", and give them the tracking link as a clickable link" : ""}.`
      : classification.state === "awaiting_payment"
        ? "Chowdeck shows no payment for this order yet. Tell the user it is unpaid; pay with start_payment (for an order ChowBot placed) or in the Chowdeck app."
        : classification.state === "cancelled"
          ? "Tell the user Chowdeck shows the order cancelled."
          : "Chowdeck's record is inconclusive about payment. Tell the user so, and suggest checking the Chowdeck app.";
  return {
    order_id: orderId,
    status: status ?? {
      order_state: "unknown",
      source: "none: Chowdeck's order record could not be read",
      detail: "the payment state is unknown; this does not mean the order is unpaid, paid or cancelled",
    },
    ...(order && {
      order_status: order.status ?? null,
      ...(order.vendor_name !== undefined && { restaurant: order.vendor_name }),
      ...(order.estimated_delivery_time !== undefined && { estimated_delivery_time: order.estimated_delivery_time }),
      ...(order.actual_delivery_time !== undefined && { actual_delivery_time: order.actual_delivery_time }),
    }),
    tracking_link: link
      ? { url: link, note: "Chowdeck's own tracking page for this order; share it only with people the user chooses" }
      : null,
    ...(live && { live_tracking: live }),
    ...(timeline && {
      progress_steps: timeline.timeline,
      progress_note:
        "These are Chowdeck's stages for the order, in order. Chowdeck lists every stage even before it happens (an unpaid order listed them all, with no times), so a listed stage is not proof it was reached.",
    }),
    ...(unavailable.length > 0 && { unavailable }),
    source: "Chowdeck: GET /customer/order/{id}, /timeline and /live-tracking, read just now",
    next_step: nextStep,
  };
};
