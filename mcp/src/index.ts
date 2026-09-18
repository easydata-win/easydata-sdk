#!/usr/bin/env node
/**
 * The EasyData MCP server.
 *
 * It gives an agent the API as tools, over stdio. There is no integration code
 * to write: point a client at `npx -y @easydata.win/mcp` with EASYDATA_API_KEY in
 * the environment and the operations are available.
 *
 * Three things shape it, and each is a decision rather than a default:
 *
 * 1. **Every tool says what it costs.** An agent choosing between a lookup and
 *    a search cannot weigh them without the price, and a tool description is
 *    the only place it will read one. The numbers are derived from the
 *    published credit rule, so they are the same ones the docs quote.
 *
 * 2. **Spending is bounded, in this process.** EASYDATA_MAX_CREDITS caps what
 *    one session may spend. An agent in a loop is the failure mode a spend cap
 *    exists for, and the organization's monthly ceiling is far too coarse to
 *    catch it: by the time that trips, the month is gone.
 *
 * 3. **The bulk path is a submit and a separate read**, not a tool that blocks
 *    for ten minutes. A batch of five thousand does not fit in a tool call, and
 *    an agent that can submit, do something else and come back is the point of
 *    the batch model.
 */

import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { EasyData, isEasyDataError } from '@easydata.win/sdk';
import type { IResultEntry, Operation } from '@easydata.win/sdk';

/**
 * The version this server reports over the protocol.
 *
 * Read from package.json rather than written here. A hardcoded copy drifts the
 * moment a release bumps one and not the other - 1.0.2 shipped announcing
 * itself as 1.0.0 - and the only place that shows up is a client's diagnostics,
 * which is exactly where a wrong version number costs the most.
 *
 * createRequire because this is an ES module and dist/ sits one level under the
 * package root, wherever npm installed it.
 */
const VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require('../package.json').version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// ---------------------------------------------------------------- the budget

/**
 * A spend ledger for this process.
 *
 * Counted from what the API REPORTS as charged, never from what we estimated:
 * a failure costs nothing and an estimate that assumed otherwise would refuse
 * work the customer was never billed for. The check before a call is therefore
 * against the price of the call about to be made, which is the only figure
 * known in advance.
 */
class Budget {
  spent = 0;

  constructor(readonly ceiling: number) {}

  /** Throws when the next call cannot fit. A no-op when no ceiling is set. */
  check(about: number, what: string): void {
    if (this.ceiling <= 0) return;
    if (this.spent + about > this.ceiling) {
      throw new Error(
        `this session's credit budget is spent: ${this.spent.toFixed(1)} of ` +
          `${this.ceiling} used, and ${what} costs up to ${about}. Raise ` +
          'EASYDATA_MAX_CREDITS or start a new session. Nothing was charged for this call.',
      );
    }
  }

  record(credits: number): void {
    this.spent += credits;
  }

  get remaining(): number | null {
    return this.ceiling > 0 ? Math.max(this.ceiling - this.spent, 0) : null;
  }
}

// ------------------------------------------------------------------ pricing
//
// The base prices, from the published credit rule: one credit is one request to
// LinkedIn. A search ROW is 0.5 because a row is a stub and a page of 100 is one
// request. A synchronous request costs double, and it is a multiplier.

const SYNC_MULTIPLIER = 2;

const PRICES: Record<Operation, { base: number; unit: 'target' | 'row' }> = {
  'profiles.enrich': { base: 1, unit: 'target' },
  'profiles.activity': { base: 1, unit: 'target' },
  'profiles.posts': { base: 1, unit: 'target' },
  'profiles.comments': { base: 1, unit: 'target' },
  'profiles.reactions': { base: 1, unit: 'target' },
  'companies.enrich': { base: 1, unit: 'target' },
  'posts.enrich': { base: 1, unit: 'target' },
  'sales.search.people': { base: 0.5, unit: 'row' },
  // Same row price, plus a floor of one credit per chunk of the company list -
  // a chunk that matched nobody is still one request. Not modelled in the
  // estimate below, which is what a full run costs: the floor only ever makes a
  // sparse run cost MORE than the rows suggest, and an estimate that assumed it
  // would overstate every ordinary one.
  'sales.search.employees': { base: 0.5, unit: 'row' },
  'sales.search.companies': { base: 0.5, unit: 'row' },
};

/** A flat surcharge per person we reach an email verdict about, `not_found` included. */
const EMAIL_SURCHARGE = 4;

function priceOf(op: Operation, count: number, sync: boolean, findEmails = false): number {
  const spec = PRICES[op];
  let per = spec.base;
  if (findEmails) per += EMAIL_SURCHARGE;
  if (sync) per *= SYNC_MULTIPLIER;
  return per * count;
}

// -------------------------------------------------------------------- output

/**
 * What a tool hands back.
 *
 * The record, plus what it cost and what is left. An agent that cannot see the
 * running total cannot budget, and "you have spent 40 of 100" in the tool
 * result is the only place it will see one.
 */
function ok(payload: unknown, budget: Budget, charged?: number): {
  content: { type: 'text'; text: string }[];
} {
  const meta: Record<string, unknown> = {};
  if (charged !== undefined) meta.credits_used = charged;
  meta.session_credits_spent = Number(budget.spent.toFixed(2));
  if (budget.remaining !== null) meta.session_credits_remaining = Number(budget.remaining.toFixed(2));

  return {
    content: [{ type: 'text', text: JSON.stringify({ result: payload, usage: meta }, null, 2) }],
  };
}

function fail(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Turns any throw into a tool error an agent can act on.
 *
 * An API refusal is reported with its type and its field, because those are
 * what distinguish "fix your input and retry" from "wait" from "this will never
 * work". A stack trace is none of those.
 */
async function guard<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try {
    return await fn();
  } catch (e) {
    if (isEasyDataError(e)) {
      const parts = [e.message];
      if (e.type) parts.push(`type=${e.type}`);
      if (e.field) parts.push(`field=${e.field}`);
      if (e.requestId) parts.push(`request_id=${e.requestId}`);
      if (e.type === 'quota_exhausted') {
        parts.push('The monthly allowance is spent. This will not succeed until it resets.');
      }
      if (e.type === 'email_unverified') {
        parts.push('A member of the organization must confirm their email address. Not a quota problem.');
      }
      if (e.type === 'rate_limited') {
        parts.push('Retried already and still limited. Wait before calling again.');
      }
      if (e.type === 'insufficient_scope') {
        parts.push(
          'The API key is read-only and this tool needs to submit work. Waiting will ' +
            'not help and neither will retrying: the key has to be replaced with one ' +
            'carrying the write scope. Stop and tell the user.',
        );
      }
      return fail(parts.join(' | '));
    }
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Strips an entry down to what an agent should reason about. */
function readable(entry: IResultEntry | null | undefined): unknown {
  if (!entry) return null;
  if (entry.status !== 'succeeded') {
    return {
      status: entry.status,
      input: entry.input,
      error: entry.error,
      // Spelled out because it is the single most useful fact about a failure
      // and an agent should not have to infer it from a zero.
      credits_used: 0,
      note: 'This target failed. A failure costs nothing.',
    };
  }
  return { status: entry.status, input: entry.input, data: entry.data, page: entry.page };
}

// ---------------------------------------------------------------------- main

function main(): void {
  const apiKey = process.env.EASYDATA_API_KEY;
  if (!apiKey) {
    // stderr, not stdout: stdout is the JSON-RPC channel and anything else
    // written there corrupts the very first message.
    console.error(
      'EASYDATA_API_KEY is not set. Mint a key in the console at https://easydata.win ' +
        'and put it in the MCP server\'s env block.',
    );
    process.exit(1);
  }

  const ed = new EasyData({ apiKey, baseUrl: process.env.EASYDATA_BASE_URL });
  const budget = new Budget(Number(process.env.EASYDATA_MAX_CREDITS ?? 0) || 0);

  const server = new McpServer(
    { name: 'easydata', version: VERSION },
    {
      instructions:
        'EasyData returns fresh LinkedIn data: people, companies, posts and Sales ' +
        'Navigator searches.\n\n' +
        'Costs are in CREDITS and every tool states its own. One credit is one request ' +
        'to LinkedIn. A failed lookup costs nothing.\n\n' +
        'Use the `*_lookup` tools for one entity: they answer in the call, and cost double ' +
        'for that. For more than a handful of targets use `submit_batch`, then ' +
        '`batch_results` - a batch of 50,000 is the same call as a batch of 1, results are ' +
        'readable while it is still running, and it is half the price of the same lookups ' +
        'one at a time.\n\n' +
        'Prefer a search over guessing URLs: `search_people` takes a pasted Sales Navigator ' +
        'search URL and returns rows at 0.5 credits each.',
    },
  );

  // ------------------------------------------------------------- one entity

  const lookups: {
    name: string;
    op: Operation;
    what: string;
    takes: string;
    emails: boolean;
  }[] = [
    {
      name: 'profile_lookup',
      op: 'profiles.enrich',
      what: "one person's full LinkedIn profile: name, headline, current and past roles, education, location, skills",
      takes: 'a LinkedIn profile URL or public identifier, e.g. https://linkedin.com/in/satyanadella or satyanadella',
      emails: true,
    },
    {
      name: 'company_lookup',
      op: 'companies.enrich',
      what: "one company's LinkedIn page: name, industry, size, headquarters, website, description",
      takes: 'a LinkedIn company URL or slug, e.g. https://linkedin.com/company/microsoft or microsoft',
      emails: false,
    },
    {
      name: 'post_lookup',
      op: 'posts.enrich',
      what: 'one LinkedIn post: its text, author, and engagement counts',
      takes: 'a LinkedIn post URL or activity URN',
      emails: false,
    },
  ];

  for (const l of lookups) {
    const price = priceOf(l.op, 1, true);
    const withEmail = priceOf(l.op, 1, true, true);

    server.registerTool(
      l.name,
      {
        title: l.name.replace(/_/g, ' '),
        description:
          `Look up ${l.what}. Answers in this call.\n\n` +
          `Takes ${l.takes}.\n\n` +
          `Costs ${price} credits` +
          (l.emails ? `, or ${withEmail} with find_emails` : '') +
          `. That is double the batch price, which is what buying an immediate answer ` +
          `costs. For more than about five targets use submit_batch instead.\n\n` +
          `A target that cannot be resolved costs nothing and comes back with an error ` +
          `rather than throwing.`,
        inputSchema: {
          target: z.string().min(1).describe(l.takes),
          ...(l.emails
            ? {
                find_emails: z
                  .boolean()
                  .optional()
                  .describe(
                    `Also find a work email address for this person. Adds a flat ${EMAIL_SURCHARGE} ` +
                      'per verdict (doubled here, as everything on this path is), charged even when ' +
                      'the honest answer is that the domain has no mailbox for them. A person we ' +
                      'could not look up at all is free.',
                  ),
              }
            : {}),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args) => {
        const findEmails = Boolean((args as { find_emails?: boolean }).find_emails);
        return guard(async () => {
          budget.check(priceOf(l.op, 1, true, findEmails), l.name);

          const out = await ed.submitSync(
            pathFor(l.op),
            (args as { target: string }).target,
          );
          budget.record(out.credits_used ?? 0);

          if (!out.complete) {
            return ok(
              {
                complete: false,
                batch_id: out.batch_id,
                note:
                  'The deadline expired before this finished. It is still being worked at ' +
                  'priority - read it with batch_results using this batch_id. Nothing was lost.',
              },
              budget,
              out.credits_used,
            );
          }
          return ok(readable(out.result), budget, out.credits_used);
        });
      },
    );
  }

  // ------------------------------------------------------ activity and search

  server.registerTool(
    'profile_activity',
    {
      title: 'profile activity',
      description:
        "Recent activity from one person's LinkedIn profile: their posts, their comments, " +
        'their reactions, or all three.\n\n' +
        `Costs ${priceOf('profiles.activity', 1, true)} credits. Returns one page.\n\n` +
        'Use this to understand what somebody is currently working on or talking about.',
      inputSchema: {
        target: z.string().min(1).describe('A LinkedIn profile URL or public identifier.'),
        kind: z
          .enum(['all', 'posts', 'comments', 'reactions'])
          .default('all')
          .describe('Which activity to fetch. "all" is the combined feed.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ target, kind }) =>
      guard(async () => {
        const op: Operation =
          kind === 'posts'
            ? 'profiles.posts'
            : kind === 'comments'
              ? 'profiles.comments'
              : kind === 'reactions'
                ? 'profiles.reactions'
                : 'profiles.activity';

        budget.check(priceOf(op, 1, true), 'profile_activity');
        const out = await ed.submitSync(pathFor(op), target);
        budget.record(out.credits_used ?? 0);
        return ok(readable(out.result), budget, out.credits_used);
      }),
  );

  for (const [name, op, what] of [
    ['search_people', 'sales.search.people', 'people'],
    ['search_companies', 'sales.search.companies', 'companies'],
  ] as const) {
    server.registerTool(
      name,
      {
        title: name.replace(/_/g, ' '),
        description:
          `Run a Sales Navigator search for ${what} and return the matching rows.\n\n` +
          'Takes a Sales Navigator search URL - build the search in LinkedIn, copy the URL, ' +
          'paste it here. The filters in the URL are the search.\n\n' +
          `Costs ${PRICES[op].base} credits per ROW at the batch price, doubled here. A row is a ` +
          'stub; enrich the ones you care about with the lookup tools.\n\n' +
          'This call returns ONE page of up to 100 rows. For a deeper search use submit_batch ' +
          'with this same URL and a max_results - it pages, and at half this price.',
        inputSchema: {
          search_url: z.string().url().describe('A Sales Navigator search URL, pasted whole.'),
          max_results: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(25)
            .describe('Rows to return, up to one page of 100. You are billed per row returned.'),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ search_url, max_results }) =>
        guard(async () => {
          budget.check(priceOf(op, max_results, true), name);
          const out = await ed.submitSync(pathFor(op), search_url, { maxResults: max_results });
          budget.record(out.credits_used ?? 0);
          return ok(readable(out.result), budget, out.credits_used);
        }),
    );
  }

  server.registerTool(
    'search_employees',
    {
      title: 'search employees',
      description:
        'Run a Sales Navigator people search restricted to a list of companies, and return the ' +
        'matching rows.\n\n' +
        'This is the tool for "who at these companies does X". Take the search URL from ' +
        'LinkedIn as usual - the filters in it are the search - and pass the LinkedIn company ' +
        'ids to restrict it to. search_companies is how you get those ids; a company NAME is ' +
        'not one, and guessing an id returns somebody else\'s employees.\n\n' +
        'The URL must NOT already have a company filter on it: this call supplies that filter, ' +
        'and one already there is refused rather than merged.\n\n' +
        `Costs ${PRICES['sales.search.employees'].base} credits per ROW at the batch price, ` +
        'doubled here, and never less than 2 for the call - the request happens whether or not ' +
        'anybody matched.\n\n' +
        'ONE page of up to 100 rows, and about 50 companies. For a longer list or a deeper ' +
        'search use submit_batch with operation sales.search.employees, which chunks the list ' +
        'into as many searches as it needs and costs half as much.',
      inputSchema: {
        search_url: z
          .string()
          .url()
          .describe('A Sales Navigator PEOPLE search URL, pasted whole, with no company filter.'),
        companies: z
          .array(z.union([z.number().int().positive(), z.string().min(1)]))
          .min(1)
          .max(50)
          .describe('LinkedIn company ids. About 50 fit in one search; send more via submit_batch.'),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe('Rows to return, up to one page of 100. You are billed per row returned.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ search_url, companies, max_results }) =>
      guard(async () => {
        const op: Operation = 'sales.search.employees';
        budget.check(priceOf(op, max_results, true), 'search_employees');
        const out = await ed.submitSync(
          pathFor(op),
          { searchUrl: search_url, companies },
          { maxResults: max_results },
        );
        budget.record(out.credits_used ?? 0);
        return ok(readable(out.result), budget, out.credits_used);
      }),
  );

  // ----------------------------------------------------------------- batches

  server.registerTool(
    'submit_batch',
    {
      title: 'submit batch',
      description:
        'Submit many targets at once. Returns a batch_id immediately - nothing has run yet.\n\n' +
        'This is the right tool for more than about five targets: it is HALF the price of the ' +
        'same lookups one at a time, and it takes 1 to 50,000 targets with no change in shape.\n\n' +
        'Read the results with batch_results, which can be called while the batch is still ' +
        'running and returns what has landed so far.\n\n' +
        'Prices per target: profile/company/post 1 credit, search 0.5 per row, plus a flat ' +
        `${EMAIL_SURCHARGE} per person when find_emails is set. A failed target costs nothing.`,
      inputSchema: {
        operation: z
          .enum([
            'profiles.enrich',
            'profiles.activity',
            'profiles.posts',
            'profiles.comments',
            'profiles.reactions',
            'companies.enrich',
            'posts.enrich',
            'sales.search.people',
            'sales.search.employees',
            'sales.search.companies',
          ])
          .describe('Which operation to run over every target.'),
        targets: z
          .array(z.string().min(1))
          .min(1)
          .max(50_000)
          .describe('URLs or identifiers, one per target. A search takes search URLs.'),
        companies: z
          .array(
            z.union([
              z.number().int().positive(),
              z.string().min(1),
              z.object({
                id: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
                name: z.string().min(1).optional(),
              }),
            ]),
          )
          .min(1)
          .max(1000)
          .optional()
          .describe(
            'sales.search.employees only, where it is required: the companies to filter the ' +
              'search by, up to 1000. The search runs once per ~50 of them, because LinkedIn ' +
              'takes the filter inside the search URL and a URL has a length. An entry is a ' +
              'numeric LinkedIn company id, a company NAME, or an object carrying either. ' +
              'Prefer an id - it filters exactly, and search_companies is how you get one. A ' +
              'name works too, matched as fuzzy text the way a person typing into Sales ' +
              'Navigator gets it, so it may pull in a company you did not mean; each ' +
              'chunk.companies entry in the results says which kind of chip it was.',
          ),
        max_results: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Paged operations only: rows per search target. This IS the billing count.'),
        find_emails: z
          .boolean()
          .optional()
          .describe(
            `Find a work email for every person returned. Flat +${EMAIL_SURCHARGE} per verdict.`,
          ),
        external_id: z
          .string()
          .optional()
          .describe('Your own label for this run. It comes back on the batch and in usage.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ operation, targets, companies, max_results, find_emails, external_id }) =>
      guard(async () => {
        const op = operation as Operation;
        const units = PRICES[op].unit === 'row' ? targets.length * (max_results ?? 25) : targets.length;
        budget.check(priceOf(op, units, false, Boolean(find_emails)), 'submit_batch');

        // The company list rides on each target rather than beside them,
        // because it is part of what the target IS: this search, across these
        // companies. Two search URLs in one submission each get the list.
        const sent =
          op === 'sales.search.employees'
            ? targets.map((searchUrl) => ({ searchUrl, companies: companies ?? [] }))
            : targets;

        const batch = await ed.submit(pathFor(op), sent, {
          maxResults: max_results,
          findEmails: find_emails,
          externalId: external_id,
        });

        return ok(
          {
            batch_id: batch.batch_id,
            status: batch.status,
            total: batch.total,
            note:
              'Submitted. Nothing has been charged yet - you are billed per record as it ' +
              'resolves. Call batch_results with this batch_id; it is readable while the ' +
              'batch is still running.',
          },
          budget,
        );
      }),
  );

  server.registerTool(
    'batch_results',
    {
      title: 'batch results',
      description:
        'Read a batch\'s results. Free.\n\n' +
        'Readable WHILE the batch is still processing - it returns what has landed so far, so ' +
        'there is no reason to wait for the batch to finish before looking. `status` tells you ' +
        'whether more is coming; `next_cursor` continues from where this page stopped.\n\n' +
        'Call it again with the cursor until has_more is false and status is a terminal one.',
      inputSchema: {
        batch_id: z.string().min(1).describe('From submit_batch.'),
        cursor: z
          .string()
          .optional()
          .describe('The next_cursor from a previous call. Omit for the first page.'),
        limit: z.number().int().min(1).max(100).default(100).describe('Entries per page.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ batch_id, cursor, limit }) =>
      guard(async () => {
        // ONE page, deliberately: a tool call that blocks until a 50,000-row
        // batch finishes is a tool call that times out. resultsPage is the
        // client's single-read layer, so the cursor the agent gets back is the
        // real one rather than something reconstructed here.
        const page = await ed.resultsPage(batch_id, { cursor, pageSize: limit });
        return ok(
          {
            status: page.status,
            entries: page.entries.map(readable),
            next_cursor: page.nextCursor,
            has_more: page.hasMore,
            still_running: page.recommendedPollMs > 0,
            note:
              page.hasMore || page.recommendedPollMs > 0
                ? 'More is coming. Call again with next_cursor.'
                : 'This batch is finished and you have read all of it.',
          },
          budget,
        );
      }),
  );

  server.registerTool(
    'batch_status',
    {
      title: 'batch status',
      description:
        "A batch's counters: how many targets succeeded, failed and are still pending, and " +
        'what it has cost so far. Free.\n\n' +
        'Use batch_results when you want the records - this returns only the progress.',
      inputSchema: { batch_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ batch_id }) =>
      guard(async () => {
        const b = await ed.batch(batch_id);
        return ok(
          {
            batch_id: b.batch_id,
            status: b.status,
            total: b.total,
            succeeded: b.succeeded,
            failed: b.failed,
            pending: b.pending,
            results_available: b.results_available,
            credits_used: b.credits_used,
            still_running: b.status === 'queued' || b.status === 'processing',
          },
          budget,
        );
      }),
  );

  server.registerTool(
    'account_usage',
    {
      title: 'account usage',
      description:
        'What is left of the monthly allowance, the rate ceilings, and what has been spent. Free.\n\n' +
        'Call this before a large batch to check the allowance will cover it.',
      inputSchema: {
        from: z.string().optional().describe('YYYY-MM-DD. Defaults to 30 days ago.'),
        to: z.string().optional().describe('YYYY-MM-DD. Defaults to today.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ from, to }) =>
      guard(async () => {
        const [account, usage] = await Promise.all([
          ed.account(),
          ed.usage({ from, to }),
        ]);
        return ok({ account, usage }, budget);
      }),
  );

  const transport = new StdioServerTransport();
  void server.connect(transport);
}

/**
 * Operation name to path: the dots are the slashes.
 *
 * `profiles.enrich` is `/profiles/enrich` and `sales.search.people` is
 * `/sales/search/people`, which is not a coincidence - the operation name IS
 * the path, and a lookup table here would be a second copy of the routing.
 */
function pathFor(op: Operation): string {
  return '/' + op.split('.').join('/');
}

main();
