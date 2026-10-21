import {
  hkdfSync,
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_VERSION = 1;

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyError";
  }
}

export class DecryptionError extends Error {
  constructor() {
    super("Encrypted value could not be decrypted");
    this.name = "DecryptionError";
  }
}

/*
 * The key must be 32 random bytes, base64 or base64url encoded, e.g. from
 * `openssl rand -base64 32`. Errors never echo the supplied value.
 */
export const parseEncryptionKey = (value: string | undefined) => {
  const raw = value?.trim();
  if (!raw) {
    throw new EncryptionKeyError("CHOWBOT_ENCRYPTION_KEY is required");
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    throw new EncryptionKeyError("CHOWBOT_ENCRYPTION_KEY must be base64 encoded");
  }
  const key = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== KEY_BYTES) {
    throw new EncryptionKeyError(
      `CHOWBOT_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
};

const deriveKey = (masterKey: Buffer, purpose: string) =>
  Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), purpose, KEY_BYTES));

/*
 * One master key is split with HKDF into independent keys per purpose, so
 * the session-encryption key and the phone-hashing key never coincide.
 * Ciphertexts are versioned (version | nonce | ciphertext | tag) and bound
 * to their row through the additional authenticated data.
 */
export const createKeyring = (masterKey: Buffer) => {
  const encryptionKey = deriveKey(masterKey, "chowbot:aes-256-gcm:v1");
  const phoneHashKey = deriveKey(masterKey, "chowbot:phone-hmac:v1");

  const encrypt = (plaintext: string, associatedData: string) => {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    cipher.setAAD(Buffer.from(associatedData));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([
      Buffer.from([ENVELOPE_VERSION]),
      nonce,
      ciphertext,
      cipher.getAuthTag(),
    ]);
  };

  const decrypt = (envelope: Uint8Array, associatedData: string) => {
    const bytes = Buffer.from(envelope);
    if (bytes.length < 1 + NONCE_BYTES + TAG_BYTES || bytes[0] !== ENVELOPE_VERSION) {
      throw new DecryptionError();
    }
    const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
    const tag = bytes.subarray(bytes.length - TAG_BYTES);
    const ciphertext = bytes.subarray(1 + NONCE_BYTES, bytes.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
      decipher.setAAD(Buffer.from(associatedData));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new DecryptionError();
    }
  };

  const hashPhone = (phone: string) =>
    createHmac("sha256", phoneHashKey).update(phone).digest("hex");

  /*
   * Binds a quote to the delivery address without storing the address id.
   * The user id is part of the input so equal ids never collide across users.
   */
  const addressBindingKey = deriveKey(masterKey, "chowbot:address-binding:v1");
  const bindAddress = (userId: string, addressId: number) =>
    createHmac("sha256", addressBindingKey)
      .update(`${userId}\0${addressId}`)
      .digest("hex");

  const requestStateKey = new Uint8Array(
    deriveKey(masterKey, "chowbot:request-state:v1"),
  );

  return { encrypt, decrypt, hashPhone, bindAddress, requestStateKey };
};

export type Keyring = ReturnType<typeof createKeyring>;
