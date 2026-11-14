#!/usr/bin/env node
// PreToolUse on create_todo: the task methodology, checked before the call is made.
import { deny, emit, readState, readStdinJson, shortToolName } from './lib.mjs';

const MAX_TITLE = 120;

// Words a to-do title should not start with: articles, pronouns, fillers, bare nouns.
const NOT_VERBS = new Set(
  (
    'a an the my our your his her their this that these those some any new todo to-do task tasks ' +
    'thing things stuff misc reminder note idea maybe also and or but for with about of in on at ' +
    'it i we you there here asap urgent important'
  ).split(' '),
);

// A small, lenient list. Anything else passes unless it is in NOT_VERBS or looks like a noun or
// gerund (-tion, -ment, -ing, -ness) that is not itself a listed verb.
const VERBS = new Set(
  (
    'add ask attend back book bring build buy call cancel change check clean clear close collect ' +
    'complete configure confirm contact copy create decide delete deliver deploy design draft ' +
    'drop email enter estimate export extract fill finish fix follow forward gather get give go ' +
    'handle implement import install investigate invite join keep learn leave list log look ' +
    'make map meet merge migrate move notify open order organize pay pick plan post prepare ' +
    'print publish pull push put read record refactor register release remove rename reply ' +
    'report request research reserve reset resolve return review revise run schedule search ' +
    'send set setup share sign sort split start study submit summarize switch take talk test ' +
    'track transfer translate triage turn update upgrade upload use verify visit wash watch ' +
    'write ping sing spring string'
  ).split(' '),
);

export function checkTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') return 'the title is empty';
  const trimmed = title.trim();
  if (trimmed.length > MAX_TITLE) {
    return `the title is ${String(trimmed.length)} characters; keep it to ${String(MAX_TITLE)} or fewer (put detail in note)`;
  }
  const first = trimmed.split(/\s+/)[0];
  const word = first.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, '');
  if (word === '' || /^\d/.test(word)) {
    return 'the title must start with a verb (not a number or symbol)';
  }
  // Not Latin script (e.g. Hebrew): cannot judge, so allow.
  if (!/^[a-z'-]+$/.test(word)) return null;
  if (VERBS.has(word)) return null;
  if (NOT_VERBS.has(word) || /(tion|sion|ment|ness|ity|ing)$/.test(word)) {
    return `the title must start with a verb (got "${first}"); e.g. "Send the invoice", "Review PR 42"`;
  }
  return null;
}

/** Returns the list of problems, empty when the call is fine. */
export function checkCreateTodo(input, state) {
  const args = input && typeof input === 'object' ? input : {};
  const problems = [];
  const title = checkTitle(args.title);
  if (title) problems.push(title);
  // A topic (page) by its slug, as workspace_get lists them; null files it under Unsorted.
  const topicSet = (typeof args.topic === 'string' && args.topic !== '') || args.topic === null;
  if (!topicSet) {
    problems.push('topic is missing (a topic slug from workspace_get, or null for Unsorted)');
  }
  // create_todo is a strict schema with no 'someday' field: someday is an explicit dueAt: null.
  const hasDue = typeof args.dueAt === 'string' && args.dueAt !== '';
  const someday = args.dueAt === null;
  if (!hasDue && !someday) {
    problems.push(
      'dueAt is missing: give a due date, or say explicitly that it is someday by passing dueAt: null',
    );
  }
  if (typeof args.idempotencyKey !== 'string' || args.idempotencyKey === '') {
    problems.push('idempotencyKey is missing (a stable key makes retries safe)');
  }
  if (!state.searched) {
    problems.push(
      'no search_items call yet in this session: search for an existing to-do first to avoid duplicates',
    );
  }
  return problems;
}

export function decide(payload, env = process.env) {
  if (!payload || shortToolName(payload.tool_name) !== 'create_todo') return null;
  const problems = checkCreateTodo(payload.tool_input, readState(payload.session_id, env));
  if (problems.length === 0) return null;
  return deny(`TodoList task methodology: ${problems.join('; ')}.`);
}

if (process.argv[1]?.endsWith('pre-create-todo.mjs')) {
  emit(decide(await readStdinJson()));
}
