import type { ErrorType } from './types.js';

/**
 * Every failure, as one class with a `type` you switch on.
 *
 * One class rather than twelve subclasses, because in TypeScript the
 * discriminant is what you actually branch on - `catch (e) { if (e.type ===
 * 'rate_limited') }` narrows, and a subclass hierarchy only adds `instanceof`
 * checks that do the same job more verbosely. The predicates below cover the
 * two questions worth asking about an error that is not a specific type.
 */
export class EasyDataError extends Error {
  /** The `error.type` the API sent. Empty for a transport failure. */
  readonly type: ErrorType | string;
  /** The HTTP status. 0 when no response was received. */
  readonly status: number;
  /** Quote this at support and the request can be found in one query. */
  readonly requestId: string;
  /** The offending body key, when the API could name one. */
  readonly field?: string;
  /** Seconds, from `Retry-After`, when the server sent one. */
  readonly retryAfter?: number;
  /** The parsed body, for anything the fields above do not carry. */
  readonly body?: unknown;

  constructor(
    message: string,
    init: {
      type?: string;
      status?: number;
      requestId?: string;
      field?: string;
      retryAfter?: number;
      body?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'EasyDataError';
    this.type = init.type ?? '';
    this.status = init.status ?? 0;
    this.requestId = init.requestId ?? '';
    this.field = init.field;
    this.retryAfter = init.retryAfter;
    this.body = init.body;
  }

  /**
   * True when the request never produced an API response - DNS, TLS, socket,
   * timeout. Distinct from every error with a `type`, which all mean "the API
   * answered and said no".
   */
  get isTransport(): boolean {
    return this.status === 0 && this.type === '';
  }

  /** True for the failures that are worth repeating: 429 and 5xx. */
  get isRetryable(): boolean {
    return this.isTransport || this.status === 429 || this.status >= 500;
  }
}

export function isEasyDataError(e: unknown): e is EasyDataError {
  return e instanceof EasyDataError;
}

/**
 * Builds the error for one response.
 *
 * An unrecognised `type` is carried through rather than flattened: the
 * vocabulary is allowed to grow, and an SDK a version behind should still hand
 * the caller something they can read and report.
 */
export function errorFor(status: number, body: unknown, retryAfter?: number): EasyDataError {
  const envelope = (body ?? {}) as { error?: Record<string, unknown> };
  const err = envelope.error ?? {};

  return new EasyDataError(String(err.message ?? `HTTP ${status}`), {
    type: String(err.type ?? ''),
    status,
    requestId: String(err.requestId ?? ''),
    field: err.field ? String(err.field) : undefined,
    retryAfter,
    body,
  });
}
