import {
  McpServer,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";

import iconPath from "../assets/images/chowbot-icon.png" with { type: "file" };

import type { UserSession } from "../lib/session";
import { registerAuthTools } from "../features/auth/tools";
import { registerMenuTools } from "../features/menus/tools";
import { registerCartTools } from "../features/carts/tools";
import { registerOrderTools } from "../features/orders/tools";
import { registerPaymentTools } from "../features/payments/tools";
import { registerAddressTools } from "../features/addresses/tools";
import { registerCheckoutTools } from "../features/checkout/tools";
import type { UserOrderSubmissions } from "../lib/order-submissions";
import type { PaymentStartConfig } from "../features/payments/service";
import { registerRestaurantTools } from "../features/restaurants/tools";
import type { PaymentChannelQuery } from "../features/order-placement/channels";
import { registerOrderPlacementTools } from "../features/order-placement/tools";

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

export type ServerOptions = {
  session?: UserSession;
  enableChatLogin?: boolean;
  placeOrderEnabled?: boolean;
  submissions?: UserOrderSubmissions;
  requestStateCodec?: RequestStateCodec;
  paymentStartConfig?: PaymentStartConfig;
  paymentChannelQuery?: PaymentChannelQuery;
};

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

  registerRestaurantTools(server, session);
  registerMenuTools(server, session);
  registerAddressTools(server, session);
  registerCartTools(server, session, undefined, submissions);
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
    paymentStartConfig,
  });

  if (enableChatLogin) registerAuthTools(server, session);

  return server;
};
