/**
 * The wire types.
 *
 * `data` on a result entry is `unknown` rather than `any`: its shape is the
 * operation's, and typing it as `any` would let a caller read a field that does
 * not exist on the record they actually asked for, with no complaint from the
 * compiler. Narrow it yourself, or pass a type parameter to the operation.
 */

/** Every operation this API publishes. */
export type Operation =
  | 'profiles.enrich'
  | 'profiles.activity'
  | 'profiles.posts'
  | 'profiles.comments'
  | 'profiles.reactions'
  | 'companies.enrich'
  | 'posts.enrich'
  | 'sales.search.people'
  | 'sales.search.companies';

/** A batch's lifecycle. `queued` and `processing` are the live pair. */
export type BatchStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

/** One entry's outcome. */
export type EntryStatus = 'succeeded' | 'failed' | 'quota_exhausted';

/** The whole error vocabulary, as the API sends it. */
export type ErrorType =
  | 'invalid_request'
  | 'invalid_api_key'
  | 'quota_exhausted'
  | 'email_unverified'
  | 'not_found'
  | 'conflict'
  | 'unprocessable_target'
  | 'rate_limited'
  | 'not_implemented'
  | 'internal_error'
  | 'upstream_timeout'
  | 'capacity_unavailable';

/** A target: a URL or public identifier, or an object carrying extras. */
export type Target = string | Record<string, unknown>;

export interface IEntryError {
  type: ErrorType | string;
  message: string;
  field?: string;
}

/** One row of a batch's results, exactly as the cursor returns it. */
export interface IResultEntry<T = unknown> {
  /** Your submission order. Order of DELIVERY is never guaranteed. */
  item_index: number;
  input: Target;
  status: EntryStatus;
  /** Zero on a failure: a failed fetch produced nothing and costs nothing. */
  credits_used: number;
  /** Set only for a paged operation, where a target yields one entry per page. */
  page?: number;
  data?: T;
  error?: IEntryError;
  created_at: string;
}

/** A submission and its progress. */
export interface IBatch {
  batch_id: string;
  operation: Operation;
  status: BatchStatus;
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  /** Delivered ENTRIES, which for a paged operation is more than items. */
  results_available: number;
  credits_used: number;
  external_id?: string;
  callback_url?: string;
  webhook_tag?: string;
  find_emails?: boolean;
  /** True on a batch a `/sync` call created. It is what explains the credits. */
  priority?: boolean;
  created_at: string;
  completed_at?: string | null;
  /** How hard to poll. Server-set; polling faster does not finish it sooner. */
  recommended_poll_ms?: number;
}

/**
 * What a `/sync` call answers with.
 *
 * `complete` is the one field to branch on. False means the deadline expired
 * before the target finished: `result` may be null, the target is still being
 * worked at priority, and `batch_id` is a real batch whose results you can read.
 * It is never a 504, because you must keep the handle to results you may
 * already have been charged for.
 */
export interface ISyncResult<T = unknown> {
  batch_id: string;
  operation: Operation;
  status: BatchStatus;
  complete: boolean;
  result: IResultEntry<T> | null;
  credits_used: number;
  external_id?: string;
  created_at: string;
  completed_at?: string | null;
  recommended_poll_ms?: number;
}

/** One page of the results cursor. */
export interface IResultPage<T = unknown> {
  batch_id: string;
  status: BatchStatus;
  entries: IResultEntry<T>[];
}

/** The envelope's second half. camelCase, where `data` is snake_case. */
export interface IMeta {
  requestId: string;
  nextCursor?: string;
  hasMore?: boolean;
  total?: number;
  recommendedPollMs?: number;
}

export interface IEnvelope<T> {
  data: T;
  meta: IMeta;
}

/** Options every submission accepts. */
export interface ISubmitOptions {
  /** Your own correlation handle. Comes back on the batch, the webhook and usage. */
  externalId?: string;
  /** Where to deliver the COMPLETION. Mutually exclusive with webhookTag. */
  callbackUrl?: string;
  /** Route the completion to endpoints carrying this tag. */
  webhookTag?: string;
  /** Caps a paged operation, and IS the billing unit count for one. */
  maxResults?: number;
  /** Run the matching enrich on every returned row. Paged operations only. */
  enrich?: boolean;
  /** A work email per person returned. Flat +4 per verdict. */
  findEmails?: boolean;
  /** Fold the rows into the completion delivery when the batch fits. */
  includeResults?: boolean;
  /**
   * Override the key the client mints. Rarely what you want: the client already
   * generates one per submission so that ITS OWN retry cannot create a second
   * batch. Set this when your caller needs the retry to be idempotent too.
   */
  idempotencyKey?: string;
}

/** Options a `/sync` call accepts. The bounds are refusals, not downgrades. */
export interface ISyncOptions {
  externalId?: string;
  maxResults?: number;
  idempotencyKey?: string;
}

/**
 * The ceilings, read off the last response's headers.
 *
 * `undefined` means the deployment publishes no ceiling for it, which on the
 * wire is an ABSENT header and never a `0`. Reading a missing header as zero
 * would make an account with no limit look completely blocked.
 */
export interface IRateLimits {
  limit?: number;
  remaining?: number;
  reset?: number;
  concurrentBatchLimit?: number;
  concurrentBatchRemaining?: number;
  syncLimit?: number;
  syncRemaining?: number;
  syncReset?: number;
  syncConcurrentLimit?: number;
  syncConcurrentRemaining?: number;
}

/** The webhook events a customer can subscribe to. */
export type WebhookEvent = 'batch.completed' | 'batch.failed' | 'batch.started' | 'batch.result';

/** A delivery body. The event's fields are in `data`, one level down. */
export interface IWebhookDelivery<T = unknown> {
  /** Also the `X-EasyData-Delivery` header. This is your idempotency key. */
  id: string;
  event: WebhookEvent;
  createdAt: string;
  data: T;
}
