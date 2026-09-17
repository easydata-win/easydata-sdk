import { createHmac, timingSafeEqual, verify as cryptoVerify, createPublicKey } from 'node:crypto';

import type { IWebhookDelivery, WebhookEvent } from './types.js';

/**
 * Verifying a webhook delivery.
 *
 * Two schemes ride on every delivery and you need only one.
 *
 * `X-EasyData-Signature: t=<unix>,v1=<hex>` is an HMAC-SHA256 over
 * `<t>.<raw body>`, keyed with your webhook secret.
 *
 * `X-EasyData-Signature-Ed25519: t=<unix>,kid=<id>,wid=<endpoint>,v1b=<b64url>`
 * signs `<t>.<wid>.<raw body>` and is checked against the public key at
 * `/.well-known/webhook-keys.json`. It needs no secret, so a partner, a queue
 * consumer or an edge function can check a delivery you forwarded to them.
 *
 * Two rules that are easy to get wrong and silent when you do:
 *
 * - **Verify against the RAW body**, exactly the bytes that arrived.
 *   Re-serialising parsed JSON changes key order and whitespace, and the
 *   signature will not match a body you rebuilt. In Express that means
 *   `express.raw({ type: 'application/json' })` on this route, not `express.json()`.
 * - **Never verify against `X-EasyData-Timestamp`.** It carries the same unix
 *   seconds but sits OUTSIDE both signed messages, so anyone replaying a
 *   captured delivery can set it to whatever passes a freshness check. The `t`
 *   inside the signature header is the only copy that cannot be edited without
 *   breaking the signature, and it is the one these functions read.
 */

/** Seconds. Generous enough for a retry and a clock slightly out. */
export const DEFAULT_TOLERANCE = 300;

export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationError';
  }
}

/** Headers as any framework hands them over. */
export type HeaderBag = Record<string, string | string[] | undefined> | Headers;

/**
 * Verifies the HMAC signature and returns the parsed delivery.
 *
 * ```ts
 * app.post('/webhooks/easydata', express.raw({ type: 'application/json' }), (req, res) => {
 *   let delivery;
 *   try {
 *     delivery = verify(SECRET, req.headers, req.body);
 *   } catch {
 *     return res.sendStatus(400);
 *   }
 *   if (seen(delivery.id)) return res.sendStatus(200);  // stable across retries
 *   handle(delivery.event, delivery.data);
 *   res.sendStatus(200);
 * });
 * ```
 */
export function verify<T = unknown>(
  secret: string,
  headers: HeaderBag,
  body: Buffer | Uint8Array | string,
  options: { tolerance?: number } = {},
): IWebhookDelivery<T> {
  if (!secret) throw new VerificationError('no signing secret: read it from GET /v1/account');

  const raw = header(headers, 'x-easydata-signature');
  if (!raw) throw new VerificationError('no X-EasyData-Signature header');

  const parts = parse(raw);
  const ts = parts.t;
  const sig = parts.v1;
  if (!ts || !sig) throw new VerificationError(`malformed signature header: ${raw}`);

  checkAge(ts, options.tolerance ?? DEFAULT_TOLERANCE);

  const bytes = toBuffer(body);
  const expected = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${ts}.`), bytes]))
    .digest('hex');

  if (!equal(expected, sig)) throw new VerificationError('signature does not match');

  return unpack<T>(bytes);
}

/**
 * Verifies the Ed25519 signature.
 *
 * `webhookId` is YOUR endpoint's id and passing it is not optional. One key
 * signs for every customer on the deployment, so a delivery another customer
 * legitimately received is a genuinely signed message; without checking `wid`,
 * replaying theirs against your receiver verifies. The HMAC scheme needs no
 * equivalent check, because your secret is only yours.
 */
export function verifyEd25519<T = unknown>(
  publicKeyBase64: string,
  headers: HeaderBag,
  body: Buffer | Uint8Array | string,
  options: { webhookId: string; tolerance?: number },
): IWebhookDelivery<T> {
  if (!options?.webhookId) {
    throw new VerificationError(
      'webhookId is required: one key signs for every customer, so a delivery is ' +
        'only yours if wid matches your endpoint',
    );
  }

  const raw = header(headers, 'x-easydata-signature-ed25519');
  if (!raw) throw new VerificationError('no X-EasyData-Signature-Ed25519 header');

  const parts = parse(raw);
  const ts = parts.t;
  const wid = parts.wid;
  const sig = parts.v1b;
  if (!ts || !wid || !sig) throw new VerificationError(`malformed signature header: ${raw}`);

  if (!equal(wid, options.webhookId)) {
    throw new VerificationError(
      `delivery was addressed to endpoint ${wid}, not to ${options.webhookId}`,
    );
  }

  checkAge(ts, options.tolerance ?? DEFAULT_TOLERANCE);

  const bytes = toBuffer(body);
  // DER-wrapped so node:crypto will take it: the published key is 32 raw bytes
  // and createPublicKey wants SPKI, whose Ed25519 prefix is a fixed 12 bytes.
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      decodeB64(publicKeyBase64),
    ]),
    format: 'der',
    type: 'spki',
  });

  const message = Buffer.concat([Buffer.from(`${ts}.${wid}.`), bytes]);
  if (!cryptoVerify(null, message, key, decodeB64(sig))) {
    throw new VerificationError('signature does not match');
  }

  return unpack<T>(bytes);
}

function unpack<T>(body: Buffer): IWebhookDelivery<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new VerificationError('body is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new VerificationError('body is not an object');
  }

  // The event's own fields are in `data`, one level down. Reading the top level
  // instead is the quietest bug this API can hand you: the signature still
  // verifies, the handler still returns 2xx, and every field is undefined.
  const d = parsed as Record<string, unknown>;
  return {
    id: String(d.id ?? ''),
    event: String(d.event ?? '') as WebhookEvent,
    createdAt: String(d.createdAt ?? ''),
    data: (d.data ?? {}) as T,
  };
}

function checkAge(ts: string, tolerance: number): void {
  const sent = Number(ts);
  if (!Number.isFinite(sent)) {
    throw new VerificationError(`signature timestamp is not a number: ${ts}`);
  }
  if (tolerance > 0 && Math.abs(Date.now() / 1000 - sent) > tolerance) {
    throw new VerificationError(`signature timestamp is outside ${tolerance}s`);
  }
}

function parse(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function header(headers: HeaderBag, lowercaseName: string): string {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(lowercaseName) ?? '';
  }
  const bag = headers as Record<string, string | string[] | undefined>;
  for (const [k, v] of Object.entries(bag)) {
    if (k.toLowerCase() !== lowercaseName) continue;
    return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
  }
  return '';
}

function toBuffer(body: Buffer | Uint8Array | string): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

/** Constant time, and false rather than throwing on a length mismatch. */
function equal(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Decodes base64 in whichever of the four spellings arrived. A signature is
 * base64url without padding and a public key is pasted into an env file by a
 * human; which alphabet and whether it is padded is not worth failing on.
 */
function decodeB64(s: string): Buffer {
  const normalised = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalised + '='.repeat((4 - (normalised.length % 4)) % 4), 'base64');
}
