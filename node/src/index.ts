/**
 * EasyData - LinkedIn data enrichment.
 *
 * ```ts
 * import { EasyData } from '@easydata.win/sdk';
 *
 * const ed = new EasyData();  // reads EASYDATA_API_KEY
 *
 * // One record, in this call, at twice the credits.
 * const r = await ed.profiles.enrich.sync('https://linkedin.com/in/satyanadella');
 *
 * // A batch of any size, streamed as it drains.
 * const batch = await ed.profiles.enrich(urls, { externalId: 'crm-sync' });
 * for await (const entry of ed.results(batch.batch_id)) {
 *   if (entry.status === 'succeeded') save(entry.data);
 * }
 * ```
 *
 * Everything is a batch, including a batch of one, and you are billed per
 * record that resolves: a failure costs nothing.
 */

export { EasyData, DEFAULT_BASE_URL } from './client.js';
export type { IClientOptions, IOperationHandle } from './client.js';
export { EasyDataError, isEasyDataError } from './errors.js';
export {
  verify,
  verifyEd25519,
  VerificationError,
  DEFAULT_TOLERANCE,
} from './webhooks.js';
export type { HeaderBag } from './webhooks.js';
export type * from './types.js';
