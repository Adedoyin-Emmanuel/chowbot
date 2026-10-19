/*
 * Maps a Chowdeck-verified phone number to a stable internal ChowBot user ID.
 * The phone is only trusted after Chowdeck has accepted its OTP.
 */
export interface UserStore {
  findOrCreateByPhone(phone: string): Promise<string>;
}

export class InMemoryUserStore implements UserStore {
  private readonly userIdsByPhone = new Map<string, string>();

  async findOrCreateByPhone(phone: string) {
    const existing = this.userIdsByPhone.get(phone);
    if (existing) return existing;

    const userId = crypto.randomUUID();
    this.userIdsByPhone.set(phone, userId);
    return userId;
  }
}
