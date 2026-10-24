import { McpServer } from "@modelcontextprotocol/server";

import iconPath from "../assets/images/chowbot-icon.png" with { type: "file" };

import type { UserSession } from "../lib/session";
import { registerAuthTools } from "../features/auth/tools";
import { registerMenuTools } from "../features/menus/tools";
import { registerCartTools } from "../features/carts/tools";
import { registerOrderTools } from "../features/orders/tools";
import { registerPaymentTools } from "../features/payments/tools";
import { registerAddressTools } from "../features/addresses/tools";
import { registerCheckoutTools } from "../features/checkout/tools";
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

/*
 * Given to the assistant when a client connects. ChowBot has no screen of its
 * own, so the conversation has to cover what the Chowdeck checkout page
 * shows: the assistant offers each option rather than waiting to be asked.
 */
export const SERVER_INSTRUCTIONS = [
  "ChowBot orders food on Chowdeck for the signed-in user. There is no checkout screen: you are it, so tell the user what they can choose instead of waiting for them to ask.",
  "Finding food: search_restaurants for a dish or place, browse_restaurants for nearby, Chowdeck's picks or the user's usual places, then get_restaurant_menu (section popular shows what a place is known for) and get_menu_item for options.",
  "Before placing an order, get_checkout_quote and show the total, then go through checkout_details.ask_the_user_about in one short message: a note for the restaurant, a note for the rider, a rider tip (never choose one for them), a promo code or voucher, brown bags, whether it is a gift (list_beneficiaries for saved recipients) and how to pay. Say what is already set and accept \"no\" for anything. If something changes the cart, such as bags or a promo code, quote again.",
  "For a gift, check list_beneficiaries first: use beneficiary_id for someone already saved. For someone new, take their name and phone, and ask whether to save them as a beneficiary for next time (gift.save_as_beneficiary: true only if they say yes).",
  "When the user says to place the order, call place_order once with the quoted total; do not ask them to confirm again. Give them the payment link from the result.",
  "Until an order is paid the user can change anything by updating the cart and placing it again; the unpaid order is never charged.",
  "After payment, track_order gives the status, rider details, tracking link and delivery PIN (get_delivery_pin gives the PIN alone). Remind the user to give the PIN only to the rider.",
  "Once an order is delivered, offer to rate the restaurant and its items (rate_order): a 1-5 rating, reasons, a review and a thumbs up or down per item. Use only what the user says.",
  "Amounts in results are already in naira. Report what Chowdeck confirms, and only that.",
  "Do not add uncertainty of your own. When a result confirms something (a cart cleared, an order placed, a payment confirmed, a note saved), state it as done, with no hedging, guesses or advice to double-check in the Chowdeck app. Mention uncertainty only when a result itself says so (outcome_uncertain: true, an unknown state or an unconfirmed outcome), and then follow its next_step. Never speculate about units, internals or why Chowdeck answered as it did.",
].join("\n\n");

export type ServerOptions = {
  session?: UserSession;
  enableChatLogin?: boolean;
  placeOrderEnabled?: boolean;
  paymentStartConfig?: PaymentStartConfig;
  paymentChannelQuery?: PaymentChannelQuery;
};

export const createServer = ({
  session,
  enableChatLogin = false,
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
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerRestaurantTools(server, session);
  registerMenuTools(server, session);
  registerAddressTools(server, session);
  registerCartTools(server, session);
  registerCheckoutTools(server, session);
  registerOrderTools(server, session);
  registerOrderPlacementTools(server, {
    session,
    paymentChannelQuery,
    paymentStartConfig,
    placeOrderEnabled,
  });
  registerPaymentTools(server, { session, paymentStartConfig });

  if (enableChatLogin) registerAuthTools(server, session);

  return server;
};
