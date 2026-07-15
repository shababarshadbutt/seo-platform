import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync
} from "node:crypto";

import { config } from "../config.js";

// AES-256-GCM encryption for secrets stored at rest (currently the GSC service
// account JSON on sessions.gsc_credentials_encrypted). The stored value is
// self-describing: "v1:<salt>:<iv>:<authTag>:<ciphertext>", all base64. The
// salt is per-value so the same plaintext never yields the same ciphertext and
// the key derivation is bound to the value.

const VERSION = "v1";
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM standard nonce length
const SALT_LENGTH = 16;

function deriveKey(salt: Buffer): Buffer {
  return scryptSync(config.encryptionKey, salt, KEY_LENGTH);
}

export function encryptSecret(plaintext: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    salt.toString("base64"),
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64")
  ].join(":");
}

export function decryptSecret(encoded: string): string {
  const parts = encoded.split(":");

  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error("malformed encrypted secret");
  }

  const salt = Buffer.from(parts[1], "base64");
  const iv = Buffer.from(parts[2], "base64");
  const authTag = Buffer.from(parts[3], "base64");
  const ciphertext = Buffer.from(parts[4], "base64");

  const key = deriveKey(salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString("utf8");
}
