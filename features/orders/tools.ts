import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import OrderService, {
  ORDER_LIST_STATUSES,
  type LiveTracking,
  type OrderDetail,
  type OrderTimelineResult,
  type Rider,
} from "./service";
import {
  classifyOrder,
  orderAmounts,
  reportResult,
  notSentReport,
  stateUnavailable,
  stateFromChowdeck,
} from "./status";
import { logger } from "../../utils/logger";
import { isRecord } from "../../utils/object";
import { validateNote } from "../carts/notes";
import type { UserSession } from "../../lib/session";
import { NotSignedInError } from "../addresses/service";
import { jsonResult, textResult } from "../../utils/tool-result";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";

const SESSION_UNAVAILABLE =
  "Orders are not available on this connection: the server cannot identify individual users on this transport.";

const AMOUNTS_NOTE = "Amounts are in naira.";

/*
 * A positive integer or a short path-safe string, normalized to a string.
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

/*
 * Shown only once Chowdeck's record shows the order paid: before that there
 * is nothing to deliver.
 */
/*
 * Delivered once Chowdeck records a delivery or receipt time (both null in
 * transit, as captured). Not yet rated while vendor_rate_state is unset or
 * "not-yet" (captured on an undelivered order).
 */
const isDelivered = (order: OrderDetail, live?: LiveTracking) =>
  [order.actual_delivery_time, order.time_customer_received_order, live?.delivered_at].some(
    (time) => typeof time === "string" && time.length > 0,
  );
const notYetRated = (order: OrderDetail) =>
  order.vendor_rate_state === undefined || order.vendor_rate_state === null || order.vendor_rate_state === "not-yet";

export const RATE_PROMPT =
  "The order is delivered: ask the user how it was and offer to rate the restaurant and its items with rate_order (a 1-5 rating, reasons, a review and a thumbs up or down per item). Use only what they say.";

const ratePromptFor = (order: OrderDetail | undefined, live?: LiveTracking) =>
  order && isDelivered(order, live) && notYetRated(order) ? RATE_PROMPT : undefined;

const deliveryPinOf = (order: OrderDetail, state: string) =>
  state === "payment_confirmed" && typeof order.delivery_pin === "string"
    ? {
        pin: order.delivery_pin,
        note: "The rider asks for this PIN when handing over the order. The user should give it only to the rider, at delivery.",
      }
    : undefined;

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
        status: z
          .enum(ORDER_LIST_STATUSES)
          .default("completed")
          .describe("completed (order history) or active (orders in progress)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ status }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return jsonResult(await service.listOrders(status));
      } catch (error) {
        return failure("list orders", "list_orders", error);
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: `Get one of the signed-in user's Chowdeck orders, freshly read from Chowdeck: status, items, amounts and payment state. Statuses are passed through as Chowdeck reports them; payment_state is ChowBot's reading of that record (paid only when Chowdeck's payment status is success). Once paid, delivery_pin is the PIN the rider asks for at handover. ${AMOUNTS_NOTE}`,
      inputSchema: z.object(orderIdSchema),
      annotations: READ_ONLY,
    },
    async ({ order_id }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        const { order } = await service.getOrder(String(order_id));
        const classification = classifyOrder(order);
        const amounts = orderAmounts(order);
        // Notes are used internally to verify placed orders, not listed.
        const {
          customer_vendor_note: _vendorNote,
          customer_delivery_note: _deliveryNote,
          delivery_pin: _pin,
          ...listed
        } = order;
        const pin = deliveryPinOf(order, classification.state);
        return jsonResult({
          order: listed,
          ...(pin && { delivery_pin: pin }),
          payment_state: {
            state: classification.state,
            detail: classification.reason,
            source: "Chowdeck's order record, read just now",
          },
          ...(amounts && { amount: amounts }),
          ...(ratePromptFor(order) && { next_step: ratePromptFor(order) }),
        });
      } catch (error) {
        return failure("get order", "get_order", error);
      }
    },
  );

  server.registerTool(
    "get_delivery_pin",
    {
      title: "Get delivery PIN",
      description:
        "Get the delivery PIN for one of the signed-in user's paid Chowdeck orders (the code the rider asks for at handover), with the assigned rider's name and average rating. Read freshly from Chowdeck; an unpaid or cancelled order has no PIN to give.",
      inputSchema: z.object(orderIdSchema),
      annotations: READ_ONLY,
    },
    async ({ order_id }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        const { order } = await service.getOrder(String(order_id));
        const { state, reason } = classifyOrder(order);
        const pin = deliveryPinOf(order, state);
        if (pin) {
          let rider: Rider | undefined;
          let riderUnavailable: string | undefined;
          try {
            rider = await service.getRider(String(order_id));
          } catch (error) {
            if (error instanceof NotSignedInError) throw error;
            riderUnavailable = error instanceof ChowdeckApiError ? error.message : "unexpected error";
          }
          return jsonResult({
            order_id,
            delivery_pin: pin.pin,
            note: pin.note,
            rider: rider ?? (riderUnavailable ? `could not be read (${riderUnavailable})` : "not assigned yet"),
          });
        }
        return jsonResult(
          {
            order_id,
            delivery_pin: null,
            reason:
              state === "payment_confirmed"
                ? "Chowdeck's order record has no delivery PIN for this order"
                : `there is no PIN to give before the order is paid: ${reason}`,
          },
          true,
        );
      } catch (error) {
        return failure("get the delivery PIN", "get_delivery_pin", error);
      }
    },
  );

  server.registerTool(
    "rate_order",
    {
      title: "Rate the restaurant and items",
      description:
        "Rate the restaurant of one of the signed-in user's delivered Chowdeck orders, as the website's rating screen does: a 1-5 rating, optional reasons, an optional written review, and a thumbs up or down per item (item_id from get_order). On the website the reasons shown for 5 are Worth it, Very tasty, Nice packaging, High quality and Highly recommend. Offer it once an order is delivered, and use only what the user said; never rate for them. Sent once. This rates the restaurant, not the rider.",
      inputSchema: z.object({
        ...orderIdSchema,
        rating: z.number().int().min(1).max(5).describe("The user's rating of the restaurant, 1 (worst) to 5 (loved it)"),
        reasons: z.array(z.string().trim().min(1).max(60)).max(10).optional().describe("Why, in the user's words or the website's options"),
        review: z.string().trim().max(1000).optional().describe("A written review, if the user gave one"),
        items: z
          .array(z.object({ item_id: z.number().int().positive(), liked: z.boolean() }).strict())
          .max(50)
          .optional()
          .describe("Thumbs up (liked: true) or down per item the user rated"),
        public: z.boolean().default(true).describe("Show the review publicly, as the website does by default"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return await rateOrder(service, String(args.order_id), args);
      } catch (error) {
        return failure("rate the order", "rate_order", error);
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
        return jsonResult(await service.getOrderTimeline(String(order_id)));
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
        "Follow one of the signed-in user's Chowdeck orders, read freshly from Chowdeck: its payment state, Chowdeck's order status, the progress steps, the live delivery details (delivery status, ETA and rider location), the rider's name and average rating once one is assigned, the order's tracking link on chowdeck.com and, once Chowdeck shows the order paid, the delivery PIN the rider asks for at handover. Show the tracking link to the user as a clickable link; it is private to them, as anyone with it can follow the order. Each part is read once; a part Chowdeck cannot give is listed under unavailable, never guessed.",
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
          unavailable.push(
            `${part}: ${error instanceof ChowdeckApiError ? error.message : "unexpected error"}`,
          );
          return undefined;
        }
      };
      try {
        const detail = await attempt("order record", () =>
          service.getOrder(id),
        );
        const timeline = await attempt("progress steps", () =>
          service.getOrderTimeline(id),
        );
        const live = await attempt("live tracking", () =>
          service.getLiveTracking(id),
        );
        // A rider is only assigned to a paid order.
        const rider =
          detail && classifyOrder(detail.order).state === "payment_confirmed"
            ? await attempt("rider", () => service.getRider(id))
            : undefined;
        if (!detail && !timeline && !live) {
          return textResult(
            `Failed to track order: Chowdeck gave none of the order's details (${unavailable.join("; ")}).`,
            true,
          );
        }
        return jsonResult(
          trackingReport(order_id, detail?.order, timeline, live, unavailable, rider),
        );
      } catch (error) {
        return failure("track order", "track_order", error);
      }
    },
  );
  server.registerTool(
    "update_order_delivery_note",
    {
      title: "Change an order's rider note",
      description:
        "Change or clear the delivery (rider) note on one of the signed-in user's Chowdeck orders that was already placed, as the Chowdeck website does. Sent once; the change counts only when Chowdeck's order record, read again, shows the new note. A cancelled order is refused, and Chowdeck may refuse others (for example once the order is delivered). Up to 500 characters (ChowBot's limit). For an order not yet placed, use set_cart_notes instead.",
      inputSchema: z.object({
        ...orderIdSchema,
        delivery_note: z
          .string()
          .max(4000)
          .nullable()
          .describe('The new note for the rider; null or "" clears it'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ order_id, delivery_note }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return await updateDeliveryNote(
          service,
          String(order_id),
          delivery_note,
        );
      } catch (error) {
        return failure(
          "change the rider note",
          "update_order_delivery_note",
          error,
        );
      }
    },
  );
};

type RatingArgs = {
  rating: number;
  reasons?: string[];
  review?: string;
  items?: { item_id: number; liked: boolean }[];
  public: boolean;
};

/*
 * Checks the order and its items with Chowdeck, then sends the rating once.
 * A thumbs up is item_rating 5, as captured; a thumbs down is sent as 1,
 * which was not captured.
 */
const rateOrder = async (service: OrderService, orderId: string, args: RatingArgs) => {
  const refuse = (message: string, nextStep: string) => notSentReport("rate_order", message, nextStep);
  let order: OrderDetail;
  try {
    ({ order } = await service.getOrder(orderId));
  } catch (error) {
    if (error instanceof NotSignedInError) throw error;
    return refuse(
      `Rating not sent: ChowBot could not read the order from Chowdeck (${error instanceof ChowdeckApiError ? error.message : "unexpected error"}).`,
      "Try again later.",
    );
  }
  if (classifyOrder(order).state !== "payment_confirmed") {
    return refuse("Rating not sent: Chowdeck's record does not show this order paid, so there is nothing to rate.", "Rate an order once it has been delivered.");
  }
  const orderItems = new Set((order.items ?? []).map((item) => item.item_id));
  const unknown = (args.items ?? []).filter((item) => !orderItems.has(item.item_id));
  if (unknown.length > 0) {
    return refuse(
      `Rating not sent: item ${unknown.map((item) => item.item_id).join(", ")} is not part of this order.`,
      "Use item_id values from get_order for this order.",
    );
  }

  const body = {
    vendor_rating: args.rating,
    vendor_rating_reasons: args.reasons ?? [],
    vendor_review: args.review ?? "",
    order_items_rating: (args.items ?? []).map((item) => ({ item_id: item.item_id, item_rating: item.liked ? 5 : 1 })),
    is_public: args.public,
  };
  let response: unknown;
  try {
    response = await service.sendRating(orderId, body);
  } catch (error) {
    if (error instanceof NotSignedInError) throw error;
    const definite =
      error instanceof ChowdeckApiError && error.kind === "http" && error.status !== undefined && error.status < 500 && error.status !== 401;
    const detail = error instanceof ChowdeckApiError ? error.message : "unexpected error";
    return reportResult(
      {
        action: "rate_order",
        outcome: definite ? "rejected_by_chowdeck" : "unknown_outcome",
        message: definite ? `Chowdeck did not accept the rating (${detail}).` : `The rating's outcome is unknown (${detail}).`,
        chowdeck_confirmed: definite ? [`Chowdeck refused the rating (${detail})`] : [],
        status: null,
        next_step: definite
          ? "Tell the user Chowdeck did not accept the rating, with its reason."
          : "Do not send it again: Chowdeck may already have it. The user can see their rating in the Chowdeck app.",
        outcome_uncertain: !definite,
        safe_to_retry: definite,
      },
      true,
    );
  }
  if (!isRecord(response) || response.status !== "success") {
    return reportResult(
      {
        action: "rate_order",
        outcome: "unknown_outcome",
        message: "Chowdeck's answer to the rating was not a success, so it is not confirmed.",
        chowdeck_confirmed: [],
        status: null,
        next_step: "Do not send it again: Chowdeck may already have it.",
        outcome_uncertain: true,
        safe_to_retry: false,
      },
      true,
    );
  }
  return reportResult({
    action: "rate_order",
    outcome: "rated",
    message: `The rating for order ${orderId} was added: Chowdeck answered${typeof response.message === "string" ? ` "${response.message}"` : " success"}.`,
    chowdeck_confirmed: ["Chowdeck accepted the rating"],
    status: null,
    rating: args.rating,
    next_step: "Tell the user their rating was added.",
    outcome_uncertain: false,
    safe_to_retry: false,
  });
};

const ACTION = "update_order_delivery_note";
const quoted = (note: string) => (note ? `"${note}"` : "none");
const noteOf = (order: OrderDetail) =>
  typeof order.customer_delivery_note === "string"
    ? order.customer_delivery_note
    : "";

/*
 * Only a re-read of the order after the change confirms the note.
 */
const updateDeliveryNote = async (
  service: OrderService,
  orderId: string,
  input: string | null,
) => {
  const checked = validateNote(input);
  if (!checked.ok) {
    return notSentReport(
      ACTION,
      `Rider note not changed: the note ${checked.error}.`,
      "Shorten or correct the note and try again.",
    );
  }
  const note = checked.value;
  const numericId = Number(orderId);
  const stateOf = (order: OrderDetail) =>
    Number.isSafeInteger(numericId)
      ? stateFromChowdeck(numericId, classifyOrder(order))
      : null;

  let before: OrderDetail;
  try {
    ({ order: before } = await service.getOrder(orderId));
  } catch (error) {
    if (error instanceof NotSignedInError) throw error;
    const reason =
      error instanceof ChowdeckApiError ? error.message : "unexpected error";
    return notSentReport(
      ACTION,
      `Rider note not changed: ChowBot could not read the order from Chowdeck (${reason}). Nothing was sent.`,
      "Try again later.",
      Number.isSafeInteger(numericId)
        ? stateUnavailable(numericId, reason)
        : null,
    );
  }
  if (classifyOrder(before).state === "cancelled") {
    return notSentReport(
      ACTION,
      "Rider note not changed: Chowdeck's order record shows this order cancelled. Nothing was sent.",
      "Nothing to change.",
      stateOf(before),
    );
  }
  if (noteOf(before) === note) {
    return reportResult({
      action: ACTION,
      outcome: "unchanged",
      message: `Chowdeck's order record already has the rider note ${quoted(note)}. Nothing was sent.`,
      chowdeck_confirmed: [
        `the rider note on Chowdeck's order record is ${quoted(note)}`,
      ],
      status: stateOf(before),
      next_step: "Nothing to change.",
      outcome_uncertain: false,
      safe_to_retry: true,
    });
  }

  let requestDetail: string | undefined;
  let rejected = false;
  try {
    const response = await service.sendDeliveryNote(orderId, note);
    if (!isRecord(response) || response.status !== "success")
      requestDetail = "Chowdeck's answer was not a success";
  } catch (error) {
    if (error instanceof NotSignedInError) throw error;
    const definite =
      error instanceof ChowdeckApiError &&
      error.kind === "http" &&
      error.status !== undefined &&
      error.status < 500 &&
      error.status !== 401;
    rejected = definite;
    requestDetail =
      error instanceof ChowdeckApiError ? error.message : "unexpected error";
  }
  if (rejected) {
    return reportResult(
      {
        action: ACTION,
        outcome: "rejected_by_chowdeck",
        message: `Rider note not changed: Chowdeck refused the change (${requestDetail}).`,
        chowdeck_confirmed: [`Chowdeck refused the change (${requestDetail})`],
        status: stateOf(before),
        next_step:
          "Tell the user Chowdeck did not accept the change; they can contact the rider or Chowdeck from the app.",
        outcome_uncertain: false,
        safe_to_retry: false,
      },
      true,
    );
  }

  let after: OrderDetail | undefined;
  try {
    ({ order: after } = await service.getOrder(orderId));
  } catch (error) {
    if (error instanceof NotSignedInError) throw error;
  }
  if (after && noteOf(after) === note) {
    return reportResult({
      action: ACTION,
      outcome: "note_changed",
      message: `The rider note on order ${orderId} is now ${quoted(note)}: Chowdeck's order record confirms it.`,
      chowdeck_confirmed: [
        `the rider note on Chowdeck's order record is ${quoted(note)}`,
      ],
      status: stateOf(after),
      next_step: "Tell the user the rider note was changed.",
      outcome_uncertain: false,
      safe_to_retry: true,
    });
  }
  return reportResult(
    {
      action: ACTION,
      outcome: "unconfirmed",
      message: `The rider note change is not confirmed${requestDetail ? ` (${requestDetail})` : ""}: ${after ? `Chowdeck's order record still shows ${quoted(noteOf(after))}` : "the order could not be read again"}.`,
      chowdeck_confirmed: after
        ? [
            `the rider note on Chowdeck's order record is ${quoted(noteOf(after))}`,
          ]
        : [],
      status: after ? stateOf(after) : null,
      next_step:
        "Do not tell the user the note was changed. They can check the order in the Chowdeck app; sending the same note again only repeats the same change.",
      outcome_uncertain: true,
      safe_to_retry: false,
    },
    true,
  );
};

/*
 * Chowdeck lists every timeline stage before it happens, so a listed stage is
 * never reported as reached.
 */
const trackingReport = (
  orderId: string | number,
  order: OrderDetail | undefined,
  timeline: OrderTimelineResult | undefined,
  live: LiveTracking | undefined,
  unavailable: string[],
  rider?: Rider,
) => {
  const classification = order && classifyOrder(order);
  const numericId = Number(orderId);
  const status =
    classification && Number.isSafeInteger(numericId)
      ? stateFromChowdeck(numericId, classification)
      : undefined;
  const link = order?.tracking_url;
  const pin = order && classification ? deliveryPinOf(order, classification.state) : undefined;
  const nextStep = !classification
    ? "Chowdeck's order record could not be read, so the payment state is unknown. Try again later, or use the Chowdeck app."
    : classification.state === "payment_confirmed"
      ? ratePromptFor(order, live) ??
        `Tell the user the order's status and delivery details as Chowdeck reports them${link ? ", and give them the tracking link as a clickable link" : ""}${pin ? ", and their delivery PIN for the rider" : ""}.`
      : classification.state === "awaiting_payment"
        ? "Chowdeck shows no payment for this order yet. Tell the user it is unpaid; they can pay with start_payment or in the Chowdeck app, or leave it unpaid."
        : classification.state === "cancelled"
          ? "Tell the user Chowdeck shows the order cancelled."
          : "Chowdeck's record is inconclusive about payment. Tell the user so, and suggest checking the Chowdeck app.";
  return {
    order_id: orderId,
    status: status ?? {
      order_state: "unknown",
      source: "none: Chowdeck's order record could not be read",
      detail:
        "the payment state is unknown; this does not mean the order is unpaid, paid or cancelled",
    },
    ...(order && {
      order_status: order.status ?? null,
      ...(order.vendor_name !== undefined && { restaurant: order.vendor_name }),
      ...(order.estimated_delivery_time !== undefined && {
        estimated_delivery_time: order.estimated_delivery_time,
      }),
      ...(order.actual_delivery_time !== undefined && {
        actual_delivery_time: order.actual_delivery_time,
      }),
    }),
    ...(pin && { delivery_pin: pin }),
    tracking_link: link
      ? {
          url: link,
          note: "Chowdeck's own tracking page for this order; share it only with people the user chooses",
        }
      : null,
    ...(rider && { rider }),
    ...(live && { live_tracking: live }),
    ...(timeline && {
      progress_steps: timeline.timeline,
      progress_note:
        "These are Chowdeck's stages for the order, in order. Chowdeck lists every stage even before it happens (an unpaid order listed them all, with no times), so a listed stage is not proof it was reached.",
    }),
    ...(unavailable.length > 0 && { unavailable }),
    source:
      "Chowdeck: GET /customer/order/{id}, /timeline and /live-tracking, read just now",
    next_step: nextStep,
  };
};
