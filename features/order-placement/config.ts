import { CAPTURED_PAYMENT_CHANNEL_QUERY, type PaymentChannelQuery } from "./channels";

/*
 * Production configuration for live ordering (place_order and
 * start_payment), read from the environment:
 *
 *   CHOWBOT_PLACE_ORDER_ENABLED                 unset or "true": on; "false": off
 *   CHOWBOT_PAYMENT_CHANNEL_METHODS             optional; if set, must be the captured value: empty
 *   CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER  optional; if set, must be the captured value: NG
 *
 * Live ordering is on by default in the hosted server. The flag is a kill
 * switch: "false" turns off both tools without a code change. Any other
 * value is treated as a typo and also turns them off, with a warning.
 *
 * The channel query defaults to the one captured from the website
 * (methods="", country_identifier=NG). If either variable is set, both must
 * be set to exactly those values; anything else turns live ordering off
 * rather than sending an unobserved query. A variable set to an empty
 * string is present; an unset one is not.
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
