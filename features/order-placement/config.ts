import type { PaymentChannelQuery } from "./channels";

/*
 * Production configuration for place_order, read only from the environment
 * and with no defaults:
 *
 *   CHOWBOT_PLACE_ORDER_ENABLED                 must be exactly "true"
 *   CHOWBOT_PAYMENT_CHANNEL_METHODS             the captured `methods` value
 *   CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER  the captured `country_identifier` value
 *
 * place_order is registered only when the flag is on and both channel values
 * are set. Channel values alone never enable it.
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
  const paymentChannelQuery = methods && countryIdentifier ? { methods, countryIdentifier } : undefined;

  const warnings: string[] = [];
  if (flag && flag !== "true" && flag !== "false") {
    warnings.push(`CHOWBOT_PLACE_ORDER_ENABLED must be "true" or "false"; place_order stays disabled.`);
  }
  if (placeOrderEnabled && !paymentChannelQuery) {
    warnings.push(
      "CHOWBOT_PLACE_ORDER_ENABLED is true but the payment-channel query values are not both set; place_order stays disabled.",
    );
  }
  return { placeOrderEnabled, ...(paymentChannelQuery && { paymentChannelQuery }), warnings };
};
