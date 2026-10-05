import { CODE_ALPHABET } from './types';

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomString(alphabet: string, length: number): string {
  // Rejection sampling avoids modulo bias.
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit) out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * A 16-character id made from two ids, the same on every client and the server: the ids of the
 * copies that layer.duplicate makes. Three FNV-1a hashes with different seeds, in base 62
 * (6 + 6 + 4 characters: about 86 bits).
 */
export function derivedId(a: string, b: string): string {
  const s = `${a}/${b}`;
  const hash = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return h;
  };
  const enc = (n: number, width: number) => {
    let out = '';
    for (let i = 0; i < width; i++) {
      out += ID_ALPHABET[n % 62];
      n = Math.floor(n / 62);
    }
    return out;
  };
  return enc(hash(0x811c9dc5), 6) + enc(hash(0x050c5d1f), 6) + enc(hash(0x2f6b3a91), 4);
}

export function newId(): string {
  return randomString(ID_ALPHABET, 16);
}

export function newSessionCode(): string {
  const raw = randomString(CODE_ALPHABET, 8);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
