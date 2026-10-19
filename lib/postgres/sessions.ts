import type { SQL } from "bun";

import { logger } from "../../utils/logger";
import { DecryptionError, type Keyring } from "../encryption";
import type { ChowdeckSession, SessionStore } from "../session";

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const associatedData = (userId: string) => `chowbot:chowdeck-session:${userId.toLowerCase()}`;

/*
 * The whole session (Chowdeck token, phone, guest ID) is encrypted as one
 * value, so nothing about it is readable at rest. A session that fails to
 * decrypt, for example after a key change, is treated as signed out.
 */
export class PostgresSessionStore implements SessionStore {
  constructor(
    private readonly sql: SQL,
    private readonly keyring: Keyring,
  ) {}

  async get(principalId: string) {
    if (!USER_ID_PATTERN.test(principalId)) return undefined;

    const [row] = await this.sql`
      SELECT encrypted_session FROM chowdeck_sessions WHERE user_id = ${principalId}
    `;
    if (!row) return undefined;

    try {
      const plaintext = this.keyring.decrypt(row.encrypted_session, associatedData(principalId));
      return JSON.parse(plaintext) as ChowdeckSession;
    } catch (error) {
      if (!(error instanceof DecryptionError)) throw error;
      logger.warn("Ignoring a stored Chowdeck session that could not be decrypted");
      return undefined;
    }
  }

  async set(principalId: string, session: ChowdeckSession) {
    if (!USER_ID_PATTERN.test(principalId)) {
      throw new Error("Chowdeck sessions can only be stored for ChowBot user IDs");
    }
    const encrypted = this.keyring.encrypt(JSON.stringify(session), associatedData(principalId));
    await this.sql`
      INSERT INTO chowdeck_sessions (user_id, encrypted_session, updated_at)
      VALUES (${principalId}, ${encrypted}, now())
      ON CONFLICT (user_id)
      DO UPDATE SET encrypted_session = EXCLUDED.encrypted_session, updated_at = now()
    `;
  }

  async delete(principalId: string) {
    if (!USER_ID_PATTERN.test(principalId)) return;
    await this.sql`DELETE FROM chowdeck_sessions WHERE user_id = ${principalId}`;
  }
}
