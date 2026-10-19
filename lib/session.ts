export type ChowdeckSession = {
  token?: string;
  phone?: string;
  guestId?: string;
};

export interface SessionStore {
  get(principalId: string): Promise<ChowdeckSession | undefined>;
  set(principalId: string, session: ChowdeckSession): Promise<void>;
  delete(principalId: string): Promise<void>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ChowdeckSession>();

  async get(principalId: string) {
    const session = this.sessions.get(principalId);
    return session && { ...session };
  }

  async set(principalId: string, session: ChowdeckSession) {
    this.sessions.set(principalId, { ...session });
  }

  async delete(principalId: string) {
    this.sessions.delete(principalId);
  }
}

/*
 * A session handle already bound to one principal. Features receive this
 * instead of the store so they cannot read or write another user's session.
 */
export type UserSession = {
  get(): Promise<ChowdeckSession | undefined>;
  save(session: ChowdeckSession): Promise<void>;
  clear(): Promise<void>;
};

export const bindSession = (
  store: SessionStore,
  principalId: string,
): UserSession => ({
  get: () => store.get(principalId),
  save: (session) => store.set(principalId, session),
  clear: () => store.delete(principalId),
});
