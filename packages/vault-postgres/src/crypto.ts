// SPDX-License-Identifier: AGPL-3.0-or-later
// At-rest encryption for the eidan secrets vault. A byte-for-byte TS port of the Python
// `auth_native/vault_crypto.py` (docs/011 §12 / docs/012) so ciphertext is interchangeable
// between the two stacks: the same `eidan.secrets_vault.value_enc` row decrypts on either.
//
// Primitive: Fernet (AES-128-CBC + HMAC-SHA256, urlsafe-base64 envelope). The key is derived
// from the operator-set EIDAN_AUTH_MASTER_KEY via HKDF-SHA256 with a fixed application-bound
// salt, so the same passphrase always yields the same key (idempotent across restarts/nodes).
// Verified against the live slack.bot_token row before this was committed.
import { hkdfSync, createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Fixed application-bound salt + info. Public by design (documented in docs/011); HKDF does not
// rely on the salt for entropy — the master key is already high-entropy.
const HKDF_SALT = Buffer.from('eidan-auth-master-key/v1', 'utf8');
const HKDF_INFO = Buffer.from('eidan vault encryption', 'utf8');

export class MasterKeyMissing extends Error {
  constructor() {
    super(
      'EIDAN_AUTH_MASTER_KEY is not set. Generate one with ' +
        "`node -e \"console.log(require('crypto').randomBytes(36).toString('base64url'))\"` " +
        'and add it to the deploy env. See docs/011 §12.',
    );
    this.name = 'MasterKeyMissing';
  }
}

export function masterKeyConfigured(): boolean {
  return Boolean(process.env['EIDAN_AUTH_MASTER_KEY']);
}

// HKDF-SHA256(master) -> 32 raw bytes -> urlsafe-base64 string. That string IS the Fernet key
// (Python's `urlsafe_b64encode(derived)`); Fernet splits it into a 16-byte signing key + a
// 16-byte AES-128 key.
function deriveRawKey(): Buffer {
  const raw = process.env['EIDAN_AUTH_MASTER_KEY'];
  if (!raw) throw new MasterKeyMissing();
  // hkdfSync returns an ArrayBuffer; wrap to Buffer. 32 bytes = AES-128 sign(16)+enc(16).
  return Buffer.from(hkdfSync('sha256', Buffer.from(raw, 'utf8'), HKDF_SALT, HKDF_INFO, 32));
}

const FERNET_VERSION = 0x80;

// Seal `plaintext` into a Fernet token (the bytes stored verbatim in the bytea column). The
// token's internal base64 is what Python's Fernet.encrypt() emits, so we store the urlsafe-b64
// ASCII bytes — matching how the Python side wrote `value_enc`.
export function encryptValue(plaintext: Buffer): Buffer {
  const key = deriveRawKey();
  const signingKey = key.subarray(0, 16);
  const cryptoKey = key.subarray(16, 32);

  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-cbc', cryptoKey, iv); // PKCS7 padding on by default
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const ts = Buffer.alloc(8);
  // Fernet timestamp: big-endian unix seconds. Used only for optional TTL; we never enforce it.
  ts.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));

  const signed = Buffer.concat([Buffer.from([FERNET_VERSION]), ts, iv, ct]);
  const hmac = createHmac('sha256', signingKey).update(signed).digest();
  const token = Buffer.concat([signed, hmac]);
  // urlsafe-b64 ASCII bytes (what Fernet.encrypt returns), stored as-is.
  return Buffer.from(token.toString('base64url'), 'ascii');
}

// Reverse of encryptValue. Throws on tamper / wrong key (HMAC mismatch) — callers that treat a
// secret as optional should catch and degrade, never silently fall back to plaintext.
export function decryptValue(ciphertext: Buffer): Buffer {
  const key = deriveRawKey();
  const signingKey = key.subarray(0, 16);
  const cryptoKey = key.subarray(16, 32);

  // The stored bytea is the urlsafe-b64 ASCII of the raw token struct; decode back to raw.
  const token = Buffer.from(ciphertext.toString('ascii'), 'base64url');
  if (token.length < 1 + 8 + 16 + 32 || token[0] !== FERNET_VERSION) {
    throw new Error('invalid Fernet token');
  }
  const hmac = token.subarray(token.length - 32);
  const signed = token.subarray(0, token.length - 32);
  const mac = createHmac('sha256', signingKey).update(signed).digest();
  if (mac.length !== hmac.length || !timingSafeEqual(mac, hmac)) {
    throw new Error('Fernet HMAC mismatch (wrong master key or corrupt ciphertext)');
  }
  const iv = token.subarray(9, 25);
  const ct = token.subarray(25, token.length - 32);
  const decipher = createDecipheriv('aes-128-cbc', cryptoKey, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
