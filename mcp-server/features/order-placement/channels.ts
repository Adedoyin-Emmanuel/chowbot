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
 * Besides the online channels: pay_for_me returns a pay_for_me_url for
 * someone else to pay; wallet sends no channel id and pays at creation.
 */
export const ID_LESS_PAYMENT_CHOICES = ["wallet", "pay_for_me"] as const;
export type IdLessPaymentChoice = (typeof ID_LESS_PAYMENT_CHOICES)[number];
export const ORDER_PAYMENT_CHOICES = [...SUPPORTED_PAYMENT_CHANNELS, ...ID_LESS_PAYMENT_CHOICES] as const;
export type OrderPaymentChoice = (typeof ORDER_PAYMENT_CHOICES)[number];

export const isIdLessChoice = (value: unknown): value is IdLessPaymentChoice =>
  (ID_LESS_PAYMENT_CHOICES as readonly unknown[]).includes(value);

/*
 * A channel that does not say it is active is treated as unavailable.
 */
const isActive = (value: unknown) => value === true || value === 1;

/*
 * Resolves a channel name to its payment_method_id, or undefined when absent
 * or inactive. methods is always sent, even empty.
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
