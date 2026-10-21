import { isRecord } from "../../utils/object";
import { ChowdeckApiError } from "../../lib/client";

/*
 * Parsing for Chowdeck's Google Places proxy and the website's place-to-
 * address transform (address report §3.1, wire shapes §9.2). Responses use
 * the Google Places envelope: autocomplete {predictions, status}, details
 * {html_attributions, result, status}.
 */

export const PLACE_AUTOCOMPLETE_PATH = "/place/autocomplete/json";
export const PLACE_DETAILS_PATH = "/place/details/json";

export const MIN_PLACE_QUERY_LENGTH = 3;
export const MAX_PLACE_SUGGESTIONS = 10;

export type PlaceSuggestion = {
  place_id: string;
  description: string;
  main_text?: string;
  secondary_text?: string;
};

/*
 * The ten fields the website's quick picker sends to POST /customer/address,
 * observed on the wire with exactly these types.
 */
export type AddressCreatePayload = {
  place_id: string;
  house_no: string;
  street: string;
  pretty_name: string;
  longitude: number;
  latitude: number;
  city: string;
  state: string;
  country: string;
  area: string;
};

/*
 * Google status values are short upper-case codes; anything else is not
 * echoed back.
 */
const statusOf = (body: Record<string, unknown>) =>
  typeof body.status === "string" && /^[A-Z_]{1,40}$/.test(body.status) ? body.status : undefined;

const unexpected = (path: string, detail = "an unexpected response shape") =>
  new ChowdeckApiError("invalid_response", `GET ${path} returned ${detail}`);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/*
 * OK yields the predictions; ZERO_RESULTS (Google's no-match status) yields
 * none; every other status is reported, as the website would show nothing.
 * Predictions without a usable place_id and description are dropped.
 */
export const parseAutocomplete = (body: unknown): PlaceSuggestion[] => {
  if (!isRecord(body)) throw unexpected(PLACE_AUTOCOMPLETE_PATH);
  const status = statusOf(body);
  if (status === "ZERO_RESULTS") return [];
  if (status !== "OK") {
    throw unexpected(PLACE_AUTOCOMPLETE_PATH, status ? `status ${status}` : "no status");
  }
  if (!Array.isArray(body.predictions)) throw unexpected(PLACE_AUTOCOMPLETE_PATH);

  const suggestions: PlaceSuggestion[] = [];
  for (const prediction of body.predictions) {
    if (!isRecord(prediction) || !nonEmptyString(prediction.place_id) || !nonEmptyString(prediction.description)) continue;
    const formatting = isRecord(prediction.structured_formatting) ? prediction.structured_formatting : {};
    suggestions.push({
      place_id: prediction.place_id,
      description: prediction.description,
      ...(nonEmptyString(formatting.main_text) && { main_text: formatting.main_text }),
      ...(nonEmptyString(formatting.secondary_text) && { secondary_text: formatting.secondary_text }),
    });
    if (suggestions.length === MAX_PLACE_SUGGESTIONS) break;
  }
  if (body.predictions.length > 0 && suggestions.length === 0) throw unexpected(PLACE_AUTOCOMPLETE_PATH);
  return suggestions;
};

/*
 * The website's lookup (storefront chunk 6117, re-read 2026-10-21): it walks
 * every component and sets map[type] = component.long_name, so the LAST
 * component of a type wins, and a later component with an empty long_name
 * leaves that type empty (and the `||` chains fall through). Two deliberate
 * differences: malformed components are skipped rather than throwing, and a
 * whitespace-only name counts as empty.
 */
const componentLookup = (components: unknown[]) => {
  const byType = new Map<string, unknown>();
  for (const component of components) {
    if (!isRecord(component) || !Array.isArray(component.types)) continue;
    for (const type of component.types) {
      if (typeof type === "string") byType.set(type, component.long_name);
    }
  }
  return (type: string) => {
    const value = byType.get(type);
    return nonEmptyString(value) ? value : undefined;
  };
};

const isCoordinate = (value: unknown, limit: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;

/*
 * The website's transform (address report §3.1), except that coordinates are
 * never defaulted: the website's `lng || 0` fallback would save an address at
 * 0,0, so missing, non-numeric, out-of-range or 0,0 coordinates are refused,
 * as are a missing place_id or formatted_address. Nothing here comes from the
 * caller; everything is read from Chowdeck's place details.
 */
export const parsePlaceDetails = (body: unknown): AddressCreatePayload => {
  if (!isRecord(body)) throw unexpected(PLACE_DETAILS_PATH);
  const status = statusOf(body);
  if (status !== "OK") throw unexpected(PLACE_DETAILS_PATH, status ? `status ${status}` : "no status");
  const result = isRecord(body.result) ? body.result : undefined;
  if (!result || !Array.isArray(result.address_components)) throw unexpected(PLACE_DETAILS_PATH);

  if (!nonEmptyString(result.place_id)) throw unexpected(PLACE_DETAILS_PATH, "a place without a place_id");
  if (!nonEmptyString(result.formatted_address)) {
    throw unexpected(PLACE_DETAILS_PATH, "a place without a formatted address");
  }
  const location =
    isRecord(result.geometry) && isRecord(result.geometry.location) ? result.geometry.location : undefined;
  const latitude = location?.lat;
  const longitude = location?.lng;
  if (!isCoordinate(latitude, 90) || !isCoordinate(longitude, 180) || (latitude === 0 && longitude === 0)) {
    throw unexpected(PLACE_DETAILS_PATH, "a place without valid coordinates");
  }

  const component = componentLookup(result.address_components);
  const area =
    component("neighborhood") ??
    component("sublocality") ??
    component("sublocality_level_1") ??
    component("locality") ??
    component("administrative_area_level_2") ??
    "nil";

  return {
    place_id: result.place_id,
    house_no: component("street_number") ?? "",
    street: nonEmptyString(result.name) ? result.name : result.formatted_address,
    pretty_name: result.formatted_address,
    longitude,
    latitude,
    city: area,
    state: component("administrative_area_level_1") ?? "",
    country: component("country") ?? "",
    area,
  };
};
