import { CAPTURED_PAYMENT_CHANNEL_QUERY, type PaymentChannelQuery } from "./channels";

/*
 *   CHOWBOT_PLACE_ORDER_ENABLED                 unset or "true": on; anything else: off
 *   CHOWBOT_PAYMENT_CHANNEL_METHODS             optional; if set, must be empty
 *   CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER  optional; if set, must be NG
 *
 * If either channel variable is set, both must match exactly, or live
 * ordering turns off.
 */
export type OrderPlacementConfig = {
  placeOrderEnabled: boolean;
  paymentChannelQuery?: PaymentChannelQuery;
  warnings: string[];
};

export const readOrderPlacementConfig = (
  env: Record<string, string | undefined>,
): OrderPlacementConfig => {
  const flag = env.CHOWBOT_PLACE_ORDER_ENABLED?.trim();
  const methods = env.CHOWBOT_PAYMENT_CHANNEL_METHODS?.trim();
  const countryIdentifier = env.CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER?.trim();
  const warnings: string[] = [];

  let switchOn = flag === undefined || flag === "" || flag === "true";
  if (flag && flag !== "true" && flag !== "false") {
    warnings.push(`CHOWBOT_PLACE_ORDER_ENABLED must be "true" or "false" (or unset); live ordering is off.`);
    switchOn = false;
  }

  const anySet = methods !== undefined || countryIdentifier !== undefined;
  const matchesCapture =
    methods === CAPTURED_PAYMENT_CHANNEL_QUERY.methods &&
    countryIdentifier === CAPTURED_PAYMENT_CHANNEL_QUERY.countryIdentifier;
  const paymentChannelQuery: PaymentChannelQuery | undefined = !anySet
    ? { ...CAPTURED_PAYMENT_CHANNEL_QUERY }
    : matchesCapture
      ? { methods: methods!, countryIdentifier: countryIdentifier! }
      : undefined;
  if (!paymentChannelQuery) {
    warnings.push(
      `The payment-channel query values differ from the captured website request (methods="", country_identifier=NG), or only one is set; live ordering is off.`,
    );
  }

  const placeOrderEnabled = switchOn && paymentChannelQuery !== undefined;
  return { placeOrderEnabled, ...(paymentChannelQuery && { paymentChannelQuery }), warnings };
};
