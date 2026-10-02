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

export function newId(): string {
  return randomString(ID_ALPHABET, 16);
}

export function newSessionCode(): string {
  const raw = randomString(CODE_ALPHABET, 8);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
