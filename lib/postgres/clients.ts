import { eq } from "drizzle-orm";

import { oauthClients } from "./schema";
import type { Database } from "./database";
import type { ClientStore, RegisteredClient } from "../oauth-clients";

const toClient = (row: typeof oauthClients.$inferSelect): RegisteredClient => ({
  client_id: row.clientId,
  ...(row.clientName !== null && { client_name: row.clientName }),
  redirect_uris: row.redirectUris,
  grant_types: row.grantTypes,
  response_types: row.responseTypes,
  token_endpoint_auth_method: row.tokenEndpointAuthMethod,
  client_id_issued_at: row.clientIdIssuedAt,
});

export class PostgresClientStore implements ClientStore {
  constructor(private readonly db: Database) {}

  async get(clientId: string) {
    const [row] = await this.db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
    return row ? toClient(row) : undefined;
  }

  async save(client: RegisteredClient) {
    const fields = {
      clientName: client.client_name ?? null,
      redirectUris: client.redirect_uris,
      grantTypes: client.grant_types,
      responseTypes: client.response_types,
      tokenEndpointAuthMethod: client.token_endpoint_auth_method,
    };
    await this.db
      .insert(oauthClients)
      .values({ clientId: client.client_id, clientIdIssuedAt: client.client_id_issued_at, ...fields })
      .onConflictDoUpdate({ target: oauthClients.clientId, set: fields });
  }
}
