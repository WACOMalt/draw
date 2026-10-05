// Captcha for registration and password reset emails: ALTCHA (altcha.org, MIT), a self-hosted
// proof of work. The browser computes a small PBKDF2 search (about a second); the server checks
// it in under a millisecond. No third-party service, no tracking, no image puzzles, nothing
// that feeds a model. The widget's "human interaction signature" collector is off (client side).
//
// GET /api/captcha gives a signed challenge (valid 10 minutes). A form sends the widget's
// payload as `captcha`; check() verifies the signature, the expiry and the work, and accepts
// each challenge once.

import { createChallenge, randomInt, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { deriveHmacKeySecret, verify } from 'altcha-lib/frameworks/shared';

/** PBKDF2 iterations per try, and the range of the secret counter: about 1 s in a browser. */
const COST = Number(process.env.CAPTCHA_COST ?? 2000);
const COUNTER_MIN = Number(process.env.CAPTCHA_COUNTER_MIN ?? 1000);
const COUNTER_MAX = Number(process.env.CAPTCHA_COUNTER_MAX ?? 3000);
const TTL_MS = 10 * 60 * 1000;

export interface Captcha {
  challenge(): Promise<Challenge>;
  /** True when `payload` is a correct, unexpired, unused solution. */
  check(payload: unknown): Promise<boolean>;
}

export async function makeCaptcha(secret: string): Promise<Captcha> {
  const keySecret = await deriveHmacKeySecret(secret);
  // Used challenges, until they expire anyway (one server process: memory is enough).
  const used = new Map<string, number>();
  const store = {
    get: (id: string) => {
      const until = used.get(id);
      return until !== undefined && until > Date.now();
    },
    set: (id: string) => {
      const now = Date.now();
      if (used.size > 10_000) for (const [k, until] of used) if (until <= now) used.delete(k);
      used.set(id, now + TTL_MS);
    },
  };
  return {
    challenge: () =>
      createChallenge({
        algorithm: 'PBKDF2/SHA-256',
        cost: COST,
        counter: randomInt(COUNTER_MIN, COUNTER_MAX),
        deriveKey,
        hmacSignatureSecret: secret,
        hmacKeySignatureSecret: keySecret,
        expiresAt: new Date(Date.now() + TTL_MS),
      }),
    async check(payload) {
      if (typeof payload !== 'string' || !payload || payload.length > 10_000) return false;
      const r = await verify(payload, deriveKey, secret, keySecret, store);
      return !r.error && !!r.verification?.verified;
    },
  };
}
