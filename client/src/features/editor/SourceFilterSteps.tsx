import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QueryBuilder, type RuleGroupType } from 'react-querybuilder';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SelectField } from '@/components/ui/select';
import type { CatalogDescription, Query, RuleGroup } from '@api-types/builder';
import { CONTAINER_TYPES } from '@api-types/domain';
import type { FacetsResponseData } from '@api-types/items';
import type { ConnectorInfo, SavedView } from '@api-types/dashboards';
import { LOCAL_CONNECTOR, MAX_RULE_DEPTH } from '@api-types/builder';
import type { IntegrationStatusView } from '@api-types/api-contracts';
import { ProviderIcon, type IconName } from '@/features/landing/ProviderIcon';
import { PROVIDER_REGISTRY } from '@/features/integrations/providers';
import { canAddRule, countRules } from './caps';
import { fieldEntries } from './fieldOptions';
import { connectorProviders, type BlockDraft } from './draft';
import {
  AddGroupAction,
  AddRuleAction,
  CombinatorSelector,
  FieldSelector,
  NotToggle,
  OperatorSelector,
  RemoveAction,
  ValueEditor,
  type QbContext,
} from './qbControls';
import {
  facetSelection,
  fieldTypes,
  fromQueryBuilder,
  propsFieldsIn,
  queryBuilderFields,
  toQueryBuilder,
  withFacetSelection,
} from './queryBuilder';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useFacets } from '@/api/queries/items';
import { Button } from '@/components/ui/button';
import { SentenceFilter } from './SentenceFilter';
import { toSentence } from './sentence';
import { FormRow } from './FormRow';

interface StepProps {
  draft: BlockDraft;
  onChange: (patch: Partial<BlockDraft>) => void;
  catalog: CatalogDescription;
}

const DEFAULT_QUERY: Query = { source: 'items', limit: 50 };

function patchQuery(draft: BlockDraft, patch: Partial<Query>): Partial<BlockDraft> {
  const next = { ...(draft.query ?? DEFAULT_QUERY), ...patch };
  for (const key of Object.keys(next) as (keyof Query)[]) {
    if (next[key] === undefined) {
      Reflect.deleteProperty(next, key);
    }
  }
  return { query: next };
}

function FacetChecks({
  legend,
  field,
  values,
  where,
  maxRules,
  onChange,
}: {
  legend: string;
  field: string;
  values: readonly string[];
  where: RuleGroup | undefined;
  maxRules: number;
  onChange: (where: RuleGroup | undefined) => void;
}) {
  const { t } = useTranslation();
  const selected = facetSelection(where, field);
  if (values.length === 0) {
    return null;
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {values.map((value) => {
          const id = `facet-${field}-${value}`;
          return (
            <div key={value} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={selected.includes(value)}
                onCheckedChange={(checked) => {
                  const next =
                    checked === true ? [...selected, value] : selected.filter((v) => v !== value);
                  onChange(withFacetSelection(where, field, next, maxRules));
                }}
              />
              <label htmlFor={id} className="min-h-6 text-sm max-md:min-h-11 max-md:leading-[44px]">
                {t(field === 'kind' ? `editor.kinds.${value}` : `sources.${value}`, {
                  defaultValue: value,
                })}
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function iconOf(provider: string): IconName | null {
  return provider in PROVIDER_REGISTRY
    ? PROVIDER_REGISTRY[provider as keyof typeof PROVIDER_REGISTRY].icon
    : null;
}

/** What the Source step knows of the block's sources besides the member's own connections. */
export interface ConnectorContext {
  /** Every integration connector on the dashboard: provider and owner (never an account). */
  info: Readonly<Record<string, ConnectorInfo>>;
  /** A member's name, for another member's connector. */
  memberName: (userId: string) => string;
  /** For "Adding X shares its items with everyone in <workspace>". */
  workspaceName: string;
  /** Which of the member's own integrations are on some block already (no need to ask). */
  shared: ReadonlySet<string>;
  /** A connector's provider: the member's own integrations and the dashboard's connectors. */
  providerOf: (id: string) => string | undefined;
}

/**
 * Connectors (PERMISSIONS-V2): the block's sources. "All sources" (no connectors field): each
 * viewer sees what they may. Otherwise the picked ones only: the member's own connections (each
 * with its provider icon and account label; two Jira accounts show twice) and their local to-dos;
 * adding a connection that is not shared yet asks first, since it shares its items with the whole
 * workspace. Another member's connector already on the block shows as "Dana's Jira": it can be
 * removed, never added. Picked, then all unpicked: the block reads nothing ("No source").
 */
function ConnectorChecks({
  integrations,
  connectors,
  context,
  onChange,
}: {
  integrations: readonly IntegrationStatusView[] | undefined;
  /** Undefined: all sources. */
  connectors: readonly string[] | undefined;
  context: ConnectorContext;
  onChange: (connectors: string[] | undefined) => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<IntegrationStatusView | null>(null);
  const own = integrations ?? [];
  const ownIds = new Set(own.map((integration) => integration.id));
  const picked = connectors ?? [];
  const others = picked.filter((id) => {
    const info = context.info[id];
    return id !== LOCAL_CONNECTOR && !ownIds.has(id) && info !== undefined && !info.removed;
  });
  const toggle = (id: string, checked: boolean) => {
    onChange(checked ? [...picked, id] : picked.filter((value) => value !== id));
  };
  const row = (
    id: string,
    label: React.ReactNode,
    checked: boolean,
    onCheck: (next: boolean) => void,
  ) => (
    <div key={id} className="flex items-center gap-2">
      <Checkbox
        id={`connector-${id}`}
        checked={checked}
        onCheckedChange={(next) => {
          onCheck(next === true);
        }}
      />
      <label
        htmlFor={`connector-${id}`}
        className="flex min-h-6 items-center gap-1.5 text-sm max-md:min-h-11"
      >
        {label}
      </label>
    </div>
  );
  return (
    <fieldset className="flex flex-col gap-2" data-connectors>
      <legend className="mb-1 text-sm font-medium">{t('editor.source.connectors')}</legend>
      <p className="text-[13px] text-muted-foreground">{t('editor.source.connectorsHint')}</p>
      {row(
        'all',
        <span data-connector-all>{t('editor.source.allSources')}</span>,
        connectors === undefined,
        (checked) => {
          onChange(checked ? undefined : []);
        },
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {own.map((integration) => {
          const icon = iconOf(integration.provider);
          return row(
            integration.id,
            <>
              {icon === null ? null : <ProviderIcon name={icon} className="size-4" />}
              <span data-connector-label>{integration.accountLabel}</span>
            </>,
            picked.includes(integration.id),
            (checked) => {
              if (checked && !context.shared.has(integration.id)) {
                setConfirming(integration);
              } else {
                toggle(integration.id, checked);
              }
            },
          );
        })}
        {row(
          LOCAL_CONNECTOR,
          <span data-connector-local>{t('sources.local')}</span>,
          picked.includes(LOCAL_CONNECTOR),
          (checked) => {
            toggle(LOCAL_CONNECTOR, checked);
          },
        )}
        {others.map((id) => {
          const info = context.info[id];
          const provider = info?.provider ?? null;
          const icon = provider === null ? null : iconOf(provider);
          const owner = info?.ownerUserId ?? null;
          return row(
            id,
            <>
              {icon === null ? null : <ProviderIcon name={icon} className="size-4" />}
              <span data-connector-foreign>
                {t('editor.source.foreignConnector', {
                  name: owner === null ? '' : context.memberName(owner),
                  provider: provider === null ? '' : t(`sources.${provider}`),
                })}
              </span>
            </>,
            true,
            (checked) => {
              toggle(id, checked);
            },
          );
        })}
      </div>
      {others.length === 0 ? null : (
        <p className="text-[13px] text-muted-foreground">{t('editor.source.foreignHint')}</p>
      )}
      {connectors?.length === 0 ? (
        <p role="status" data-connectors-none className="text-[13px] text-destructive">
          {t('editor.source.noneHint')}
        </p>
      ) : null}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null);
          }
        }}
      >
        <AlertDialogContent data-share-confirm>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('editor.source.shareTitle', { name: confirming?.accountLabel ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('editor.source.shareBody', {
                name: confirming?.accountLabel ?? '',
                workspace: context.workspaceName,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('editor.source.shareCancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming !== null) {
                  toggle(confirming.id, true);
                }
                setConfirming(null);
              }}
            >
              {t('editor.source.shareConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </fieldset>
  );
}

/** Step 1: items or containers, kinds and providers from the facets, or a saved view. */
export function SourceStep({
  draft,
  onChange,
  catalog,
  facets,
  views,
  integrations,
  connectorContext,
}: StepProps & {
  facets: FacetsResponseData | undefined;
  integrations: readonly IntegrationStatusView[] | undefined;
  views: readonly SavedView[] | undefined;
  connectorContext: ConnectorContext;
}) {
  const { t } = useTranslation();
  const usingView = draft.savedViewId !== null;
  const query = draft.query ?? DEFAULT_QUERY;
  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('editor.source.mode')}</legend>
        <RadioGroup
          value={usingView ? 'view' : 'query'}
          onValueChange={(mode) => {
            onChange(
              mode === 'view'
                ? { savedViewId: views?.[0]?.id ?? '' }
                : { savedViewId: null, ...patchQuery(draft, {}) },
            );
          }}
          aria-label={t('editor.source.mode')}
        >
          {(['query', 'view'] as const).map((mode) => (
            <label key={mode} className="flex min-h-6 items-center gap-2 text-sm max-md:min-h-11">
              <RadioGroupItem value={mode} />
              {t(`editor.source.${mode}`)}
            </label>
          ))}
        </RadioGroup>
      </fieldset>
      {usingView ? (
        <FormRow label={t('editor.source.view')} htmlFor="source-view">
          <SelectField
            id="source-view"
            value={draft.savedViewId ?? ''}
            onValueChange={(value) => {
              onChange({ savedViewId: value });
            }}
            options={
              views === undefined || views.length === 0
                ? [{ value: '', label: t('editor.source.noViews') }]
                : views.map((view) => ({ value: view.id, label: view.title }))
            }
          />
        </FormRow>
      ) : (
        <>
          <FormRow label={t('editor.source.source')} htmlFor="source-kind">
            <SelectField
              id="source-kind"
              value={query.source}
              options={[
                { value: 'items', label: t('editor.source.items') },
                { value: 'containers', label: t('editor.source.containers') },
              ]}
              onValueChange={(value) => {
                const source = value === 'containers' ? 'containers' : 'items';
                onChange(
                  patchQuery(draft, {
                    source,
                    where: undefined,
                    containerType: undefined,
                    ...(source === 'containers'
                      ? { dateRange: undefined, dateField: undefined }
                      : {}),
                  }),
                );
              }}
            />
          </FormRow>
          {query.source === 'containers' ? (
            <FormRow label={t('editor.source.containerType')} htmlFor="source-container-type">
              <SelectField
                id="source-container-type"
                value={query.containerType ?? ''}
                options={[
                  { value: '', label: t('editor.source.anyType') },
                  ...CONTAINER_TYPES.map((type) => ({
                    value: type,
                    label: t(`editor.source.types.${type}`, { defaultValue: type }),
                  })),
                ]}
                onValueChange={(next) => {
                  const value = CONTAINER_TYPES.find((type) => type === next);
                  onChange(patchQuery(draft, { containerType: value }));
                }}
              />
            </FormRow>
          ) : (
            <FacetChecks
              legend={t('editor.source.kinds')}
              field="kind"
              values={facets?.kinds ?? []}
              where={query.where}
              maxRules={catalog.caps.maxRules}
              onChange={(where) => {
                onChange(patchQuery(draft, { where }));
              }}
            />
          )}
          <ConnectorChecks
            integrations={integrations}
            connectors={draft.connectors}
            context={connectorContext}
            onChange={(connectors) => {
              // The connectors decide the sources: a provider rule keeps only their providers.
              const offered = connectorProviders(connectors, connectorContext.providerOf);
              const chosen = facetSelection(query.where, 'source.provider');
              const kept =
                offered === undefined
                  ? chosen
                  : chosen.filter((provider) => offered.includes(provider));
              onChange({
                connectors,
                ...(kept.length === chosen.length
                  ? {}
                  : patchQuery(draft, {
                      where: withFacetSelection(
                        query.where,
                        'source.provider',
                        kept,
                        catalog.caps.maxRules,
                      ),
                    })),
              });
            }}
          />
          <FacetChecks
            legend={t('editor.source.providers')}
            field="source.provider"
            values={
              connectorProviders(draft.connectors, connectorContext.providerOf) ??
              facets?.providers ??
              []
            }
            where={query.where}
            maxRules={catalog.caps.maxRules}
            onChange={(where) => {
              onChange(patchQuery(draft, { where }));
            }}
          />
        </>
      )}
    </div>
  );
}

/** Step 2: react-querybuilder with the catalog's fields, the date range and `$page` references. */
export function FilterStep({
  draft,
  onChange,
  catalog,
  variables,
  providers,
}: StepProps & {
  variables: readonly string[];
  /** The providers of the block's chosen connectors; undefined: all sources (the facets). */
  providers?: readonly string[] | undefined;
}) {
  const { t } = useTranslation();
  const { topics, workspace } = useCurrentWorkspace();
  const facets = useFacets(workspace?.id ?? null);
  // The sentence is the default; Advanced is the rule tree. A filter a sentence cannot show opens
  // in Advanced.
  const [advanced, setAdvanced] = useState(
    draft.query !== undefined && !toSentence(draft.query).ok,
  );
  if (draft.savedViewId !== null || draft.query === undefined) {
    return <p className="text-sm text-muted-foreground">{t('editor.filter.viewNote')}</p>;
  }
  const query = draft.query;
  const fields = queryBuilderFields(catalog, query.source, propsFieldsIn(query.where), topics);
  const types = fieldTypes(fields);
  const rules = query.where === undefined ? 0 : countRules(query.where);
  const context: QbContext = {
    variables,
    dynamicValues: catalog.dynamicValues,
    datePresets: catalog.datePresets,
    full: !canAddRule(query.where),
    maxLevel: MAX_RULE_DEPTH - 2,
    fields: fieldEntries(catalog, query.source, propsFieldsIn(query.where)),
  };
  const range = typeof query.dateRange === 'string' ? query.dateRange : '';
  return (
    <div className="flex flex-col gap-5">
      {advanced ? null : (
        <SentenceFilter
          query={query}
          catalog={catalog}
          kinds={facets.data?.kinds}
          providers={providers ?? facets.data?.providers}
          topics={topics}
          maxRules={catalog.caps.maxRules}
          onAdvanced={() => {
            setAdvanced(true);
          }}
          onChange={(next) => {
            onChange({ query: next });
          }}
        />
      )}
      <div data-query-builder className="flex flex-col gap-2" hidden={!advanced}>
        {advanced ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] text-muted-foreground" aria-live="polite">
              {t('editor.filter.count', { n: rules, max: catalog.caps.maxRules })}
            </p>
            {toSentence(query).ok ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="max-md:h-11"
                onClick={() => {
                  setAdvanced(false);
                }}
              >
                {t('logic.sentence.simple')}
              </Button>
            ) : null}
          </div>
        ) : null}
        <QueryBuilder
          fields={fields}
          query={toQueryBuilder(query.where)}
          context={context}
          listsAsArrays
          showNotToggle
          resetOnFieldChange
          resetOnOperatorChange={false}
          onQueryChange={(next: RuleGroupType) => {
            const where = fromQueryBuilder(next, types);
            onChange(patchQuery(draft, { where: where.rules.length === 0 ? undefined : where }));
          }}
          onAddRule={(rule, _path, current) =>
            canAddRule(fromQueryBuilder(current, types)) ? rule : false
          }
          controlElements={{
            fieldSelector: FieldSelector,
            operatorSelector: OperatorSelector,
            combinatorSelector: CombinatorSelector,
            valueEditor: ValueEditor,
            addRuleAction: AddRuleAction,
            addGroupAction: AddGroupAction,
            removeRuleAction: RemoveAction,
            removeGroupAction: RemoveAction,
            notToggle: NotToggle,
          }}
          controlClassnames={{
            queryBuilder: 'flex flex-col gap-2',
            ruleGroup: 'flex flex-col gap-2 rounded-md border bg-card p-3',
            header: 'flex flex-wrap items-center gap-2',
            body: 'flex flex-col gap-2',
            rule: 'flex flex-wrap items-center gap-2',
          }}
        />
      </div>
      {query.source === 'items' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormRow label={t('editor.filter.dateRange')} htmlFor="filter-range">
            <SelectField
              id="filter-range"
              value={range}
              options={[
                { value: '', label: t('editor.filter.anyDate') },
                ...catalog.datePresets.map((preset) => ({
                  value: preset,
                  label: t(`editor.presets.${preset}`, { defaultValue: preset }),
                })),
                ...variables.map((variable) => ({ value: variable, label: variable })),
              ]}
              onValueChange={(value) => {
                const preset = catalog.datePresets.find((p) => p === value);
                onChange(
                  patchQuery(draft, {
                    dateRange: preset ?? (value === '' ? undefined : value),
                  }),
                );
              }}
            />
          </FormRow>
          <FormRow label={t('editor.filter.dateField')} htmlFor="filter-date-field">
            <SelectField
              id="filter-date-field"
              value={query.dateField ?? ''}
              options={[
                { value: '', label: t('editor.filter.dateFieldDefault') },
                ...(['dueAt', 'startAt', 'any'] as const).map((field) => ({
                  value: field,
                  label: t(`editor.dateFields.${field}`),
                })),
              ]}
              onValueChange={(next) => {
                const value = (['dueAt', 'startAt', 'any'] as const).find(
                  (field) => field === next,
                );
                onChange(patchQuery(draft, { dateField: value }));
              }}
            />
          </FormRow>
        </div>
      ) : null}
    </div>
  );
}
