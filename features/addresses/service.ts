import type { UserSession } from "../../lib/session";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import { isRecord, pickScalarFields, type ScalarValue } from "../../utils/object";

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

/*
 * Only fields that help choose a delivery location. Coordinates and place
 * IDs are left out; an address's id is what search_restaurants needs.
 */
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

  async list(): Promise<AddressListResult> {
    const token = (await this.session.get())?.token;
    if (!token) throw new NotSignedInError();

    const body = await this.client.request(ADDRESS_LIST_PATH, {
      headers: { authorization: `Bearer ${token}` },
    });

    const rawAddresses = isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
    const addresses = rawAddresses?.filter(isRecord).filter(hasAddressId);

    if (!rawAddresses || !addresses || (rawAddresses.length > 0 && addresses.length === 0)) {
      throw new ChowdeckApiError(
        "invalid_response",
        `GET ${ADDRESS_LIST_PATH} returned an unexpected response shape`,
      );
    }

    return {
      returned: addresses.length,
      addresses: addresses.map((address) => pickScalarFields(address, SUMMARY_FIELDS)),
    };
  }
}

export default AddressService;
