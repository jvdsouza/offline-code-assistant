import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "../config.js";
import { ValidationError } from "../errors.js";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: { N: number }) => Promise<Buffer>;

const SCRYPT_N = 16384;
const KEY_LENGTH = 64;

/**
 * Hashes a password with scrypt and a random 16-byte salt.
 * Stored format: `scrypt$<N>$<salt b64>$<hash b64>`.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < config.passwordMinLength) {
    throw new ValidationError(`Password must be at least ${config.passwordMinLength} characters`);
  }
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Constant-time comparison so response timing doesn't leak how much of the hash matched. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !n || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
