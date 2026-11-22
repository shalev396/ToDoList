/**
 * How many of the caller's items each subject would take, counted with the same rule the colours
 * use (`subjectOf`): an item's own Subject value first, else the first subject, in the order
 * given, with a pattern matching its effective title. Settings → Subjects shows the counts live
 * while a pattern is typed, so the subjects here are the request's, not the stored ones.
 *
 * The candidates come from one read through the caller's item access (ItemPolicy) and the
 * effective values (ItemQuery.effectiveStage); at most `scanMax` are counted.
 */
import mongoose from 'mongoose';

import { AppError } from '../../errors/AppError.js';
import { getItemRepository } from '../../models/index.js';
import { SUBJECT_ATTRIBUTE_KEY } from '../../types/attributes.js';
import { subjectOf, type ColourSubject } from '../../types/colours.js';
import { globSource } from '../../types/glob.js';
import { logger } from '../../services/logger.js';
import type { Caller } from '../base/Caller.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';
import { ItemQuery } from './ItemQuery.js';

export const SUBJECT_MATCH_SCAN_MAX = 5000;
/** Server-side limit of the count read: patterns are the viewer's, and a regex can backtrack. */
export const SUBJECT_MATCH_MAX_TIME_MS = 5000;
const MAX_TIME_MS_EXPIRED = 50;

export interface SubjectPatterns {
  name: string;
  patterns: readonly string[];
}

export class SubjectMatches {
  readonly #caller: Caller;
  readonly #scanMax: number;

  private constructor(caller: Caller, scanMax: number) {
    this.#caller = caller;
    this.#scanMax = scanMax;
  }

  static async count(
    caller: Caller,
    subjects: readonly SubjectPatterns[],
    scanMax: number = SUBJECT_MATCH_SCAN_MAX,
  ): Promise<{ counts: number[]; capped: boolean }> {
    return new SubjectMatches(caller, scanMax).#count(subjects);
  }

  /**
   * The candidate rows: the visible items whose own Subject or effective title could match. A
   * provider copy is left out while its to-do is visible, whatever the patterns, as an unfiltered
   * view leaves it out (H5): the absorption runs before the patterns. A read past its time limit
   * is a 503, as the query builder's (ItemQuery#run).
   */
  async #read(
    policy: ItemPolicy,
    names: readonly string[],
    patterns: readonly string[],
  ): Promise<Record<string, unknown>[]> {
    const caller = this.#caller;
    try {
      return await (
        await getItemRepository()
      ).aggregate(
        caller.workspaceId,
        [
          { $match: policy.itemFilter(caller.context) },
          ItemQuery.effectiveStage(),
          // Only what the counts and H5 read: the absorption sorts every visible item.
          {
            $project: {
              title: 1,
              [`overlay.attrs.${SUBJECT_ATTRIBUTE_KEY}`]: 1,
              'overlay.copyOf': 1,
            },
          },
          ...ItemPolicy.copyAbsorption(),
          {
            $match: {
              $or: [
                { [`overlay.attrs.${SUBJECT_ATTRIBUTE_KEY}`]: { $in: [...names] } },
                ...patterns.map((pattern) => ({
                  title: { $regex: globSource(pattern), $options: 'is' },
                })),
              ],
            },
          },
          { $sort: { _id: 1 } },
          { $limit: this.#scanMax + 1 },
          { $project: { title: 1, [`overlay.attrs.${SUBJECT_ATTRIBUTE_KEY}`]: 1 } },
        ],
        { maxTimeMS: SUBJECT_MATCH_MAX_TIME_MS },
      );
    } catch (error) {
      if (error instanceof mongoose.mongo.MongoServerError && error.code === MAX_TIME_MS_EXPIRED) {
        logger.warn('Subject match count hit its time limit', { workspaceId: caller.workspaceId });
        throw new AppError(503, 'Counting took too long; use shorter or fewer patterns');
      }
      throw error;
    }
  }

  async #count(
    subjects: readonly SubjectPatterns[],
  ): Promise<{ counts: number[]; capped: boolean }> {
    const caller = this.#caller;
    const scanMax = this.#scanMax;
    const counts = subjects.map(() => 0);
    if (subjects.length === 0) return { counts, capped: false };
    const policy = await ItemPolicy.for(caller);
    const names = subjects.map((subject) => subject.name);
    const patterns = subjects.flatMap((subject) => subject.patterns);
    const rows = await this.#read(policy, names, patterns);
    const request: ColourSubject[] = subjects.map((subject) => ({
      name: subject.name,
      family: 'gray',
      patterns: subject.patterns,
    }));
    for (const row of rows.slice(0, scanMax)) {
      const overlay = row['overlay'] as { attrs?: Record<string, unknown> } | undefined;
      const value = overlay?.attrs?.[SUBJECT_ATTRIBUTE_KEY];
      const title = typeof row['title'] === 'string' ? row['title'] : '';
      const subject = subjectOf(
        { subject: typeof value === 'string' ? value : null, title },
        request,
      );
      const index = subject === null ? -1 : request.indexOf(subject);
      if (index >= 0) counts[index] = (counts[index] ?? 0) + 1;
    }
    return { counts, capped: rows.length > scanMax };
  }
}
