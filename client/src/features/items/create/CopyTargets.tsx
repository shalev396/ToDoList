import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import { useCreateOptions, useCreateTargets } from '@/api/queries/providerCreate';
import { SourceDot } from '@/components/items/SourceDot';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { CreateTargetInfo } from '@api-types/providerCreate.ts';
import {
  answerStep,
  collapse,
  FUNNELS,
  focusStep,
  isDone,
  needsDueDate,
  optionsQueryFor,
  pathLabel,
  reopen,
  skipStep,
  startFunnel,
  type Choice,
  type FunnelState,
  type StepId,
  type StepSpec,
} from './funnel';
import { readRemembered } from './remembered';

export type Funnels = Readonly<Record<string, FunnelState>>;

export interface CopyTargetsProps {
  /** The to-do is private: the new item shows among the integration's items to every member. */
  isPrivate?: boolean;
  /** An integration to select at once (back from consenting). */
  preselect?: string | null;
  workspaceId: string;
  userId: string;
  /** The to-do has a due date (a calendar event needs one). */
  hasDueDate: boolean;
  value: Funnels;
  onChange: (next: Funnels) => void;
}

/** One step of an open funnel: its label, and the picker (or the toggle) for it. */
function StepRow({
  workspaceId,
  state,
  spec,
  update,
}: {
  workspaceId: string;
  state: FunnelState;
  spec: StepSpec;
  update: (next: FunnelState) => void;
}) {
  const { t } = useTranslation();
  const query = optionsQueryFor(state, spec.id);
  const active = state.active === spec.id;
  const answer = state.answers[spec.id];
  // Every step on show reads its options at once, so its list is ready when it is opened.
  const wanted = spec.kind !== 'toggle' && query !== null;
  const options = useCreateOptions(workspaceId, state.integrationId, wanted ? query : null);
  const list: ComboboxOption[] = useMemo(
    () =>
      (options.data?.options ?? []).map((option) => ({
        ...option,
        hint:
          option.hint === 'default' || option.hint === 'primary'
            ? t(`items.newTodo.hints.${option.hint}`)
            : option.hint,
      })),
    [options.data, t],
  );

  // A step with one choice (the only site, the only workspace) answers itself; a project
  // without a Team field leaves that step out.
  useEffect(() => {
    if (options.data === undefined || answer !== undefined || !active) {
      return;
    }
    if (spec.id === 'team' && (options.data.fieldId === null || list.length === 0)) {
      update(skipStep(state, 'team'));
    } else if (
      (spec.id === 'site' || spec.id === 'workspace') &&
      !spec.optional &&
      list.length === 1 &&
      list[0] !== undefined
    ) {
      update(answerStep(state, spec.id, { id: list[0].id, name: list[0].name }));
    }
  }, [options.data, answer, active, spec, list, state, update]);

  const label = t(`items.newTodo.steps.${spec.id}`);
  const noneLabel = spec.allowNone === true ? t(`items.newTodo.none.${spec.id}`) : undefined;

  if (spec.kind === 'toggle') {
    return (
      <div className="flex min-h-11 items-center justify-between gap-3 pointer-fine:min-h-9">
        <label htmlFor={`copy-${state.integrationId}-${spec.id}`} className="text-sm">
          {t('items.newTodo.assignMe')}
          <span className="ms-1 text-xs text-muted-foreground">
            ({t('items.newTodo.optional')})
          </span>
        </label>
        <Switch
          id={`copy-${state.integrationId}-${spec.id}`}
          checked={answer === true}
          onCheckedChange={(checked) => {
            update({ ...state, answers: { ...state.answers, [spec.id]: checked } });
          }}
        />
      </div>
    );
  }
  if (query === null) {
    return null;
  }
  const skipped = state.skipped.includes(spec.id);
  if (skipped) {
    return null;
  }

  const fieldId = options.data?.fieldId ?? undefined;
  const toChoice = (id: string): Choice => {
    const found = list.find((option) => option.id === id);
    return {
      id,
      name: found?.name ?? id,
      ...(spec.id === 'team' && fieldId !== undefined ? { fieldId } : {}),
    };
  };

  return (
    <div
      className="flex flex-col gap-1"
      data-funnel-step={spec.id}
      onFocusCapture={() => {
        if (!active) {
          update(focusStep(state, spec.id));
        }
      }}
    >
      <span className="text-xs text-muted-foreground">
        {label}
        {spec.optional ? ` (${t('items.newTodo.optional')})` : ''}
      </span>
      {options.isError ? (
        <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
          {t('items.newTodo.loadError')}
          <Button type="button" variant="ghost" size="sm" onClick={() => void options.refetch()}>
            {t('items.newTodo.retry')}
          </Button>
        </div>
      ) : spec.kind === 'multi' ? (
        <Combobox
          multiple
          aria-label={label}
          options={list}
          value={Array.isArray(answer) ? answer.map((choice) => choice.id) : []}
          placeholder={options.isLoading ? t('items.newTodo.loading') : label}
          searchPlaceholder={t('items.newTodo.search')}
          emptyText={t('items.newTodo.nothing')}
          onSelect={(ids) => {
            update(answerStep(state, spec.id, ids.map(toChoice)));
          }}
        />
      ) : (
        <Combobox
          aria-label={label}
          options={list}
          disabled={options.isLoading}
          value={
            answer === undefined ||
            answer === null ||
            typeof answer === 'boolean' ||
            Array.isArray(answer)
              ? null
              : answer.id
          }
          placeholder={
            options.isLoading
              ? t('items.newTodo.loading')
              : answer === null && noneLabel !== undefined
                ? noneLabel
                : label
          }
          searchPlaceholder={t('items.newTodo.search')}
          emptyText={t('items.newTodo.nothing')}
          noneLabel={noneLabel}
          defaultOpen={false}
          onSelect={(id) => {
            update(answerStep(state, spec.id, id === null ? null : toChoice(id)));
          }}
        />
      )}
    </div>
  );
}

/** The panel of an open funnel: its steps, in order. */
function FunnelPanel({
  workspaceId,
  state,
  update,
}: {
  workspaceId: string;
  state: FunnelState;
  update: (next: FunnelState) => void;
}) {
  const { t } = useTranslation();
  const steps = FUNNELS[state.provider];
  // Show a step once its parents are answered (the first, or the one being asked, always).
  const visible = steps.filter(
    (spec, index) =>
      index === 0 ||
      spec.id === state.active ||
      state.answers[spec.id] !== undefined ||
      steps
        .slice(0, index)
        .every(
          (before) =>
            before.optional ||
            state.answers[before.id] !== undefined ||
            state.skipped.includes(before.id),
        ),
  );
  return (
    <div
      className="mt-2 flex flex-col gap-3 rounded-lg border bg-sunken p-3"
      data-funnel={state.provider}
      data-funnel-integration={state.integrationId}
    >
      {visible.map((spec) => (
        <StepRow
          key={spec.id}
          workspaceId={workspaceId}
          state={state}
          spec={spec}
          update={update}
        />
      ))}
      {isDone(state) ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="self-end"
          data-funnel-close=""
          onClick={() => {
            update(collapse(state));
          }}
        >
          {t('items.newTodo.done')}
        </Button>
      ) : null}
    </div>
  );
}

/** One chip of "Also create in": idle, being asked, or done with its short path. */
/**
 * The "switch it to Read & write" hint: for a read-only target its owner can switch (never demo
 * data, which stays read-only; that one says it can't be written to).
 */
const readOnlyHint = (target: CreateTargetInfo): boolean =>
  !target.writable && target.mode === 'read' && target.canSwitchMode;

function Chip({
  workspaceId,
  target,
  state,
  hasDueDate,
  isPrivate,
  update,
  remove,
  add,
}: {
  workspaceId: string;
  target: CreateTargetInfo;
  state: FunnelState | undefined;
  hasDueDate: boolean;
  isPrivate: boolean;
  update: (next: FunnelState) => void;
  remove: () => void;
  add: () => void;
}) {
  const { t } = useTranslation();
  const source = t(`sources.${target.provider}`);
  const done = state !== undefined && isDone(state) && !state.open;
  const selected = state !== undefined;
  const path = state === undefined ? '' : pathLabel(state);
  const missingDue = selected && needsDueDate(target.provider) && !hasDueDate;
  return (
    <li
      className="min-w-0"
      data-chip={target.provider}
      data-chip-state={done ? 'done' : selected ? 'open' : 'idle'}
    >
      <div
        className={cn(
          'inline-flex max-w-full items-center rounded-full border text-sm',
          selected ? 'border-primary/50 bg-primary/5' : 'bg-background',
        )}
      >
        <button
          type="button"
          aria-pressed={selected}
          disabled={!target.writable}
          title={
            target.writable
              ? undefined
              : t(
                  readOnlyHint(target)
                    ? 'items.newTodo.readOnlyTarget'
                    : 'items.newTodo.notWritable',
                )
          }
          aria-label={
            done
              ? t('items.newTodo.change', { source })
              : selected
                ? t('items.newTodo.pick', { source })
                : source
          }
          className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-full px-3 pointer-fine:min-h-8"
          onClick={() => {
            if (state === undefined) {
              add();
            } else if (done) {
              update(reopen(state));
            } else {
              update(state.open ? collapse(state) : reopen(state));
            }
          }}
        >
          {done ? (
            <Check className="size-4 shrink-0 text-primary" aria-hidden="true" data-chip-check="" />
          ) : (
            <SourceDot source={target.provider} />
          )}
          <span className="truncate" data-chip-label="">
            {done ? `${source} · ${path}` : source}
          </span>
        </button>
        {selected ? (
          <button
            type="button"
            aria-label={t('items.newTodo.remove', { source })}
            className="me-1 inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-sunken hover:text-foreground"
            data-chip-remove=""
            onClick={remove}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {readOnlyHint(target) ? (
        <p className="ms-3 mt-1 text-xs text-muted-foreground" data-read-only-hint="">
          {t('items.newTodo.readOnlyTarget')}
        </p>
      ) : null}
      {target.needsConsent && selected ? (
        <p className="ms-3 mt-1 text-xs text-muted-foreground">{t('items.newTodo.needsConsent')}</p>
      ) : null}
      {isPrivate && selected && target.shared ? (
        <p className="ms-3 mt-1 text-xs text-muted-foreground" data-private-notice="">
          {t('items.newTodo.privateNotice', { source })}
        </p>
      ) : null}
      {missingDue ? (
        <p className="ms-3 mt-1 text-xs text-destructive" role="status">
          {t('items.newTodo.needsDue')}
        </p>
      ) : null}
      {state?.open === true ? (
        <FunnelPanel workspaceId={workspaceId} state={state} update={update} />
      ) : null}
    </li>
  );
}

/**
 * "Also create in": a chip per own integration that can create items. Selecting one walks its
 * funnel; finishing the last required step turns the chip into a check with its short path and
 * collapses the funnel; clicking it reopens; × removes it. Renders nothing for a viewer, or when
 * the user has no such integration.
 */
export function CopyTargets({
  workspaceId,
  userId,
  hasDueDate,
  value,
  onChange,
  isPrivate = false,
  preselect = null,
}: CopyTargetsProps) {
  const { t } = useTranslation();
  const targets = useCreateTargets(workspaceId, true);
  const info = targets.data;
  const preselected = useRef<string | null>(null);

  // Back from consenting: the target that asked for it is selected again, once.
  useEffect(() => {
    if (preselect === null || info === undefined || preselected.current === preselect) {
      return;
    }
    preselected.current = preselect;
    const target = info.targets.find((entry) => entry.integrationId === preselect);
    if (
      target?.writable === true &&
      target.mode === 'read_write' &&
      value[preselect] === undefined
    ) {
      onChange({
        ...value,
        [preselect]: startFunnel(target.provider, preselect, readRemembered(userId, preselect)),
      });
    }
  }, [preselect, info, value, onChange, userId]);

  if (info === undefined || info.targets.length === 0) {
    return null;
  }
  const set = (id: string, next: FunnelState | null) => {
    const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== id));
    onChange(next === null ? rest : { ...rest, [id]: next });
  };
  return (
    <section
      className="flex flex-col gap-2"
      aria-label={t('items.newTodo.alsoIn')}
      data-also-create=""
    >
      <h3 className="text-sm font-medium">{t('items.newTodo.alsoIn')}</h3>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {info.targets.map((target) => (
          <Chip
            key={target.integrationId}
            workspaceId={workspaceId}
            target={target}
            state={value[target.integrationId]}
            hasDueDate={hasDueDate}
            isPrivate={isPrivate}
            update={(next) => {
              set(target.integrationId, next);
            }}
            remove={() => {
              set(target.integrationId, null);
            }}
            add={() => {
              set(
                target.integrationId,
                startFunnel(
                  target.provider,
                  target.integrationId,
                  readRemembered(userId, target.integrationId),
                ),
              );
            }}
          />
        ))}
      </ul>
    </section>
  );
}

export type { StepId };
