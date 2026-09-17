import { EasyDataError, errorFor } from './errors.js';
import type {
  BatchStatus,
  IBatch,
  IEnvelope,
  IMeta,
  IRateLimits,
  IResultEntry,
  IResultPage,
  ISubmitOptions,
  ISyncOptions,
  ISyncResult,
  Operation,
  Target,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://api.easydata.win/v1';

/** Statuses meaning the batch can still produce something. */
const LIVE = new Set(['queued', 'processing']);

/**
 * Operation name to path. A new operation is a row here and nothing else.
 *
 * `as const satisfies` rather than a `Record<Operation, string>` annotation:
 * the annotation erases the literal keys, and indexing an erased record with an
 * Operation reads as possibly-undefined under `noUncheckedIndexedAccess` even
 * though the lookup is total. `satisfies` keeps both - exhaustiveness checked
 * against Operation, and keys the compiler can still see.
 */
const PATHS = {
  'profiles.enrich': '/profiles/enrich',
  'profiles.activity': '/profiles/activity',
  'profiles.posts': '/profiles/posts',
  'profiles.comments': '/profiles/comments',
  'profiles.reactions': '/profiles/reactions',
  'companies.enrich': '/companies/enrich',
  'posts.enrich': '/posts/enrich',
  'sales.search.people': '/sales/search/people',
  'sales.search.companies': '/sales/search/companies',
} as const satisfies Record<Operation, string>;

export interface IClientOptions {
  /** Defaults to `process.env.EASYDATA_API_KEY`. */
  apiKey?: string;
  baseUrl?: string;
  /** Per request, in milliseconds. Above the server's own `/sync` deadline. */
  timeoutMs?: number;
  /** Retries after the first attempt, for 429, 5xx and transport failures. */
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * One operation, callable three ways.
 *
 * `ed.profiles.enrich(targets)` submits a batch, `.sync(target)` does the
 * blocking single lookup, and `.collect(targets)` submits and drains. One
 * object rather than three method names, because they are one operation.
 */
export interface IOperationHandle {
  <T = unknown>(targets: Target[], options?: ISubmitOptions): Promise<IBatch>;
  sync<T = unknown>(target: Target, options?: ISyncOptions): Promise<ISyncResult<T>>;
  collect<T = unknown>(
    targets: Target[],
    options?: ISubmitOptions & { timeoutMs?: number },
  ): Promise<IResultEntry<T>[]>;
}

/**
 * The EasyData client.
 *
 * ```ts
 * const ed = new EasyData();                       // reads EASYDATA_API_KEY
 * const r = await ed.profiles.enrich.sync('https://linkedin.com/in/satyanadella');
 *
 * const batch = await ed.profiles.enrich(urls, { externalId: 'crm-sync' });
 * for await (const entry of ed.results(batch.batch_id)) {
 *   if (entry.status === 'succeeded') save(entry.data);
 * }
 * ```
 *
 * Retries cover exactly the failures that are safe to repeat, and every
 * submission carries an `Idempotency-Key` so that repeating one is free - a
 * retried submit resolves to the batch the first attempt created rather than
 * creating a second one and charging for it.
 */
export class EasyData {
  readonly baseUrl: string;
  readonly maxRetries: number;
  readonly timeoutMs: number;

  /** The ceilings from the most recent response, including a failed one. */
  rateLimits: IRateLimits = {};

  private readonly apiKey: string;
  private readonly doFetch: typeof globalThis.fetch;

  readonly profiles: {
    enrich: IOperationHandle;
    activity: IOperationHandle;
    posts: IOperationHandle;
    comments: IOperationHandle;
    reactions: IOperationHandle;
  };
  readonly companies: { enrich: IOperationHandle };
  readonly posts: { enrich: IOperationHandle };
  readonly sales: { searchPeople: IOperationHandle; searchCompanies: IOperationHandle };

  constructor(options: IClientOptions = {}) {
    const key = options.apiKey ?? process.env.EASYDATA_API_KEY ?? '';
    if (!key) {
      throw new Error(
        'no API key: pass { apiKey } or set EASYDATA_API_KEY in the environment',
      );
    }
    this.apiKey = key;
    this.baseUrl = (options.baseUrl ?? process.env.EASYDATA_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 3;
    // Captured rather than called off globalThis each time, so a test can pass
    // its own and a runtime without a global fetch fails here with a readable
    // message instead of at the first request.
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new Error('no fetch available: pass { fetch } or run on Node 18+');
    }
    this.doFetch = f.bind(globalThis);

    this.profiles = {
      enrich: this.operation('profiles.enrich'),
      activity: this.operation('profiles.activity'),
      posts: this.operation('profiles.posts'),
      comments: this.operation('profiles.comments'),
      reactions: this.operation('profiles.reactions'),
    };
    this.companies = { enrich: this.operation('companies.enrich') };
    this.posts = { enrich: this.operation('posts.enrich') };
    this.sales = {
      searchPeople: this.operation('sales.search.people'),
      searchCompanies: this.operation('sales.search.companies'),
    };
  }

  private operation(op: Operation): IOperationHandle {
    const path = PATHS[op];

    const handle = (async (targets: Target[], options?: ISubmitOptions) =>
      this.submit(path, targets, options)) as IOperationHandle;

    handle.sync = <T>(target: Target, options?: ISyncOptions) =>
      this.submitSync<T>(path, target, options);

    handle.collect = async <T>(
      targets: Target[],
      options?: ISubmitOptions & { timeoutMs?: number },
    ) => {
      const { timeoutMs, ...submit } = options ?? {};
      const batch = await this.submit(path, targets, submit);
      const out: IResultEntry<T>[] = [];
      for await (const entry of this.results<T>(batch.batch_id, { timeoutMs })) out.push(entry);
      return out;
    };

    return handle;
  }

  // ------------------------------------------------------------------ submit

  /**
   * Submit a batch. Answers 202 with the batch; nothing has run yet.
   *
   * A batch of one is a batch. There is no separate single-target path and no
   * ceiling to discover between one target and fifty thousand.
   */
  async submit(path: string, targets: Target[], options: ISubmitOptions = {}): Promise<IBatch> {
    if (!targets?.length) {
      throw new Error('targets is empty: a batch needs at least one target');
    }

    const body: Record<string, unknown> = { targets };
    put(body, {
      external_id: options.externalId,
      callback_url: options.callbackUrl,
      webhook_tag: options.webhookTag,
      max_results: options.maxResults,
      enrich: options.enrich,
      find_emails: options.findEmails,
      include_results: options.includeResults,
    });

    const { data } = await this.request<IBatch>('POST', path, {
      body,
      // Minted here rather than left to the caller, because the retry below is
      // ours: without a key, our own retry of a submission that actually
      // succeeded creates a second batch and bills for it.
      idempotencyKey: options.idempotencyKey ?? randomKey(),
    });
    return data;
  }

  /**
   * One entity, answered in this response, at twice the credits.
   *
   * `target`, singular - not an array of one, which is a 400 naming the other
   * field. The bounds are refusals rather than downgrades: no `enrich`, no
   * webhooks, and one upstream page for a paged operation.
   */
  async submitSync<T = unknown>(
    path: string,
    target: Target,
    options: ISyncOptions = {},
  ): Promise<ISyncResult<T>> {
    if (Array.isArray(target)) {
      throw new Error('sync takes ONE target, not an array - submit a batch for several');
    }

    const body: Record<string, unknown> = { target };
    put(body, { external_id: options.externalId, max_results: options.maxResults });

    const { data } = await this.request<ISyncResult<T>>('POST', `${path}/sync`, {
      body,
      idempotencyKey: options.idempotencyKey ?? randomKey(),
    });
    return data;
  }

  // ----------------------------------------------------------------- batches

  async batch(batchId: string): Promise<IBatch> {
    return (await this.request<IBatch>('GET', `/batches/${batchId}`)).data;
  }

  async batches(
    filter: {
      status?: string;
      operation?: Operation;
      externalId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<IBatch[]> {
    // `data` is the array itself; the listing's pagination is in `meta`.
    const { data } = await this.request<IBatch[]>('GET', '/batches', {
      query: {
        status: filter.status,
        operation: filter.operation,
        external_id: filter.externalId,
        limit: filter.limit ?? 50,
        offset: filter.offset ?? 0,
      },
    });
    return data ?? [];
  }

  /** Stop a batch. Entries already delivered stay delivered and charged. */
  async cancel(batchId: string): Promise<IBatch> {
    return (await this.request<IBatch>('POST', `/batches/${batchId}/cancel`)).data;
  }

  /**
   * Stream a batch's entries, yielding each as it becomes readable.
   *
   * This is the point of the cursor: results are readable WHILE the batch is
   * still processing, so a long batch starts producing rows immediately rather
   * than after it finishes.
   *
   * With `wait` (the default) the iterator holds the cursor open until the batch
   * reaches a terminal state, sleeping for the server's own `recommendedPollMs`
   * between empty reads. With `wait: false` it yields what is readable now and
   * returns.
   *
   * The cursor is monotonic and gapless, so an entry is yielded exactly once
   * and a batch still filling in never re-delivers one you have seen.
   */
  async *results<T = unknown>(
    batchId: string,
    options: { pageSize?: number; wait?: boolean; timeoutMs?: number } = {},
  ): AsyncGenerator<IResultEntry<T>, void, undefined> {
    const { pageSize = 100, wait = true, timeoutMs } = options;
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    let cursor = '';

    for (;;) {
      const page = await this.resultsPage<T>(batchId, { cursor, pageSize });

      for (const entry of page.entries) yield entry;

      if (page.nextCursor) cursor = page.nextCursor;
      if (page.hasMore) continue;

      if (!wait || !LIVE.has(page.status)) return;

      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error(
          `batch ${batchId} was still ${page.status} after ${timeoutMs}ms; its results ` +
            'remain readable - call results() again with the same batch id',
        );
      }

      // The server's own number. Polling faster does not make the scrape finish
      // sooner; it only spends the request budget the rate limiter is counting.
      await sleep(page.recommendedPollMs || 2000);
    }
  }

  /**
   * One page of the results cursor, and the cursor to continue from.
   *
   * `results()` is the loop you usually want. This is the layer under it, for a
   * caller that owns its own paging - a worker that stores the cursor between
   * runs, or a tool call that must return rather than block. The cursor is
   * opaque: hand back exactly what you were given.
   */
  async resultsPage<T = unknown>(
    batchId: string,
    options: { cursor?: string; pageSize?: number } = {},
  ): Promise<{
    status: BatchStatus;
    entries: IResultEntry<T>[];
    nextCursor: string;
    hasMore: boolean;
    /** How long to wait before asking again. Zero once the batch is terminal. */
    recommendedPollMs: number;
  }> {
    const { data, meta } = await this.request<IResultPage<T>>(
      'GET',
      `/batches/${batchId}/results`,
      { query: { limit: options.pageSize ?? 100, cursor: options.cursor || undefined } },
    );

    return {
      status: data.status,
      entries: data.entries ?? [],
      nextCursor: meta.nextCursor ?? '',
      hasMore: meta.hasMore ?? false,
      recommendedPollMs: meta.recommendedPollMs ?? 0,
    };
  }

  /**
   * Stream a batch's entries over a held connection instead of polling.
   *
   * Same cursor, same entries, same order as `results()` - the difference is
   * that the server pushes rather than the client asking, so a long batch costs
   * one request instead of hundreds against your rate limit.
   *
   * Use webhooks instead if you run a server with a public URL. This is for a
   * client with nowhere to deliver to: an agent on a laptop, a CLI, an edge
   * function.
   *
   * Reconnects are handled for you and are exact: the event id IS the cursor,
   * so a dropped connection resumes where it stopped with no duplicates and no
   * gaps. `maxReconnects` bounds how many times it will re-open before giving
   * up; the stream closes on its own when the batch reaches a terminal state.
   *
   * ```ts
   * for await (const entry of ed.stream<Person>(batch.batch_id)) {
   *   if (entry.status === 'succeeded') save(entry.data);
   * }
   * ```
   */
  async *stream<T = unknown>(
    batchId: string,
    options: { cursor?: string; signal?: AbortSignal; maxReconnects?: number } = {},
  ): AsyncGenerator<IResultEntry<T>, void, undefined> {
    const maxReconnects = options.maxReconnects ?? 10;
    let cursor = options.cursor ?? '';
    let reconnects = 0;

    for (;;) {
      const url =
        `${this.baseUrl}/batches/${batchId}/results` + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');

      const response = await this.doFetch(url, {
        headers: {
          'X-API-Key': this.apiKey,
          Accept: 'text/event-stream',
          // Where to resume. The server prefers this over ?cursor= for the
          // same reason a browser sends it: it is the more recent of the two.
          ...(cursor ? { 'Last-Event-ID': cursor } : {}),
        },
        // No timeout: the whole point is a connection that stays open. The
        // caller's signal is the way out.
        signal: options.signal ?? null,
      });

      if (!response.ok) {
        throw errorFor(response.status, await readJson(response), readRetryAfter(response.headers));
      }
      if (!response.body) throw new EasyDataError('the stream carried no body');

      let done = false;
      for await (const event of parseEventStream(response.body)) {
        if (event.id) cursor = event.id;

        switch (event.event) {
          case 'result':
            yield JSON.parse(event.data) as IResultEntry<T>;
            break;
          case 'complete':
            // The batch is terminal and we have all of it.
            done = true;
            break;
          case 'error':
            throw new EasyDataError(
              `stream failed: ${event.data}. Resume from cursor ${cursor}.`,
            );
          // `timeout` is the server ending a long stream on purpose. Falling
          // through re-opens from the cursor, which is exactly what it asked
          // for - a caller should never have to handle it.
        }
        if (done) return;
      }

      // The connection ended without a `complete`. Re-open from the cursor.
      if (++reconnects > maxReconnects) {
        throw new EasyDataError(
          `stream dropped ${reconnects} times without completing; last cursor ${cursor}`,
        );
      }
    }
  }

  /**
   * Block until a batch reaches a terminal state, and return it.
   *
   * Use `results()` when you want the rows: this polls the batch row, which
   * carries the counters and not the records.
   */
  async wait(batchId: string, options: { timeoutMs?: number } = {}): Promise<IBatch> {
    const deadline =
      options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
    for (;;) {
      const b = await this.batch(batchId);
      if (!LIVE.has(b.status)) return b;
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error(`batch ${batchId} was still ${b.status} after ${options.timeoutMs}ms`);
      }
      await sleep(b.recommended_poll_ms ?? 2000);
    }
  }

  // ----------------------------------------------------------------- account

  /** The allowance, the ceilings, and the webhook signing secret. */
  async account<T = Record<string, unknown>>(): Promise<T> {
    return (await this.request<T>('GET', '/account')).data;
  }

  /** Spend, by day and operation. */
  async usage<T = Record<string, unknown>>(
    filter: { from?: string; to?: string; externalId?: string } = {},
  ): Promise<T> {
    return (
      await this.request<T>('GET', '/usage', {
        query: { from: filter.from, to: filter.to, external_id: filter.externalId },
      })
    ).data;
  }

  // --------------------------------------------------------------- transport

  private async request<T>(
    method: string,
    path: string,
    init: {
      body?: unknown;
      query?: Record<string, unknown>;
      idempotencyKey?: string;
    } = {},
  ): Promise<{ data: T; meta: IMeta }> {
    let url = this.baseUrl + path;
    if (init.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      Accept: 'application/json',
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

    let last: EasyDataError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.doFetch(url, {
          method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        // The request never produced a response. Safe to repeat: a submission
        // carries an idempotency key, and everything else here is a read.
        last = new EasyDataError(`could not reach ${url}: ${(cause as Error).message}`, {
          body: cause,
        });
        if (attempt >= this.maxRetries) throw last;
        await sleep(backoff(attempt));
        continue;
      }

      this.rateLimits = readLimits(response.headers);

      const payload = await readJson(response);

      if (response.ok) {
        const envelope = (payload ?? {}) as Partial<IEnvelope<T>>;
        return {
          data: (envelope.data ?? payload) as T,
          meta: (envelope.meta ?? { requestId: '' }) as IMeta,
        };
      }

      const retryAfter = readRetryAfter(response.headers);
      const err = errorFor(response.status, payload, retryAfter);

      // 429 and 5xx are the two the server is telling us to try again on.
      // Everything else is a refusal repeating cannot fix, and retrying it
      // would only spend the rate budget on a certain no.
      if (!err.isRetryable || attempt >= this.maxRetries) throw err;
      last = err;
      await sleep(backoff(attempt, retryAfter));
    }

    throw last ?? new EasyDataError('request failed');
  }
}

/**
 * Sets the keys that were actually given.
 *
 * Absent is not the same as false: `enrich: false` is the caller saying so, and
 * dropping it because it is falsy would send a different request than the one
 * they wrote.
 */
function put(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v !== null) target[k] = v;
  }
}

function randomKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

/**
 * The server's own number when it sent one, otherwise exponential.
 *
 * Jittered because the failure that produces a retry storm is the one every
 * client sees at the same instant, and an unjittered backoff reconverges them
 * on the same second.
 */
function backoff(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds * 1000, 60_000);
  return Math.min(2 ** attempt * 1000, 30_000) * (0.5 + Math.random() / 2);
}

/**
 * The wire format of Server-Sent Events, as an async iterator.
 *
 * Hand-rolled rather than pulled in as a dependency, because the client has no
 * runtime dependencies and this is thirty lines: events are separated by a
 * blank line, fields are `name: value`, and a line starting with `:` is a
 * comment. Only the three fields this API sends are read.
 *
 * The buffer is flushed only on a blank line, so a `data:` split across two TCP
 * reads is reassembled rather than parsed as half an entry - which is the bug
 * every naive implementation has and which only shows up under load.
 */
async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string; id: string }, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split: number;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        const out = { event: 'message', data: '', id: '' };
        for (const line of raw.split('\n')) {
          if (!line || line.startsWith(':')) continue; // keepalive comment
          const i = line.indexOf(':');
          const field = i < 0 ? line : line.slice(0, i);
          // One optional space after the colon is part of the framing.
          const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
          if (field === 'event') out.event = value;
          else if (field === 'id') out.id = value;
          else if (field === 'data') out.data = out.data ? `${out.data}\n${value}` : value;
        }
        if (out.data || out.event !== 'message') yield out;
      }
    }
  } finally {
    // Releasing matters: an abandoned reader holds the socket open.
    reader.releaseLock();
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // A body that is not JSON is a proxy or gateway answering, not this API.
    // Keep it: it is the only evidence of what actually replied.
    return { error: { type: '', message: text.slice(0, 500) } };
  }
}

function readRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('Retry-After');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(n, 0) : undefined;
}

function readLimits(headers: Headers): IRateLimits {
  const num = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  return {
    limit: num('X-RateLimit-Limit'),
    remaining: num('X-RateLimit-Remaining'),
    reset: num('X-RateLimit-Reset'),
    concurrentBatchLimit: num('X-Concurrent-Batch-Limit'),
    concurrentBatchRemaining: num('X-Concurrent-Batch-Remaining'),
    syncLimit: num('X-Sync-Limit'),
    syncRemaining: num('X-Sync-Remaining'),
    syncReset: num('X-Sync-Reset'),
    syncConcurrentLimit: num('X-Sync-Concurrent-Limit'),
    syncConcurrentRemaining: num('X-Sync-Concurrent-Remaining'),
  };
}
