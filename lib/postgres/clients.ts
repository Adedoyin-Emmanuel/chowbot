import type { SQL } from "bun";

import type { ClientStore, RegisteredClient } from "../oauth-clients";

type ClientRow = {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  client_id_issued_at: string;
};

const toClient = (row: ClientRow): RegisteredClient => ({
  client_id: row.client_id,
  ...(row.client_name !== null && { client_name: row.client_name }),
  redirect_uris: row.redirect_uris,
  grant_types: row.grant_types,
  response_types: row.response_types,
  token_endpoint_auth_method: row.token_endpoint_auth_method,
  client_id_issued_at: Number(row.client_id_issued_at),
});

export class PostgresClientStore implements ClientStore {
  constructor(private readonly sql: SQL) {}

  async get(clientId: string) {
    const [row] = await this.sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId}`;
    return row ? toClient(row as ClientRow) : undefined;
  }

  async save(client: RegisteredClient) {
    await this.sql`
      INSERT INTO oauth_clients (
        client_id, client_name, redirect_uris, grant_types, response_types,
        token_endpoint_auth_method, client_id_issued_at
      ) VALUES (
        ${client.client_id}, ${client.client_name ?? null}, ${client.redirect_uris}::jsonb,
        ${client.grant_types}::jsonb, ${client.response_types}::jsonb,
        ${client.token_endpoint_auth_method}, ${client.client_id_issued_at}
      )
      ON CONFLICT (client_id) DO UPDATE SET
        client_name = EXCLUDED.client_name,
        redirect_uris = EXCLUDED.redirect_uris,
        grant_types = EXCLUDED.grant_types,
        response_types = EXCLUDED.response_types,
        token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method
    `;
  }
}
