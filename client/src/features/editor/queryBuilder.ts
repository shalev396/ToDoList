/**
 * The filter step's bridge to react-querybuilder: fields and operators only from the server's
 * catalog (`FIELD_WHITELIST` / `OPERATORS`), and the two-way conversion between its group format
 * and the query's strict `RuleGroup` (no ids, no extra keys).
 */
import type { Field, RuleGroupType, RuleType } from 'react-querybuilder';
import type {
  CatalogDescription,
  CatalogField,
  Operator,
  QuerySource,
  Rule,
  RuleGroup,
  RuleValue,
} from '@api-types/builder.ts';
import { measureRuleGroup } from '@api-types/builder.ts';
import { fieldEntries } from './fieldOptions.ts';
import { defaultValue, fitsOperator, valueKind } from './ruleValue.ts';

const VALUELESS: ReadonlySet<string> = new Set(['null', 'notNull']);
const LISTS: ReadonlySet<string> = new Set(['in', 'notIn', 'allOf', 'noneOf']);

export function isValueless(operator: string): boolean {
  return VALUELESS.has(operator);
}
export function isListOperator(operator: string): boolean {
  return LISTS.has(operator);
}

/** The catalog's fields of one source. */
export function catalogFieldsOf(catalog: CatalogDescription, source: QuerySource): CatalogField[] {
  return catalog.fields[source];
}

/**
 * The querybuilder's field list for a source. `extra` names `props.*` fields already used by a
 * rule (the catalog has a pattern, not a list), so an existing rule is never silently dropped.
 * The `topic` field's values are the workspace's topics (`topics`): their ids, named.
 */
export function queryBuilderFields(
  catalog: CatalogDescription,
  source: QuerySource,
  extra: readonly string[] = [],
  topics: readonly { id: string; name: string }[] = [],
): Field[] {
  return fieldEntries(catalog, source, extra).map((entry) => {
    const values =
      entry.name === 'topic'
        ? topics.map((topic) => ({ name: topic.id, label: topic.name }))
        : entry.values?.map((value) => ({ name: value, label: value }));
    return {
      name: entry.name,
      label: entry.label ?? entry.name,
      datatype: entry.type,
      operators: entry.operators.map((name) => ({ name, label: name })),
      ...(values === undefined ? {} : { values }),
    };
  });
}

/** Every `props.*` field a group's rules use. */
export function propsFieldsIn(group: RuleGroup | undefined): string[] {
  const found = new Set<string>();
  const walk = (node: RuleGroup) => {
    for (const child of node.rules) {
      if ('combinator' in child) {
        walk(child);
      } else if (child.field.startsWith('props.') || child.field.startsWith('attr.')) {
        found.add(child.field);
      }
    }
  };
  if (group !== undefined) {
    walk(group);
  }
  return [...found];
}

function scalar(text: string, type: string | undefined): string | number | boolean {
  if (type === 'number' && text.trim() !== '' && Number.isFinite(Number(text))) {
    return Number(text);
  }
  if (type === 'boolean') {
    return text === 'true';
  }
  return text;
}

/** `a, b` → `['a', 'b']`: what a list operator's text box holds, as a value. */
export function parseList(text: string, type?: string): (string | number | boolean)[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => scalar(part, type));
}

export function formatValue(value: RuleValue | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }
  return Array.isArray(value) ? value.map(String).join(', ') : String(value);
}

type FieldTypes = ReadonlyMap<string, string>;

function ruleFromQb(rule: RuleType, types: FieldTypes): Rule {
  const operator = rule.operator as Operator;
  if (isValueless(operator)) {
    return { field: rule.field, operator };
  }
  const type = types.get(rule.field);
  const raw: unknown = rule.value;
  let value: RuleValue;
  const kind = valueKind(operator);
  if (kind === 'pair' || kind === 'relative' || kind === 'date' || kind === 'preset') {
    // A shape the operator needs (a pair, `[n, unit]`, a date): kept when it fits, else the default.
    value = fitsOperator(operator, raw)
      ? (raw as RuleValue)
      : (defaultValue(operator, type ?? 'string') ?? null);
  } else if (isListOperator(operator)) {
    value = Array.isArray(raw)
      ? (raw as RuleValue & unknown[])
      : parseList(typeof raw === 'string' ? raw : '', type);
  } else if (typeof raw === 'string') {
    value = scalar(raw, type);
  } else {
    value = (raw ?? null) as RuleValue;
  }
  return { field: rule.field, operator, value };
}

/** A querybuilder group as the query's `where`: only the keys the strict schema allows. */
export function fromQueryBuilder(group: RuleGroupType, types: FieldTypes): RuleGroup {
  const out: RuleGroup = {
    combinator: group.combinator === 'or' ? 'or' : 'and',
    rules: group.rules
      .filter((node): node is RuleType | RuleGroupType => typeof node !== 'string')
      .map((node) => ('rules' in node ? fromQueryBuilder(node, types) : ruleFromQb(node, types))),
  };
  if (group.not === true) {
    out.not = true;
  }
  return out;
}

/** The query's `where` as a querybuilder group (it accepts our shape; lists stay arrays). */
export function toQueryBuilder(group: RuleGroup | undefined): RuleGroupType {
  return (group ?? { combinator: 'and', rules: [] }) as RuleGroupType;
}

/** Field name → catalog type, for converting typed values. */
export function fieldTypes(fields: readonly Field[]): Map<string, string> {
  return new Map(
    fields.map((field) => [
      field.name,
      typeof field['datatype'] === 'string' ? field['datatype'] : 'string',
    ]),
  );
}

/** The values a top-level `in` rule of `field` selects (what a facet multi-select shows). */
export function facetSelection(where: RuleGroup | undefined, field: string): string[] {
  const rule = where?.rules.find(
    (node): node is Rule =>
      !('combinator' in node) && node.field === field && node.operator === 'in',
  );
  return Array.isArray(rule?.value) ? rule.value.map(String) : [];
}

/**
 * Sets the facet multi-select of one field as a top-level `field in [...]` rule: replaced when it
 * exists, removed when nothing is selected, and refused (unchanged) when it would pass the cap.
 */
export function withFacetSelection(
  where: RuleGroup | undefined,
  field: string,
  selected: readonly string[],
  maxRules: number,
): RuleGroup | undefined {
  const base: RuleGroup = where ?? { combinator: 'and', rules: [] };
  const others = base.rules.filter(
    (node) => 'combinator' in node || node.field !== field || node.operator !== 'in',
  );
  const rules: RuleGroup['rules'] =
    selected.length === 0 ? others : [...others, { field, operator: 'in', value: [...selected] }];
  const next: RuleGroup = { ...base, rules };
  if (measureRuleGroup(next).rules > maxRules) {
    return where;
  }
  return rules.length === 0 ? undefined : next;
}
