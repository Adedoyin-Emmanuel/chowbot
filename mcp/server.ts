import { McpServer, type RequestStateCodec } from "@modelcontextprotocol/server";

import iconPath from "../assets/images/chowbot-icon.png" with { type: "file" };

import type { UserSession } from "../lib/session";
import type { UserOrderSubmissions } from "../lib/order-submissions";
import { registerAuthTools } from "../features/auth/tools";
import { registerMenuTools } from "../features/menus/tools";
import { registerCartTools } from "../features/carts/tools";
import { registerCheckoutTools } from "../features/checkout/tools";
import { registerOrderTools } from "../features/orders/tools";
import { registerOrderPlacementTools } from "../features/order-placement/tools";
import type { PaymentChannelQuery } from "../features/order-placement/channels";
import { registerPaymentTools } from "../features/payments/tools";
import type { PaymentStartConfig } from "../features/payments/service";
import { registerAddressTools } from "../features/addresses/tools";
import { registerArithmeticTool } from "../features/arithmetic/tools";
import { registerRestaurantTools } from "../features/restaurants/tools";

/*
 * Inlined as a data URI so clients can show the icon over stdio too, where
 * there is no HTTP server to fetch it from.
 */
const ICON_BYTES = await Bun.file(
  new URL(iconPath, import.meta.url),
).arrayBuffer();
const SERVER_ICON = {
  src: `data:image/png;base64,${Buffer.from(ICON_BYTES).toString("base64")}`,
  mimeType: "image/png",
  sizes: ["192x192"],
};

/*
 * Chat-based OTP login is only for the local stdio entry point. Remote
 * clients sign in through the browser /authorize flow, so the OTP never
 * passes through an AI conversation.
 */
export type ServerOptions = {
  session?: UserSession;
  enableChatLogin?: boolean;
  submissions?: UserOrderSubmissions;
  requestStateCodec?: RequestStateCodec;
  paymentChannelQuery?: PaymentChannelQuery;
  paymentStartConfig?: PaymentStartConfig;
  placeOrderEnabled?: boolean;
};

/*
 * With a requestStateCodec (hosted HTTP), every multi-round-trip
 * requestState is verified before any handler runs; state that fails the
 * HMAC, expiry or user binding is rejected by the SDK.
 */
export const createServer = ({
  session,
  enableChatLogin = false,
  submissions,
  requestStateCodec,
  paymentChannelQuery,
  paymentStartConfig,
  placeOrderEnabled,
}: ServerOptions = {}) => {
  const server = new McpServer(
    {
      name: "ChowBot",
      version: "1.0.0",
      icons: [SERVER_ICON],
    },
    requestStateCodec && { requestState: { verify: requestStateCodec.verify } },
  );

  registerArithmeticTool(server);
  registerRestaurantTools(server, session);
  registerMenuTools(server, session);
  registerAddressTools(server, session);
  registerCartTools(server, session);
  registerCheckoutTools(server, session, undefined, submissions);
  registerOrderTools(server, session);
  registerOrderPlacementTools(server, {
    session,
    submissions,
    requestStateCodec,
    paymentChannelQuery,
    placeOrderEnabled,
  });
  registerPaymentTools(server, {
    session,
    submissions,
    requestStateCodec,
    paymentStartConfig,
  });

  if (enableChatLogin) registerAuthTools(server, session);

  return server;
};
