import { isRecord } from "../../utils/object";
import { ChowdeckApiError, type ChowdeckClient } from "../../lib/client";

export const PAYMENT_CHANNEL_PATH = "/customer/payment/channel";

/*
 * The query values the website sends with the channel list. Only their
 * names (methods, country_identifier) have been observed; the values have
 * not, so there are deliberately no defaults. Until they are captured, no
 * server configuration supplies them and place_order is not registered.
 */
export type PaymentChannelQuery = {
  methods: string;
  countryIdentifier: string;
};

export type PaymentChannel = { id: number; name: string };

/*
 * Channels whose order path has been observed end to end (the OPay order
 * carried payment_method_id and no payment_method).
 */
export const SUPPORTED_PAYMENT_CHANNELS = ["opay"] as const;
export type SupportedPaymentChannel = (typeof SUPPORTED_PAYMENT_CHANNELS)[number];

const isActive = (value: unknown) => value === undefined || value === true || value === 1;

/*
 * Resolves a channel name to the id the order sends as payment_method_id,
 * from the observed response: data[] of { id, name, processor, is_active }.
 * Returns undefined when the channel is absent or inactive.
 */
export const resolvePaymentChannel = async (
  client: ChowdeckClient,
  headers: Record<string, string>,
  query: PaymentChannelQuery,
  name: SupportedPaymentChannel,
): Promise<PaymentChannel | undefined> => {
  const body = await client.request(PAYMENT_CHANNEL_PATH, {
    headers,
    query: { methods: query.methods, country_identifier: query.countryIdentifier },
  });

  const channels = isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
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
