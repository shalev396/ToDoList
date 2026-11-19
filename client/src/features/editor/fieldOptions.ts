/**
 * The field picker's entries (H4): the catalog's fixed fields, the computed importance score, the
 * workspace's custom attributes and the provider fields its items carry, each with its type,
 * operators and group. Provider fields group by provider, so the picker shows the provider logo.
 */
import type {
  CatalogDescription,
  FieldType,
  Operator,
  QuerySource,
  Rule,
} from '@api-types/builder.ts';
import { defaultValue } from './ruleValue.ts';

export type FieldGroup = 'item' | 'importance' | 'attributes' | 'provider';

export interface FieldEntry {
  /** The query's field path: `dueAt`, `attr.effort`, `props.jira.storyPoints`. */
  name: string;
  type: FieldType;
  operators: readonly Operator[];
  group: FieldGroup;
  /** Provider fields: the provider's name, for the logo and the group heading. */
  provider?: string;
  /** Attributes and provider fields carry their own name; fixed fields are translated by name. */
  label?: string;
  values?: readonly string[];
  /** What to call a value that is not a word on its own (a topic's id is shown as its name). */
  valueLabels?: Readonly<Record<string, string>>;
}

/**
 * Every field a rule, sort or group may name for `source`. `used` lists `props.*` and `attr.*`
 * paths a query already uses that the workspace does not (or no longer) offer, so an existing rule
 * is never silently dropped from the picker.
 */
export function fieldEntries(
  catalog: CatalogDescription,
  source: QuerySource,
  used: readonly string[] = [],
): FieldEntry[] {
  const entries: FieldEntry[] = catalog.fields[source].map((field) => ({
    name: field.field,
    type: field.type,
    operators: field.operators,
    group: field.field === 'importance' ? 'importance' : 'item',
    ...(field.values === undefined ? {} : { values: field.values }),
  }));
  if (source === 'items') {
    for (const attribute of catalog.fields.attributes) {
      entries.push({
        name: attribute.field,
        type: attribute.type,
        operators: attribute.operators,
        group: 'attributes',
        label: attribute.name,
        ...(attribute.values === undefined ? {} : { values: attribute.values }),
      });
    }
  }
  for (const field of catalog.fields.provider) {
    entries.push({
      name: field.path,
      type: field.type,
      operators: catalog.operatorsByType[field.type],
      group: 'provider',
      provider: field.provider,
      label: field.label,
      ...(field.values === undefined ? {} : { values: field.values }),
    });
  }
  const known = new Set(entries.map((entry) => entry.name));
  for (const name of used) {
    if (known.has(name)) {
      continue;
    }
    known.add(name);
    const isAttribute = name.startsWith('attr.');
    entries.push({
      name,
      type: 'dynamic',
      operators: catalog.fields.dynamic.operators,
      group: isAttribute ? 'attributes' : 'provider',
      label: name.split('.').at(-1) ?? name,
      ...(isAttribute || !name.startsWith('props.') ? {} : { provider: name.split('.')[1] ?? '' }),
    });
  }
  return entries;
}

export interface FieldSection {
  id: string;
  group: FieldGroup;
  provider?: string;
  entries: FieldEntry[];
}

/** The picker's sections in order: item fields, importance, attributes, then one per provider. */
export function fieldSections(entries: readonly FieldEntry[]): FieldSection[] {
  const sections: FieldSection[] = [];
  const add = (id: string, group: FieldGroup, provider?: string): FieldSection => {
    let section = sections.find((entry) => entry.id === id);
    if (section === undefined) {
      section = { id, group, ...(provider === undefined ? {} : { provider }), entries: [] };
      sections.push(section);
    }
    return section;
  };
  for (const group of ['item', 'importance', 'attributes'] as const) {
    const inGroup = entries.filter((entry) => entry.group === group);
    if (inGroup.length > 0) {
      add(group, group).entries.push(...inGroup);
    }
  }
  for (const entry of entries.filter((item) => item.group === 'provider')) {
    const provider = entry.provider ?? '';
    add(`provider:${provider}`, 'provider', provider).entries.push(entry);
  }
  return sections;
}

/** The entry for a field path, or undefined. */
export function entryOf(entries: readonly FieldEntry[], name: string): FieldEntry | undefined {
  return entries.find((entry) => entry.name === name);
}

const PREFERRED: Readonly<Record<string, Operator>> = {
  date: 'inNext',
  number: '>=',
  string: 'contains',
  enum: 'in',
  array: 'in',
  boolean: '=',
  dynamic: '=',
};

/** The rule a freshly picked field starts with: a natural operator and its default value. */
export function newRule(entry: FieldEntry): Rule {
  const wanted = PREFERRED[entry.type];
  const operator =
    wanted !== undefined && entry.operators.includes(wanted)
      ? wanted
      : (entry.operators.find((candidate) => candidate === '=') ?? entry.operators[0] ?? '=');
  const value = defaultValue(operator, entry.type, entry.values ?? []);
  return value === undefined
    ? { field: entry.name, operator }
    : { field: entry.name, operator, value };
}

/** The topic field's values are the workspace's topic ids, shown by name. */
export function withTopicValues(
  entries: readonly FieldEntry[],
  topics: readonly { id: string; name: string }[],
): FieldEntry[] {
  return entries.map((entry) =>
    entry.name === 'topic' && topics.length > 0
      ? {
          ...entry,
          values: topics.map((topic) => topic.id),
          valueLabels: Object.fromEntries(topics.map((topic) => [topic.id, topic.name])),
        }
      : entry,
  );
}
