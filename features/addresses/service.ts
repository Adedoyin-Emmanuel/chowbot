import type { UserSession } from "../../lib/session";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import { isRecord, pickScalarFields, type ScalarValue } from "../../utils/object";
import {
  PLACE_DETAILS_PATH,
  PLACE_AUTOCOMPLETE_PATH,
  MIN_PLACE_QUERY_LENGTH,
  parsePlaceDetails,
  parseAutocomplete,
  type PlaceSuggestion,
} from "./places";
import {
  findPlausibleDuplicates,
  duplicateConfirmationToken,
  type DuplicateMatch,
} from "./duplicates";

export type AddressSummary = Record<string, ScalarValue>;

export type AddressListResult = {
  returned: number;
  addresses: AddressSummary[];
};

export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in to Chowdeck");
    this.name = "NotSignedInError";
  }
}

const ADDRESS_LIST_PATH = "/customer/address";
const ADDRESS_CREATE_PATH = "/customer/address";
const ADDRESS_SET_ACTIVE_PATH = "/customer/address/set-active";

export type PlaceSearchResult = {
  returned: number;
  suggestions: PlaceSuggestion[];
};

// The address exists once address_id is set, whatever activation reports.
// Nothing was created; retry with confirm_duplicate set to this token.
export type AddressDuplicateResult = {
  status: "possible_duplicate";
  created: false;
  place: { pretty_name: string; street: string; city: string; state: string; country: string };
  matches: DuplicateMatch[];
  confirm_duplicate: string;
  guidance: string;
};

export type AddressCreateResult = {
  status: "created";
  address_id: number;
  address: AddressSummary;
  activation:
    | { status: "not_requested" }
    | { status: "activated" }
    | { status: "failed" | "unknown"; detail: string };
  verification:
    | { status: "verified" }
    | { status: "not_listed" | "unavailable"; detail: string };
};

const CREATED_FIELDS = ["pretty_name", "street", "city", "state", "country", "is_active", "is_current"] as const;

// For a write, only a 4xx other than 401 proves nothing happened.
const isDefiniteRejection = (error: unknown): error is ChowdeckApiError =>
  error instanceof ChowdeckApiError &&
  error.kind === "http" &&
  error.status !== undefined &&
  error.status < 500 &&
  error.status !== 401;

const isSuccessEnvelope = (body: unknown): body is Record<string, unknown> =>
  isRecord(body) && body.status === "success";

const SUMMARY_FIELDS = [
  "id",
  "pretty_name",
  "house_no",
  "street",
  "area",
  "city",
  "state",
  "country",
  "is_current",
  "is_active",
  "last_used",
] as const;

const hasAddressId = (address: Record<string, unknown>) =>
  Number.isSafeInteger(address.id) && (address.id as number) > 0;

class AddressService {
  constructor(
    private readonly session: UserSession,
    private readonly client = new ChowdeckClient(),
  ) {}

  private async authHeaders() {
    const token = (await this.session.get())?.token;
    if (!token) throw new NotSignedInError();
    return { authorization: `Bearer ${token}` };
  }

  async searchPlaces(query: string): Promise<PlaceSearchResult> {
    const input = query.trim();
    if (input.length < MIN_PLACE_QUERY_LENGTH) {
      throw new RangeError(`the search text must be at least ${MIN_PLACE_QUERY_LENGTH} characters`);
    }
    const body = await this.client.request(PLACE_AUTOCOMPLETE_PATH, {
      headers: await this.authHeaders(),
      query: { input },
    });
    const suggestions = parseAutocomplete(body);
    return { returned: suggestions.length, suggestions };
  }

  // The create request is sent once and never retried.
  async create(
    placeId: string,
    activate: boolean,
    confirmDuplicate?: string,
  ): Promise<AddressCreateResult | AddressDuplicateResult> {
    const headers = await this.authHeaders();
    let payload;
    try {
      payload = parsePlaceDetails(
        await this.client.request(PLACE_DETAILS_PATH, { headers, query: { placeid: placeId } }),
      );
    } catch (error) {
      if (!(error instanceof ChowdeckApiError)) throw error;
      throw new ChowdeckApiError(error.kind, `${error.message}; no address was created`, error.status);
    }

    // If the saved addresses cannot be read, nothing is created.
    let saved: Record<string, unknown>[];
    try {
      saved = await this.fetchSavedAddresses(headers);
    } catch (error) {
      const detail = error instanceof ChowdeckApiError ? error.message : "unexpected error";
      throw new ChowdeckApiError(
        "invalid_response",
        `could not check your saved addresses for duplicates (${detail}); no address was created`,
      );
    }
    const matches = findPlausibleDuplicates(payload, saved);
    if (matches.length > 0) {
      const token = duplicateConfirmationToken(payload, matches);
      if (confirmDuplicate !== token) {
        return {
          status: "possible_duplicate",
          created: false,
          place: {
            pretty_name: payload.pretty_name,
            street: payload.street,
            city: payload.city,
            state: payload.state,
            country: payload.country,
          },
          matches,
          confirm_duplicate: token,
          guidance:
            confirmDuplicate === undefined
              ? "Nothing was created. Show the user these saved addresses. Only if they confirm they still want a separate address for this place, call add_address again with the same place_id and confirm_duplicate set to this value."
              : "Nothing was created: the confirmation does not match this place and its current matching saved addresses. Show the user these matches again and use this new value only if they confirm.",
        };
      }
    }

    let response: unknown;
    try {
      response = await this.client.request(ADDRESS_CREATE_PATH, { method: "POST", headers, body: payload });
    } catch (error) {
      if (isDefiniteRejection(error)) {
        throw new ChowdeckApiError("http", `${error.message}; no address was created`, error.status);
      }
      throw this.uncertainCreate(error instanceof ChowdeckApiError ? error.message : "unexpected error");
    }

    const data = isSuccessEnvelope(response) && isRecord(response.data) ? response.data : undefined;
    const addressId = data?.id;
    if (!data || !Number.isSafeInteger(addressId) || (addressId as number) <= 0) {
      throw this.uncertainCreate(`POST ${ADDRESS_CREATE_PATH} returned an unexpected response`);
    }
    const id = addressId as number;

    return {
      status: "created",
      address_id: id,
      address: pickScalarFields(data, CREATED_FIELDS),
      activation: activate ? await this.activate(id, headers) : { status: "not_requested" },
      verification: await this.verifyListed(id),
    };
  }

  private uncertainCreate(detail: string) {
    return new ChowdeckApiError(
      "invalid_response",
      `${detail}; the address may or may not have been created. Check list_addresses before trying again`,
    );
  }

  // A failure here never hides the address that was already created.
  private async activate(id: number, headers: Record<string, string>): Promise<AddressCreateResult["activation"]> {
    try {
      const body = await this.client.request(ADDRESS_SET_ACTIVE_PATH, {
        method: "POST",
        headers,
        body: { addressId: id },
      });
      if (isSuccessEnvelope(body)) return { status: "activated" };
      return { status: "unknown", detail: `POST ${ADDRESS_SET_ACTIVE_PATH} returned an unexpected response` };
    } catch (error) {
      const message = error instanceof ChowdeckApiError ? error.message : "unexpected error";
      return isDefiniteRejection(error)
        ? { status: "failed", detail: message }
        : { status: "unknown", detail: `${message}; the address may or may not be active now` };
    }
  }

  private async verifyListed(id: number): Promise<AddressCreateResult["verification"]> {
    try {
      const { addresses } = await this.list();
      return addresses.some((address) => address.id === id)
        ? { status: "verified" }
        : { status: "not_listed", detail: `address ${id} is not in the saved-address list yet` };
    } catch (error) {
      return {
        status: "unavailable",
        detail: `the saved-address list could not be re-read (${error instanceof ChowdeckApiError ? error.message : "unexpected error"})`,
      };
    }
  }

  private async fetchSavedAddresses(headers: Record<string, string>) {
    const body = await this.client.request(ADDRESS_LIST_PATH, { headers });

    const rawAddresses = isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
    const addresses = rawAddresses?.filter(isRecord).filter(hasAddressId);

    if (!rawAddresses || !addresses || (rawAddresses.length > 0 && addresses.length === 0)) {
      throw new ChowdeckApiError(
        "invalid_response",
        `GET ${ADDRESS_LIST_PATH} returned an unexpected response shape`,
      );
    }
    return addresses;
  }

  async list(): Promise<AddressListResult> {
    const addresses = await this.fetchSavedAddresses(await this.authHeaders());
    return {
      returned: addresses.length,
      addresses: addresses.map((address) => pickScalarFields(address, SUMMARY_FIELDS)),
    };
  }
}

export default AddressService;
