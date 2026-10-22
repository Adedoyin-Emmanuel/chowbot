import { createHash } from "node:crypto";

import type { AddressCreatePayload } from "./places";

/*
 * A saved address is a plausible duplicate when it has the same formatted
 * address, the same street and city, a street equal to this place's
 * description, or coordinates within DUPLICATE_DISTANCE_METRES.
 */

export const DUPLICATE_DISTANCE_METRES = 50;

export type DuplicateMatch = {
  address_id: number;
  pretty_name?: string;
  street?: string;
  city?: string;
  state?: string;
  reasons: string[];
};

const normalize = (value: unknown) =>
  typeof value === "string"
    ? value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    : "";

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);

const isLatitude = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 90;
const isLongitude = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 180;

/*
 * Chowdeck stores `coordinate` as {x: longitude, y: latitude}; other common
 * shapes are accepted too.
 */
export const savedCoordinate = (coordinate: unknown): { latitude: number; longitude: number } | undefined => {
  if (typeof coordinate !== "object" || coordinate === null) return undefined;
  const c = coordinate as Record<string, unknown>;
  if (isLatitude(c.y) && isLongitude(c.x)) return { latitude: c.y, longitude: c.x };
  if (isLatitude(c.latitude) && isLongitude(c.longitude)) return { latitude: c.latitude, longitude: c.longitude };
  if (isLatitude(c.lat) && isLongitude(c.lng)) return { latitude: c.lat, longitude: c.lng };
  if (Array.isArray(c.coordinates) && isLongitude(c.coordinates[0]) && isLatitude(c.coordinates[1])) {
    return { latitude: c.coordinates[1], longitude: c.coordinates[0] };
  }
  return undefined;
};

export const distanceMetres = (
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) => {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
};

export const findPlausibleDuplicates = (
  place: AddressCreatePayload,
  saved: Record<string, unknown>[],
): DuplicateMatch[] => {
  const placeName = normalize(place.pretty_name);
  const placeStreet = normalize(place.street);
  const placeCity = normalize(place.city);
  const matches: DuplicateMatch[] = [];

  for (const address of saved) {
    if (!Number.isSafeInteger(address.id) || (address.id as number) <= 0) continue;
    const reasons: string[] = [];
    const street = normalize(address.street);

    if (placeName && normalize(address.pretty_name) === placeName) reasons.push("same formatted address");
    if (placeName && street === placeName) {
      reasons.push("its street is this place's full description, which the Chowdeck website treats as the same address");
    }
    if (placeStreet && street === placeStreet && placeCity !== "nil" && placeCity && normalize(address.city) === placeCity) {
      reasons.push("same street and city");
    }
    const coordinate = savedCoordinate(address.coordinate);
    if (coordinate) {
      const metres = distanceMetres(coordinate, place);
      if (metres <= DUPLICATE_DISTANCE_METRES) reasons.push(`about ${Math.round(metres)} m from this place`);
    }

    if (reasons.length > 0) {
      matches.push({
        address_id: address.id as number,
        ...(text(address.pretty_name) && { pretty_name: text(address.pretty_name) }),
        ...(text(address.street) && { street: text(address.street) }),
        ...(text(address.city) && { city: text(address.city) }),
        ...(text(address.state) && { state: text(address.state) }),
        reasons,
      });
    }
  }
  return matches;
};

/*
 * A digest of the place and the matching address ids, so the confirmation
 * cannot authorize a different place or a changed set of matches.
 */
export const duplicateConfirmationToken = (place: AddressCreatePayload, matches: DuplicateMatch[]) => {
  const ids = matches.map((match) => match.address_id).sort((a, b) => a - b);
  const digest = createHash("sha256")
    .update(JSON.stringify([1, place.place_id, place.pretty_name, place.latitude, place.longitude, ids]))
    .digest("base64url");
  return `dup_${digest.slice(0, 22)}`;
};

export const DUPLICATE_TOKEN_PATTERN = /^dup_[A-Za-z0-9_-]{22}$/;
