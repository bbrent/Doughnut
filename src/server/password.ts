/** Password hashing with scrypt (Node built-in; no native add-ons). */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;

function derive(password: string, salt: Buffer, o: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEYLEN, { ...o, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Returns "scrypt$N$r$p$salt$hash" (base64 parts). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function checkNewPassword(password: string): string | null {
  if (password.length < 6) return 'Use a password of at least 6 characters';
  if (password.length > 200) return 'That password is too long';
  return null;
}

/** Slows down password guessing: after 5 failures a nickname is locked, doubling up to 15 minutes. */
export class LoginThrottle {
  private fails = new Map<string, { n: number; until: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  check(key: string): number {
    const f = this.fails.get(key);
    return f && f.until > this.now() ? Math.ceil((f.until - this.now()) / 1000) : 0;
  }
  fail(key: string): void {
    const f = this.fails.get(key) ?? { n: 0, until: 0 };
    f.n++;
    if (f.n >= 5) f.until = this.now() + Math.min(15 * 60_000, 30_000 * 2 ** (f.n - 5));
    this.fails.set(key, f);
  }
  success(key: string): void {
    this.fails.delete(key);
  }
}
