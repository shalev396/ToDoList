import { useId, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import { useBuilderCatalog } from '@/api/queries/builder';
import { useFacets, useItem } from '@/api/queries/items';
import { useRemoveTravelRule, useSaveTravelRule, useTravelRules } from '@/api/queries/travel';
import { FormError } from '@/components/auth/auth-ui';
import { dateLocale } from '@/components/items/format';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { SentenceFilter } from '@/features/editor/SentenceFilter';
import { weekdayName } from '@/features/travel/travelPanel';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import type { CatalogDescription, Query } from '@api-types/builder';
import {
  RULE_DIRECTIONS,
  TRAVEL_MODES,
  type CreateTravelRuleRequest,
  type PlaceView,
  type RuleDirection,
  type TravelMode,
  type TravelRuleScope,
  type TravelRuleView,
} from '@api-types/travel.ts';
import { ConfirmRemove } from './PlacesSection';
import {
  NEW_RULE,
  newRuleRequestOf,
  queryOfScope,
  ruleScopeOf,
  type NewRuleDraft,
} from './travelForms';

/** A rule as edited: its sentence (a where-rule's), mode, trips and place. */
interface RuleDraft {
  query: Query;
  mode: TravelMode;
  direction: RuleDirection;
  placeId: string | null;
}

function draftOf(rule: TravelRuleView): RuleDraft {
  return {
    query: queryOfScope(rule.scope),
    mode: rule.mode,
    direction: rule.direction,
    placeId: rule.placeId,
  };
}

/** What the sentence filter needs: the fields, and what the workspace holds. */
interface SentenceContext {
  catalog: CatalogDescription;
  kinds: readonly string[] | undefined;
  providers: readonly string[] | undefined;
  topics: readonly { id: string; name: string }[];
}

/** "Every occurrence of …" or "One occurrence of …": a rule made by marking an event. */
function MarkedItem({ workspaceId, scope }: { workspaceId: string; scope: TravelRuleScope }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const itemId = scope.kind === 'series' || scope.kind === 'item' ? scope.itemId : null;
  const item = useItem(workspaceId, itemId);
  if (scope.kind === 'repeats') {
    return (
      <p className="text-sm" data-rule-item>
        <Trans
          i18nKey="travel.rules.repeats"
          values={{
            title: scope.title,
            weekday: weekdayName(scope.weekday, dateLocale(language)),
            time: `⁦${scope.startTime}⁩`,
          }}
          components={{ name: <bdi className="font-medium" /> }}
        />
      </p>
    );
  }
  const title = item.data?.title ?? t('travel.rules.unknownItem');
  return (
    <p className="text-sm" data-rule-item>
      <Trans
        i18nKey={scope.kind === 'series' ? 'travel.rules.series' : 'travel.rules.item'}
        values={{ title }}
        components={{ name: <bdi className="font-medium" /> }}
      />
    </p>
  );
}

/** "When [sentence] → by [mode], [there / back / both] to [place]". */
function RuleFields({
  workspaceId,
  scope,
  draft,
  onChange,
  context,
  places,
}: {
  workspaceId: string;
  /** The saved rule's scope; none: a new where-rule. */
  scope: TravelRuleScope | null;
  draft: RuleDraft;
  onChange: (patch: Partial<RuleDraft>) => void;
  context: SentenceContext;
  places: readonly PlaceView[];
}) {
  const { t } = useTranslation();
  return (
    // A condition's typed value keeps a word's width, so "where [Title] [contains] [Lecture]"
    // stays one line where it fits (an input would otherwise take the whole line).
    <div className="flex flex-col gap-3 [&_[data-sentence-condition]_input]:w-44">
      {scope === null || scope.kind === 'where' ? (
        <SentenceFilter
          query={draft.query}
          catalog={context.catalog}
          kinds={context.kinds}
          providers={context.providers}
          topics={context.topics}
          maxRules={context.catalog.caps.maxRules}
          template={t('travel.rules.template')}
          onChange={(query) => {
            onChange({ query });
          }}
        />
      ) : (
        <MarkedItem workspaceId={workspaceId} scope={scope} />
      )}
      <div
        role="group"
        aria-label={t('travel.rules.trip')}
        className="flex flex-wrap items-center gap-2 text-sm"
      >
        <ArrowRight
          className="size-4 shrink-0 text-muted-foreground rtl:rotate-180"
          aria-hidden="true"
        />
        <span>{t('travel.rules.by')}</span>
        <SelectField
          aria-label={t('travel.rules.mode')}
          className="w-auto"
          value={draft.mode}
          options={TRAVEL_MODES.map((mode) => ({ value: mode, label: t(`travel.modes.${mode}`) }))}
          onValueChange={(mode) => {
            const next = TRAVEL_MODES.find((entry) => entry === mode);
            if (next !== undefined) {
              onChange({ mode: next });
            }
          }}
        />
        <SelectField
          aria-label={t('travel.rules.direction')}
          className="w-auto"
          value={draft.direction}
          options={RULE_DIRECTIONS.map((direction) => ({
            value: direction,
            label: t(`travel.directions.${direction}`),
          }))}
          onValueChange={(direction) => {
            const next = RULE_DIRECTIONS.find((entry) => entry === direction);
            if (next !== undefined) {
              onChange({ direction: next });
            }
          }}
        />
        <span>{t('travel.rules.to')}</span>
        <SelectField
          aria-label={t('travel.rules.place')}
          className="w-auto max-w-full"
          value={draft.placeId ?? ''}
          options={[
            { value: '', label: t('travel.rules.ownPlace') },
            ...places.map((place) => ({
              value: place.id,
              label: <bdi>{place.name}</bdi>,
            })),
          ]}
          onValueChange={(placeId) => {
            onChange({ placeId: placeId === '' ? null : placeId });
          }}
        />
      </div>
    </div>
  );
}

/** The body a where-rule's draft saves as; null while its sentence has no condition. */
function requestOf(
  draft: RuleDraft,
  scope: TravelRuleScope | null,
): CreateTravelRuleRequest | null {
  const where = scope === null || scope.kind === 'where' ? ruleScopeOf(draft.query) : scope;
  if (where === null) {
    return null;
  }
  return { scope: where, mode: draft.mode, direction: draft.direction, placeId: draft.placeId };
}

function RuleCard({
  workspaceId,
  rule,
  context,
  places,
  onRemove,
}: {
  workspaceId: string;
  rule: TravelRuleView;
  context: SentenceContext;
  places: readonly PlaceView[];
  onRemove: (rule: TravelRuleView) => void;
}) {
  const { t } = useTranslation();
  const save = useSaveTravelRule(workspaceId);
  const [edited, setEdited] = useState<RuleDraft | null>(null);
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const draft = edited ?? draftOf(rule);
  const request = requestOf(draft, rule.scope);
  const saved = requestOf(draftOf(rule), rule.scope);
  const dirty = edited !== null && JSON.stringify(request) !== JSON.stringify(saved);
  const reset = () => {
    setEdited(null);
    setGeneration((value) => value + 1);
    setError(null);
  };
  return (
    <li
      data-travel-rule={rule.id}
      data-scope={rule.scope.kind}
      className="flex flex-col gap-3 rounded-lg border bg-card px-4 py-3"
    >
      <RuleFields
        key={generation}
        workspaceId={workspaceId}
        scope={rule.scope}
        draft={draft}
        context={context}
        places={places}
        onChange={(patch) => {
          setEdited({ ...draft, ...patch });
        }}
      />
      {rule.scope.kind === 'where' && request === null ? (
        <p className="text-[13px] text-muted-foreground">{t('travel.rules.needsCondition')}</p>
      ) : null}
      {error === null ? null : <FormError>{error}</FormError>}
      <div className="flex flex-wrap items-center gap-2">
        {dirty ? (
          <>
            <Button
              type="button"
              size="sm"
              className="max-md:h-11"
              disabled={request === null || save.isPending}
              onClick={() => {
                if (request === null) {
                  return;
                }
                setError(null);
                save.mutate(
                  { id: rule.id, body: request },
                  {
                    onSuccess: () => {
                      reset();
                      toast.success(t('travel.rules.saved'));
                    },
                    onError: (failure) => {
                      setError(errorMessage(t, failure, 'travel.rules.saveFailed'));
                    },
                  },
                );
              }}
            >
              {save.isPending ? t('travel.rules.saving') : t('travel.rules.save')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="max-md:h-11"
              disabled={save.isPending}
              onClick={reset}
            >
              {t('travel.rules.discard')}
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ms-auto text-destructive max-md:h-11"
          onClick={() => {
            onRemove(rule);
          }}
        >
          <Trash2 aria-hidden="true" />
          {t('travel.rules.remove')}
        </Button>
      </div>
    </li>
  );
}

function NewRule({
  workspaceId,
  defaultMode,
  context,
  places,
}: {
  workspaceId: string;
  defaultMode: TravelMode;
  context: SentenceContext;
  places: readonly PlaceView[];
}) {
  const { t } = useTranslation();
  const id = useId();
  const save = useSaveTravelRule(workspaceId);
  // Its mode stays null until he picks one, so it follows the default mode as Times changes it.
  const [draft, setDraft] = useState<NewRuleDraft>(NEW_RULE);
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const request = newRuleRequestOf(draft, defaultMode);
  return (
    <section
      aria-labelledby={`${id}-title`}
      data-new-travel-rule
      className="flex flex-col gap-3 rounded-lg border border-dashed bg-card px-4 py-4"
    >
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        {t('travel.rules.new')}
      </h3>
      <RuleFields
        key={generation}
        workspaceId={workspaceId}
        scope={null}
        draft={{ ...draft, mode: draft.mode ?? defaultMode }}
        context={context}
        places={places}
        onChange={(patch) => {
          setDraft((current) => ({ ...current, ...patch }));
        }}
      />
      {request === null ? (
        <p className="text-[13px] text-muted-foreground">{t('travel.rules.needsCondition')}</p>
      ) : null}
      {error === null ? null : <FormError>{error}</FormError>}
      <div>
        <Button
          type="button"
          size="sm"
          className="max-md:h-11"
          disabled={request === null || save.isPending}
          onClick={() => {
            if (request === null) {
              return;
            }
            setError(null);
            save.mutate(
              { body: request },
              {
                onSuccess: () => {
                  setDraft(NEW_RULE);
                  setGeneration((value) => value + 1);
                  toast.success(t('travel.rules.added'));
                },
                onError: (failure) => {
                  setError(errorMessage(t, failure, 'travel.rules.saveFailed'));
                },
              },
            );
          }}
        >
          <Plus aria-hidden="true" />
          {save.isPending ? t('travel.rules.adding') : t('travel.rules.add')}
        </Button>
      </div>
    </section>
  );
}

/**
 * Travel rules (travel-time spec, Concepts 3): "When [a sentence, the dashboards' logic builder]
 * → by [mode], [there / back / both]". Rules made by marking an event (every occurrence of a
 * series, or one occurrence) are listed too, with their event's title.
 */
export function TravelRulesSection({
  workspaceId,
  places,
  defaultMode,
}: {
  workspaceId: string;
  places: readonly PlaceView[];
  defaultMode: TravelMode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const rules = useTravelRules(workspaceId);
  const catalog = useBuilderCatalog(workspaceId);
  const facets = useFacets(workspaceId);
  const { topics } = useCurrentWorkspace();
  const remove = useRemoveTravelRule(workspaceId);
  const [removing, setRemoving] = useState<TravelRuleView | null>(null);
  const body = () => {
    if (rules.isError || catalog.isError) {
      return (
        <FormError>
          {t(rules.isError ? 'travel.loadFailed' : 'travel.rules.catalogFailed')}
        </FormError>
      );
    }
    if (rules.data === undefined || catalog.data === undefined) {
      return <Skeleton className="h-32 w-full rounded-lg" />;
    }
    const context: SentenceContext = {
      catalog: catalog.data,
      kinds: facets.data?.kinds,
      providers: facets.data?.providers,
      topics,
    };
    return (
      <>
        {rules.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('travel.rules.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rules.data.map((rule) => (
              <RuleCard
                key={rule.id}
                workspaceId={workspaceId}
                rule={rule}
                context={context}
                places={places}
                onRemove={setRemoving}
              />
            ))}
          </ul>
        )}
        <NewRule
          workspaceId={workspaceId}
          defaultMode={defaultMode}
          context={context}
          places={places}
        />
      </>
    );
  };
  return (
    <SettingsSection
      id={`${id}-title`}
      title={t('travel.rules.title')}
      hint={t('travel.rules.hint')}
      layout="stacked"
    >
      <div data-travel-rules className="flex flex-col gap-3">
        {body()}
      </div>
      <ConfirmRemove
        open={removing !== null}
        title={t('travel.rules.removeTitle')}
        body={t('travel.rules.removeBody')}
        confirm={t('travel.rules.removeConfirm')}
        onClose={() => {
          setRemoving(null);
        }}
        onConfirm={() => {
          if (removing === null) {
            return;
          }
          remove.mutate(removing.id, {
            onSuccess: () => {
              toast.success(t('travel.rules.removed'));
            },
            onError: (failure) => {
              toast.error(errorMessage(t, failure, 'travel.rules.removeFailed'));
            },
          });
        }}
      />
    </SettingsSection>
  );
}
