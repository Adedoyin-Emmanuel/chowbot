import { CAPTURED_PAYMENT_CHANNEL_QUERY, type PaymentChannelQuery } from "./channels";

/*
 * Production configuration for place_order, read only from the environment
 * and with no defaults:
 *
 *   CHOWBOT_PLACE_ORDER_ENABLED                 must be exactly "true"
 *   CHOWBOT_PAYMENT_CHANNEL_METHODS             must be set, to the captured value: empty
 *   CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER  must be set, to the captured value: NG
 *
 * A variable set to an empty string is present; an unset one is not. Values
 * that differ from the captured website request are refused rather than
 * sent. place_order is registered only when the flag is on and both channel
 * values are present and match. Channel values alone never enable it.
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
  const placeOrderEnabled = flag === "true";
  const present = methods !== undefined && countryIdentifier !== undefined;
  const matchesCapture =
    methods === CAPTURED_PAYMENT_CHANNEL_QUERY.methods &&
    countryIdentifier === CAPTURED_PAYMENT_CHANNEL_QUERY.countryIdentifier;
  const paymentChannelQuery = present && matchesCapture ? { methods, countryIdentifier } : undefined;

  const warnings: string[] = [];
  if (present && !matchesCapture) {
    warnings.push(
      `The payment-channel query values differ from the captured website request (methods="", country_identifier=NG); place_order stays disabled.`,
    );
  }
  if (flag && flag !== "true" && flag !== "false") {
    warnings.push(`CHOWBOT_PLACE_ORDER_ENABLED must be "true" or "false"; place_order stays disabled.`);
  }
  if (placeOrderEnabled && !paymentChannelQuery) {
    warnings.push(
      "CHOWBOT_PLACE_ORDER_ENABLED is true but the payment-channel query values are not both set to the captured values; place_order stays disabled.",
    );
  }
  return { placeOrderEnabled, ...(paymentChannelQuery && { paymentChannelQuery }), warnings };
};
