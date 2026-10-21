import { describe, expect, test } from "bun:test";

import {
  distanceMetres,
  savedCoordinate,
  DUPLICATE_TOKEN_PATTERN,
  findPlausibleDuplicates,
  duplicateConfirmationToken,
} from "../../../features/addresses/duplicates";
import type { AddressCreatePayload } from "../../../features/addresses/places";

const PLACE: AddressCreatePayload = {
  place_id: "ChIJ_FICTIONAL_PLACE_ID",
  house_no: "12",
  street: "Example Crescent",
  pretty_name: "12 Example Crescent, Sampleville, Lagos, Nigeria",
  longitude: 3.4567,
  latitude: 6.4321,
  city: "Sampleville",
  state: "Lagos",
  country: "Nigeria",
  area: "Sampleville",
};

const reasonsFor = (saved: Record<string, unknown>) => findPlausibleDuplicates(PLACE, [{ id: 42, ...saved }])[0]?.reasons;

describe("findPlausibleDuplicates", () => {
  test("matches the same formatted address, ignoring case, punctuation and spacing", () => {
    expect(reasonsFor({ pretty_name: "  12 example crescent  sampleville; LAGOS - Nigeria " })).toEqual(["same formatted address"]);
  });

  test("matches a saved street equal to this place's description (the website's quick-picker rule)", () => {
    expect(reasonsFor({ street: "12 Example Crescent, Sampleville, Lagos, Nigeria" })).toEqual([
      "its street is this place's full description, which the Chowdeck website treats as the same address",
    ]);
  });

  test("matches the same street in the same city", () => {
    expect(reasonsFor({ street: "Example Crescent", city: "SAMPLEVILLE" })).toEqual(["same street and city"]);
  });

  test("does not treat the same street alone as a duplicate", () => {
    expect(reasonsFor({ street: "Example Crescent", city: "Otherville" })).toBeUndefined();
    expect(reasonsFor({ street: "Example Crescent" })).toBeUndefined();
  });

  test("does not match on a street when this place's city is unknown (nil)", () => {
    expect(findPlausibleDuplicates({ ...PLACE, city: "nil", area: "nil" }, [{ id: 42, street: "Example Crescent", city: "nil" }])).toEqual([]);
  });

  test.each([
    ["{x: lng, y: lat} (the storefront's shape)", { x: 3.4568, y: 6.4323 }],
    ["{latitude, longitude}", { latitude: 6.4323, longitude: 3.4568 }],
    ["{lat, lng}", { lat: 6.4323, lng: 3.4568 }],
    ["GeoJSON [lng, lat]", { type: "Point", coordinates: [3.4568, 6.4323] }],
  ])("matches coordinates within 50 m given as %s", (_, coordinate) => {
    const reasons = reasonsFor({ street: "Different Road", coordinate });

    expect(reasons).toHaveLength(1);
    expect(reasons![0]).toMatch(/^about \d+ m from this place$/);
  });

  test("ignores coordinates further away, and coordinate shapes it cannot read", () => {
    expect(reasonsFor({ coordinate: { latitude: 6.4341, longitude: 3.4567 } })).toBeUndefined();
    expect(reasonsFor({ coordinate: { x: 6.4321, y: 3.4567 } })).toBeUndefined(); // x and y swapped: about 500 km away
    expect(reasonsFor({ coordinate: "6.4321,3.4567" })).toBeUndefined();
  });

  test("returns every reason and only safe fields, and skips entries without a usable id", () => {
    const matches = findPlausibleDuplicates(PLACE, [
      { id: "7", pretty_name: PLACE.pretty_name },
      { id: 0, pretty_name: PLACE.pretty_name },
      {
        id: 42,
        pretty_name: PLACE.pretty_name,
        street: "Example Crescent",
        city: "Sampleville",
        state: "Lagos",
        coordinate: { latitude: 6.4321, longitude: 3.4567 },
        tag: "home",
        extra_information: { building_type: "house" },
      },
    ]);

    expect(matches).toEqual([
      {
        address_id: 42,
        pretty_name: PLACE.pretty_name,
        street: "Example Crescent",
        city: "Sampleville",
        state: "Lagos",
        reasons: ["same formatted address", "same street and city", "about 0 m from this place"],
      },
    ]);
  });
});

describe("savedCoordinate and distanceMetres", () => {
  test("reads only valid numeric coordinates", () => {
    expect(savedCoordinate({ latitude: "6.4", longitude: 3.4 })).toBeUndefined();
    expect(savedCoordinate({ latitude: 96, longitude: 3.4 })).toBeUndefined();
    expect(savedCoordinate(null)).toBeUndefined();
  });

  test("measures about 111 km per degree of latitude", () => {
    expect(Math.round(distanceMetres({ latitude: 6, longitude: 3 }, { latitude: 7, longitude: 3 }) / 1000)).toBe(111);
  });
});

describe("duplicateConfirmationToken", () => {
  const matches = (...ids: number[]) => ids.map((address_id) => ({ address_id, reasons: ["same formatted address"] }));

  test("is stable for the same place and matches, whatever their order", () => {
    const token = duplicateConfirmationToken(PLACE, matches(42, 7));

    expect(token).toMatch(DUPLICATE_TOKEN_PATTERN);
    expect(duplicateConfirmationToken(PLACE, matches(7, 42))).toBe(token);
  });

  test.each([
    ["another place_id", { ...PLACE, place_id: "ChIJ_OTHER" }, matches(42)],
    ["another formatted address", { ...PLACE, pretty_name: "14 Example Crescent" }, matches(42)],
    ["moved coordinates", { ...PLACE, latitude: 6.5 }, matches(42)],
    ["a different set of matches", PLACE, matches(42, 43)],
    ["another account's address ids", PLACE, matches(9001)],
  ])("changes for %s", (_, place, found) => {
    expect(duplicateConfirmationToken(place, found)).not.toBe(duplicateConfirmationToken(PLACE, matches(42)));
  });
});
