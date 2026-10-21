import { describe, expect, test } from "bun:test";

import {
  MAX_PLACE_SUGGESTIONS,
  parseAutocomplete,
  parsePlaceDetails,
} from "../../../features/addresses/places";

/*
 * Fictional places in the Google Places shapes Chowdeck's proxy returns
 * (address report §9.2).
 */

const prediction = (n: number, overrides: Record<string, unknown> = {}) => ({
  description: `${n} Example Crescent, Sampleville, Lagos, Nigeria`,
  matched_substrings: [{ length: 7, offset: 0 }],
  place_id: `ChIJ_FICTIONAL_${n}`,
  reference: `REF_FICTIONAL_${n}`,
  structured_formatting: { main_text: `${n} Example Crescent`, secondary_text: "Sampleville, Lagos, Nigeria" },
  terms: [{ offset: 0, value: "Example" }],
  types: ["street_address"],
  ...overrides,
});

const component = (long_name: string, types: string[], short_name = long_name.slice(0, 3).toUpperCase()) => ({
  long_name,
  short_name,
  types,
});

const details = (result: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) => ({
  html_attributions: [],
  status: "OK",
  result: {
    place_id: "ChIJ_FICTIONAL_PLACE_ID",
    name: "Example Crescent",
    formatted_address: "12 Example Crescent, Sampleville, Lagos, Nigeria",
    geometry: { location: { lat: 6.4321, lng: 3.4567 } },
    types: ["street_address"],
    vicinity: "Sampleville",
    address_components: [
      component("12", ["street_number"]),
      component("Example Crescent", ["route"]),
      component("Sampleville", ["neighborhood", "political"]),
      component("Sample Sublocality", ["sublocality", "sublocality_level_1", "political"]),
      component("Lagos City", ["locality", "political"]),
      component("Sample LGA", ["administrative_area_level_2", "political"]),
      component("Lagos", ["administrative_area_level_1", "political"], "LA"),
      component("Nigeria", ["country", "political"], "NG"),
    ],
    ...result,
  },
  ...envelope,
});

describe("parseAutocomplete", () => {
  test("returns only place_id, description and display text", () => {
    expect(parseAutocomplete({ status: "OK", predictions: [prediction(1)] })).toEqual([
      {
        place_id: "ChIJ_FICTIONAL_1",
        description: "1 Example Crescent, Sampleville, Lagos, Nigeria",
        main_text: "1 Example Crescent",
        secondary_text: "Sampleville, Lagos, Nigeria",
      },
    ]);
  });

  test(`returns at most ${MAX_PLACE_SUGGESTIONS} suggestions`, () => {
    const predictions = Array.from({ length: 15 }, (_, i) => prediction(i));

    expect(parseAutocomplete({ status: "OK", predictions })).toHaveLength(MAX_PLACE_SUGGESTIONS);
  });

  test.each([
    ["ZERO_RESULTS", { status: "ZERO_RESULTS", predictions: [] }],
    ["OK with no predictions", { status: "OK", predictions: [] }],
  ])("returns no suggestions for %s", (_, body) => {
    expect(parseAutocomplete(body)).toEqual([]);
  });

  test("skips malformed predictions among valid ones", () => {
    const suggestions = parseAutocomplete({
      status: "OK",
      predictions: ["junk", { description: "No id" }, { place_id: "ChIJ_X", description: "" }, prediction(2, { structured_formatting: null })],
    });

    expect(suggestions).toEqual([{ place_id: "ChIJ_FICTIONAL_2", description: "2 Example Crescent, Sampleville, Lagos, Nigeria" }]);
  });

  test.each([
    ["REQUEST_DENIED", { status: "REQUEST_DENIED", predictions: [] }, "status REQUEST_DENIED"],
    ["OVER_QUERY_LIMIT", { status: "OVER_QUERY_LIMIT" }, "status OVER_QUERY_LIMIT"],
    ["an unrecognised status, which is not echoed", { status: "<script>", predictions: [] }, "no status"],
    ["a missing status", { predictions: [] }, "no status"],
    ["predictions that are not a list", { status: "OK", predictions: {} }, "an unexpected response shape"],
    ["only malformed predictions", { status: "OK", predictions: [{ description: "No id" }] }, "an unexpected response shape"],
    ["a non-object body", [], "an unexpected response shape"],
  ])("refuses %s", (_, body, detail) => {
    expect(() => parseAutocomplete(body)).toThrow(`GET /place/autocomplete/json returned ${detail}`);
  });
});

describe("parsePlaceDetails", () => {
  test("builds the ten observed creation fields from the place", () => {
    const payload = parsePlaceDetails(details());

    expect(payload).toEqual({
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
    });
    expect(Object.keys(payload)).toHaveLength(10);
  });

  /*
   * The website's chain: neighborhood, sublocality, sublocality_level_1,
   * locality, administrative_area_level_2, then "nil".
   */
  test.each([
    ["neighborhood", ["neighborhood", "sublocality", "sublocality_level_1", "locality", "administrative_area_level_2"], "Neighbourhood X"],
    ["sublocality", ["sublocality", "sublocality_level_1", "locality", "administrative_area_level_2"], "Sublocality X"],
    ["sublocality_level_1", ["sublocality_level_1", "locality", "administrative_area_level_2"], "Sublocality Level 1 X"],
    ["locality", ["locality", "administrative_area_level_2"], "Locality X"],
    ["administrative_area_level_2", ["administrative_area_level_2"], "Admin Area 2 X"],
    ["nil when none is present", [], "nil"],
  ])("city and area come from %s", (_, present, expected) => {
    const names: Record<string, string> = {
      neighborhood: "Neighbourhood X",
      sublocality: "Sublocality X",
      sublocality_level_1: "Sublocality Level 1 X",
      locality: "Locality X",
      administrative_area_level_2: "Admin Area 2 X",
    };
    const components = present.map((type) => component(names[type]!, [type, "political"]));

    const payload = parsePlaceDetails(details({ address_components: components }));

    expect(payload.city).toBe(expected);
    expect(payload.area).toBe(expected);
  });

  test("reads long_name, never short_name, and lets the last component of a type win, as the website does", () => {
    const payload = parsePlaceDetails(
      details({
        address_components: [
          "junk",
          { long_name: "No types" },
          component("12", ["street_number"], "SHORT-12"),
          component("First Locality", ["locality"], "FL"),
          component("Second Locality", ["locality"], "SL"),
          component("Lagos", ["administrative_area_level_1"], "LA"),
          component("Nigeria", ["country"], "NG"),
        ],
      }),
    );

    expect(payload).toMatchObject({ house_no: "12", city: "Second Locality", area: "Second Locality", state: "Lagos", country: "Nigeria" });
    expect(JSON.stringify(payload)).not.toMatch(/SHORT-12|"LA"|"NG"|"SL"|"FL"/);
  });

  test("a later component with an empty long_name empties that type, so the chain falls through", () => {
    const payload = parsePlaceDetails(
      details({
        address_components: [
          component("Sampleville", ["neighborhood"]),
          { long_name: "", short_name: "", types: ["neighborhood"] },
          component("Lagos City", ["locality"]),
          component("12", ["street_number"]),
          { long_name: "", types: ["street_number"] },
        ],
      }),
    );

    expect(payload).toMatchObject({ city: "Lagos City", area: "Lagos City", house_no: "" });
  });

  test("falls back to the formatted address for the street, as the website does", () => {
    expect(parsePlaceDetails(details({ name: undefined })).street).toBe("12 Example Crescent, Sampleville, Lagos, Nigeria");
    expect(parsePlaceDetails(details({ name: "" })).street).toBe("12 Example Crescent, Sampleville, Lagos, Nigeria");
  });

  test.each([
    ["missing", { geometry: undefined }],
    ["without a location", { geometry: {} }],
    ["with a missing longitude", { geometry: { location: { lat: 6.4 } } }],
    ["as strings", { geometry: { location: { lat: "6.4", lng: "3.4" } } }],
    ["null", { geometry: { location: { lat: null, lng: null } } }],
    ["out of range", { geometry: { location: { lat: 96, lng: 3.4 } } }],
    ["out of range longitude", { geometry: { location: { lat: 6.4, lng: -181 } } }],
    ["at 0,0 (the website's fallback)", { geometry: { location: { lat: 0, lng: 0 } } }],
  ])("refuses coordinates %s rather than inventing them", (_, result) => {
    expect(() => parsePlaceDetails(details(result))).toThrow("returned a place without valid coordinates");
  });

  test("accepts a real coordinate of 0 on one axis", () => {
    expect(parsePlaceDetails(details({ geometry: { location: { lat: 0, lng: 3.4 } } }))).toMatchObject({ latitude: 0, longitude: 3.4 });
  });

  test.each([
    ["a non-OK status", details({}, { status: "NOT_FOUND" }), "status NOT_FOUND"],
    ["no result", { status: "OK" }, "an unexpected response shape"],
    ["no address components", details({ address_components: undefined }), "an unexpected response shape"],
    ["no place_id", details({ place_id: undefined }), "a place without a place_id"],
    ["no formatted address", details({ formatted_address: "  " }), "a place without a formatted address"],
    ["a non-object body", "OK", "an unexpected response shape"],
  ])("refuses %s", (_, body, detail) => {
    expect(() => parsePlaceDetails(body)).toThrow(`GET /place/details/json returned ${detail}`);
  });
});
