import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with scrypt, which is built into Node (no native add-ons, so
 * the same code runs in Docker and on Lambda) and is memory-hard.
 * Parameters follow OWASP's recommendation: N=2^17, r=8, p=1 (128 MiB, ~0.3 s).
 *
 * Stored format: scrypt$<log2 N>$<r>$<p>$<salt b64>$<hash b64>
 */

const DEFAULT_LOG_N = 17;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

function derive(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  const N = 2 ** logN;
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string, logN = DEFAULT_LOG_N): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, logN, R, P);
  return `scrypt$${logN}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [algo, logN, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), Number(logN), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Hash work for unknown emails too, so response time doesn't reveal which emails have accounts. */
export async function burnTime(logN = DEFAULT_LOG_N): Promise<void> {
  await derive("not-a-real-password", randomBytes(16), logN, R, P);
}
