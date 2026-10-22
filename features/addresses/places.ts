import { isRecord } from "../../utils/object";
import { ChowdeckApiError } from "../../lib/client";

// Parsing for Chowdeck's Google Places proxy, which uses Google's envelopes.

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

// The fields the website sends to POST /customer/address.
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

const statusOf = (body: Record<string, unknown>) =>
  typeof body.status === "string" && /^[A-Z_]{1,40}$/.test(body.status) ? body.status : undefined;

const unexpected = (path: string, detail = "an unexpected response shape") =>
  new ChowdeckApiError("invalid_response", `GET ${path} returned ${detail}`);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

// ZERO_RESULTS yields no predictions; any other non-OK status is an error.
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
 * As the website does, the last component of a type wins, even when its
 * long_name is empty. Malformed components are skipped.
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
 * Unlike the website, coordinates are never defaulted to 0,0: missing or
 * invalid coordinates are refused.
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
