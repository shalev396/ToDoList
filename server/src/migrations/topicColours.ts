/**
 * Topic colours (topic-colours spec): every topic has a colour family. A topic stored without one
 * gets the next family its workspace's topics leave unused (`nextFamily`), walking the topics in
 * sidebar order (`order`, `createdAt`, `_id`), so the defaults get blue, orange and teal. A
 * family chosen by hand is kept. Counts only. Idempotent: once every topic has a colour there is
 * nothing to do.
 */
import { TOPIC_TABLE_NAME } from '../models/definitions/Topic.js';
import { nextFamily } from '../types/colours.js';
import { TOPIC_COLOURS, type TopicColour } from '../types/topics.js';
import type { Db, Migration } from './types.js';

type Doc = Record<string, unknown>;

function known(colour: unknown): TopicColour | null {
  return (TOPIC_COLOURS as readonly unknown[]).includes(colour) ? (colour as TopicColour) : null;
}

function time(value: unknown): number {
  return value instanceof Date ? value.getTime() : 0;
}

export const topicColours: Migration = {
  id: '2026-11-17-topic-colours',
  async run(db: Db) {
    const topics = db.collection<Doc>(TOPIC_TABLE_NAME);
    const workspaces = (await topics.distinct('workspaceId', { colour: { $in: [null] } })).filter(
      (id): id is string => typeof id === 'string',
    );
    let changed = 0;
    for (const workspaceId of workspaces) {
      const docs = (await topics.find({ workspaceId }).toArray()).sort(
        (a, b) =>
          Number(a['order']) - Number(b['order']) ||
          time(a['createdAt']) - time(b['createdAt']) ||
          String(a._id).localeCompare(String(b._id)),
      );
      const taken: (TopicColour | null)[] = [];
      for (const doc of docs) {
        let colour = known(doc['colour']);
        if (colour === null) {
          colour = nextFamily(taken);
          const { modifiedCount } = await topics.updateOne(
            { _id: doc._id, colour: { $in: [null] } },
            { $set: { colour } },
          );
          changed += modifiedCount;
        }
        taken.push(colour);
      }
    }
    return { topics: changed };
  },
};
