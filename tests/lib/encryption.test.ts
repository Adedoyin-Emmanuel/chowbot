import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  createKeyring,
  DecryptionError,
  parseEncryptionKey,
  EncryptionKeyError,
} from "../../lib/encryption";

const key = () => randomBytes(32);

describe("parseEncryptionKey", () => {
  test("accepts 32 bytes in base64 and base64url", () => {
    const bytes = key();

    expect(parseEncryptionKey(bytes.toString("base64"))).toEqual(bytes);
    expect(parseEncryptionKey(bytes.toString("base64url"))).toEqual(bytes);
  });

  test.each([
    [undefined, "CHOWBOT_ENCRYPTION_KEY is required"],
    ["   ", "CHOWBOT_ENCRYPTION_KEY is required"],
    ["not base64!", "CHOWBOT_ENCRYPTION_KEY must be base64 encoded"],
    [randomBytes(16).toString("base64"), "CHOWBOT_ENCRYPTION_KEY must decode to 32 bytes, got 16"],
    [randomBytes(64).toString("base64"), "CHOWBOT_ENCRYPTION_KEY must decode to 32 bytes, got 64"],
  ])("rejects %p", (value, message) => {
    expect(() => parseEncryptionKey(value)).toThrow(EncryptionKeyError);
    expect(() => parseEncryptionKey(value)).toThrow(message);
  });

  test("never echoes the rejected key", () => {
    const short = randomBytes(16).toString("base64");

    expect(() => parseEncryptionKey(short)).not.toThrow(short);
  });
});

describe("keyring encryption", () => {
  const secret = JSON.stringify({ token: "chowdeck-secret-token", phone: "08012345678" });

  test("round-trips plaintext bound to its associated data", () => {
    const keyring = createKeyring(key());

    const envelope = keyring.encrypt(secret, "user-a");

    expect(keyring.decrypt(envelope, "user-a")).toBe(secret);
    expect(envelope[0]).toBe(1);
    expect(envelope.toString("utf8")).not.toContain("chowdeck-secret-token");
    expect(envelope.toString("utf8")).not.toContain("08012345678");
  });

  test("uses a fresh nonce for every encryption", () => {
    const keyring = createKeyring(key());

    const first = keyring.encrypt(secret, "user-a");
    const second = keyring.encrypt(secret, "user-a");

    expect(first.equals(second)).toBe(false);
    expect(first.subarray(1, 13).equals(second.subarray(1, 13))).toBe(false);
  });

  test("fails safely with the wrong key", () => {
    const envelope = createKeyring(key()).encrypt(secret, "user-a");

    expect(() => createKeyring(key()).decrypt(envelope, "user-a")).toThrow(DecryptionError);
  });

  test("fails when the ciphertext is moved to another user", () => {
    const keyring = createKeyring(key());
    const envelope = keyring.encrypt(secret, "user-a");

    expect(() => keyring.decrypt(envelope, "user-b")).toThrow(DecryptionError);
  });

  test.each([
    ["a flipped ciphertext byte", (bytes: Buffer) => { bytes[20]! ^= 1; }],
    ["a flipped tag byte", (bytes: Buffer) => { bytes[bytes.length - 1]! ^= 1; }],
    ["an unknown version", (bytes: Buffer) => { bytes[0] = 9; }],
  ])("fails on %s", (_, tamper) => {
    const keyring = createKeyring(key());
    const envelope = Buffer.from(keyring.encrypt(secret, "user-a"));
    tamper(envelope);

    expect(() => keyring.decrypt(envelope, "user-a")).toThrow(DecryptionError);
  });

  test("fails on a truncated envelope without leaking details", () => {
    const keyring = createKeyring(key());

    expect(() => keyring.decrypt(Buffer.from([1, 2, 3]), "user-a")).toThrow(
      "Encrypted value could not be decrypted",
    );
  });
});

describe("phone hashing", () => {
  test("is deterministic per key, keyed, and does not contain the phone", () => {
    const masterKey = key();
    const keyring = createKeyring(masterKey);

    const hash = keyring.hashPhone("08012345678");

    expect(hash).toBe(createKeyring(masterKey).hashPhone("08012345678"));
    expect(hash).not.toBe(createKeyring(key()).hashPhone("08012345678"));
    expect(hash).not.toBe(keyring.hashPhone("08012345679"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("08012345678");
  });
});

describe("address binding", () => {
  test("is deterministic per key and user, and never contains the address id", () => {
    const masterKey = key();
    const keyring = createKeyring(masterKey);

    const binding = keyring.bindAddress("user-a", 918273);

    expect(binding).toBe(createKeyring(masterKey).bindAddress("user-a", 918273));
    expect(binding).not.toBe(keyring.bindAddress("user-b", 918273));
    expect(binding).not.toBe(keyring.bindAddress("user-a", 918274));
    expect(binding).not.toBe(createKeyring(key()).bindAddress("user-a", 918273));
    expect(binding).not.toBe(keyring.hashPhone("user-a\u0000918273"));
    expect(binding).toMatch(/^[0-9a-f]{64}$/);
    expect(binding).not.toContain("918273");
  });
});

describe("request-state key", () => {
  test("is a stable 32-byte key derived from the master key and distinct per master key", () => {
    const masterKey = key();

    const derived = createKeyring(masterKey).requestStateKey;

    expect(derived).toHaveLength(32);
    expect(Buffer.from(derived).equals(Buffer.from(createKeyring(masterKey).requestStateKey))).toBe(true);
    expect(Buffer.from(derived).equals(Buffer.from(createKeyring(key()).requestStateKey))).toBe(false);
    expect(Buffer.from(derived).equals(masterKey)).toBe(false);
  });
});
