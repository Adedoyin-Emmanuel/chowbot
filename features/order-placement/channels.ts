import { isRecord } from "../../utils/object";
import { ChowdeckApiError, type ChowdeckClient } from "../../lib/client";

export const PAYMENT_CHANNEL_PATH = "/customer/payment/channel";

/*
 * The query values the website sends with the channel list.
 */
export type PaymentChannelQuery = {
  methods: string;
  countryIdentifier: string;
};

export const CAPTURED_PAYMENT_CHANNEL_QUERY: Readonly<PaymentChannelQuery> =
  Object.freeze({
    methods: "",
    countryIdentifier: "NG",
  });

export type PaymentChannel = { id: number; name: string };

export const SUPPORTED_PAYMENT_CHANNELS = [
  "card",
  "bank_transfer",
  "opay",
  "bank",
  "ussd",
  "pocket",
  "zap",
] as const;
export type SupportedPaymentChannel =
  (typeof SUPPORTED_PAYMENT_CHANNELS)[number];

/*
 * Every observed channel carried is_active: 1. A channel that does not say
 * it is active is treated as unavailable.
 */
const isActive = (value: unknown) => value === true || value === 1;

/*
 * Resolves a channel name to the id the order sends as payment_method_id,
 * from the observed response: data[] of { id, name, processor, is_active }.
 * Returns undefined when the channel is absent or not active. methods is
 * always sent, even empty, as the website sends it.
 */
export const resolvePaymentChannel = async (
  client: ChowdeckClient,
  headers: Record<string, string>,
  query: PaymentChannelQuery,
  name: SupportedPaymentChannel,
): Promise<PaymentChannel | undefined> => {
  const body = await client.request(PAYMENT_CHANNEL_PATH, {
    headers,
    query: {
      methods: query.methods,
      country_identifier: query.countryIdentifier,
    },
  });

  const channels =
    isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
  const wellFormed = channels?.every(
    (channel) =>
      isRecord(channel) &&
      Number.isSafeInteger(channel.id) &&
      (channel.id as number) > 0 &&
      typeof channel.name === "string",
  );
  if (!channels || !wellFormed) {
    throw new ChowdeckApiError(
      "invalid_response",
      `GET ${PAYMENT_CHANNEL_PATH} returned an unexpected response shape`,
    );
  }

  const match = (channels as Record<string, unknown>[]).find(
    (channel) => channel.name === name && isActive(channel.is_active),
  );
  return match ? { id: match.id as number, name } : undefined;
};
