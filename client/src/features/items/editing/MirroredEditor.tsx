import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CircleAlert, ExternalLink, Lock, Pencil } from 'lucide-react';
import { useIntegrations } from '@/api/queries/integrations';
import { useUpdateItem } from '@/api/queries/items';
import { useMembers } from '@/api/queries/members';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SaveStatus, type SaveState } from '@/components/ui/save-status';
import { SelectField } from '@/components/ui/select';
import { dateLocale } from '@/components/items/format';
import { useLanguage } from '@/hooks/useLanguage';
import { cn } from '@/lib/utils';
import { pathTo, ROUTES } from '@/router/routes';
import { integrationAnchor } from '@/features/integrations/anchor';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import type { ItemDetail, OverridableField, UpdateItemRequestBody } from '@api-types/api-contracts';
import type { ItemStatus } from '@api-types/domain';
import { ownerOf } from '../owner';
import { dateInZone } from '../zonedDate';
import {
  clearOverrideBody,
  draftOf,
  editPlan,
  isTimedEvent,
  patchOf,
  statusChoices,
  withStart,
  type EditDraft,
  type EditField,
  type EditPlan,
  type FieldPlan,
  type ProviderLock,
} from './editPlan';
import { saveProblemOf, type SaveProblem } from './saveProblem';

const PRIORITIES = ['4', '3', '2', '1', '0'] as const;

/** Field names in the reader's language, as one list ("title and status"). */
function useFieldList() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  return (fields: readonly string[]): string =>
    new Intl.ListFormat(language, { type: 'conjunction' }).format(
      fields.map((field) => t(`items.edit.fields.${field}`, { defaultValue: field })),
    );
}

/** The name the hints give the integration's owner: theirs, or "the person who connected it". */
function useOwnerName(item: ItemDetail): string {
  const { t } = useTranslation();
  const { workspace } = useCurrentWorkspace();
  const members = useMembers(workspace?.id ?? '');
  const owner = ownerOf(item.ownerUserId, members.data);
  return owner?.kind === 'member' ? owner.name : t('items.edit.someoneElse');
}

/** One clear sentence on why the provider's fields are locked (and, for the owner, where to fix it). */
function LockHint({
  id,
  lock,
  item,
  source,
}: {
  id: string;
  lock: ProviderLock;
  item: ItemDetail;
  source: string;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const owner = useOwnerName(item);
  const toCard =
    item.editing.ownsIntegration &&
    item.integrationId !== null &&
    (lock === 'read_only' || lock === 'reconnect');
  return (
    <p
      id={id}
      data-provider-lock={lock}
      className="flex items-start gap-1.5 text-[13px] text-muted-foreground"
    >
      <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {t(`items.edit.lock.${lock}`, { source, owner })}
        {toCard && item.integrationId !== null ? (
          <>
            {' '}
            <Link
              to={`${pathTo(ROUTES.INTEGRATIONS, language)}#${integrationAnchor(item.integrationId)}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
              data-provider-lock-link=""
            >
              {t('items.edit.toCard', { source })}
            </Link>
          </>
        ) : null}
      </span>
    </p>
  );
}

/** What went wrong with a save, in words, with the provider's link where the change belongs. */
function ProblemNote({
  problem,
  item,
  source,
}: {
  problem: SaveProblem;
  item: ItemDetail;
  source: string;
}) {
  const { t } = useTranslation();
  const list = useFieldList();
  const owner = useOwnerName(item);
  if (problem.kind === 'guests') {
    return null;
  }
  const link = (url: string) => (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
    >
      {t('items.sheet.openInSource', { source })}
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  );
  if (problem.kind === 'partial') {
    const lines = (['written', 'refused', 'uncertain'] as const).filter(
      (part) => problem[part].length > 0,
    );
    return (
      <div
        role="alert"
        data-save-problem="partial"
        className="flex flex-col gap-1.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-[13px]"
      >
        <p className="flex items-center gap-1.5 font-medium text-destructive">
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {t('items.edit.partial.title', { source })}
        </p>
        {lines.length === 0 ? null : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 ps-5">
            {lines.map((part) => (
              <li key={part} data-partial={part}>
                {t(`items.edit.partial.${part}`, { fields: list(problem[part]), source })}
              </li>
            ))}
          </ul>
        )}
        <span className="ps-5">{link(item.openIn.url)}</span>
      </div>
    );
  }
  return (
    <div role="alert" data-save-problem={problem.key} className="flex flex-col gap-1 text-[13px]">
      <p className="flex items-start gap-1.5 text-destructive">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        {t(problem.key, { source, owner, fields: list(problem.fields) })}
      </p>
      {problem.openIn === null ? null : <span className="ps-5">{link(problem.openIn.url)}</span>}
    </div>
  );
}

/** The draft of one field set back to its provider's value (after "Use <provider>'s value"). */
function sourceDraft(
  field: OverridableField,
  source: ItemDetail['sourceValues'],
  timeZone: string,
): Partial<EditDraft> {
  if (source === null) {
    return {};
  }
  switch (field) {
    case 'title':
      return { title: source.title };
    case 'status':
      return { status: source.status };
    case 'dueAt':
      return { dueDate: source.dueAt === null ? '' : dateInZone(source.dueAt, timeZone) };
    case 'startAt':
      return { startDate: source.startAt === null ? '' : dateInZone(source.startAt, timeZone) };
    case 'priority':
      return { priority: source.priority === null ? '' : String(source.priority) };
  }
}

/** A field's label, its "Only in TodoList" tag, and the control under it. */
function FieldShell({
  plan,
  labelFor,
  hereId,
  label,
  source,
  onUseSource,
  sourceValue,
  clearing,
  children,
}: {
  plan: FieldPlan;
  labelFor: string;
  /** The id of the "Only in TodoList" tag (the control is described by it). */
  hereId: string;
  label: string;
  source: string;
  /** "Use <provider>'s value"; undefined when there's nothing to go back to. */
  onUseSource: (() => void) | undefined;
  /** That value, as words ("none" when the provider has none). */
  sourceValue: string;
  clearing: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5"
      data-edit-field={plan.field}
      data-origin={plan.origin}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Label htmlFor={labelFor}>{label}</Label>
        {plan.origin === 'override' ? (
          <span
            id={hereId}
            data-only-here={plan.overridden ? 'set' : ''}
            title={t('items.edit.onlyHereHint', { source })}
            className={cn(
              'inline-flex h-5 items-center rounded-full border px-2 text-[12px] whitespace-nowrap',
              plan.overridden
                ? 'border-primary/40 bg-accent/45 text-foreground'
                : 'text-muted-foreground',
            )}
          >
            {t('items.edit.onlyHere')}
            <span className="sr-only">. {t('items.edit.onlyHereHint', { source })}</span>
          </span>
        ) : null}
      </div>
      {children}
      {plan.overridden && plan.editable && onUseSource !== undefined ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto self-start p-0 text-[13px] max-md:min-h-11"
          disabled={clearing}
          data-use-source={plan.field}
          onClick={onUseSource}
        >
          {t('items.edit.useSource', { source, value: sourceValue })}
        </Button>
      ) : null}
    </div>
  );
}

/** The form: every field of the plan, locked ones disabled and pointing at the one hint. */
function EditForm({
  item,
  plan,
  timeZone,
  source,
  lockId,
  saving,
  onSave,
  onCancel,
  onUseSource,
  problem,
  status: saveStatus,
}: {
  item: ItemDetail;
  plan: EditPlan;
  timeZone: string;
  source: string;
  lockId: string;
  saving: boolean;
  onSave: (body: UpdateItemRequestBody | null) => void;
  onCancel: () => void;
  onUseSource: (field: OverridableField, then: () => void) => void;
  problem: ReactNode;
  status: ReactNode;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const ids = useId();
  const [draft, setDraft] = useState<EditDraft>(() => draftOf(item, timeZone));
  const set = (patch: Partial<EditDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const fieldOf = (field: EditField) => plan.fields.find((entry) => entry.field === field);
  const timed = isTimedEvent(item);
  const lockedBy = (entry: FieldPlan) =>
    entry.origin === 'provider' && !entry.editable && plan.lock !== null ? lockId : undefined;
  const sourceAction = (entry: FieldPlan) => {
    const { field } = entry;
    if (field === 'endAt' || clearOverrideBody(field, item.sourceValues) === null) {
      return undefined;
    }
    return () => {
      onUseSource(field, () => {
        // The field shows the provider's value it now reads as.
        set(sourceDraft(field, item.sourceValues, timeZone));
      });
    };
  };
  /** The provider's own value of a field, as the "Use <provider>'s value" action names it. */
  const sourceText = (field: EditField): string => {
    const values = item.sourceValues;
    if (values === null || field === 'endAt') {
      return t('items.edit.sourceNone');
    }
    switch (field) {
      case 'title':
        return values.title;
      case 'status':
        return t(`items.statuses.${values.status}`);
      case 'priority':
        return values.priority === null
          ? t('items.edit.sourceNone')
          : t(`items.edit.priorities.${String(values.priority)}`);
      case 'dueAt':
      case 'startAt': {
        const at = values[field];
        return at === null
          ? t('items.edit.sourceNone')
          : new Intl.DateTimeFormat(dateLocale(language), {
              day: 'numeric',
              month: 'short',
              timeZone,
            }).format(new Date(at));
      }
    }
  };
  const shell = (entry: FieldPlan, labelFor: string, children: ReactNode) => (
    <FieldShell
      key={entry.field}
      plan={entry}
      labelFor={labelFor}
      hereId={`${ids}-${entry.field}-here`}
      label={t(
        entry.field === 'startAt' && item.kind === 'event' && !timed
          ? 'items.edit.day'
          : `items.edit.fields.${entry.field}`,
      )}
      source={source}
      onUseSource={sourceAction(entry)}
      sourceValue={sourceText(entry.field)}
      clearing={saving}
    >
      {children}
    </FieldShell>
  );
  const describedBy = (entry: FieldPlan) => {
    const parts = [
      lockedBy(entry),
      entry.origin === 'override' ? `${ids}-${entry.field}-here` : undefined,
    ].filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : parts.join(' ');
  };

  const title = fieldOf('title');
  const status = fieldOf('status');
  const priority = fieldOf('priority');
  const due = fieldOf('dueAt');
  const start = fieldOf('startAt');
  const end = fieldOf('endAt');
  const sendsToProvider = plan.fields.some(
    (entry) => entry.origin === 'provider' && entry.editable,
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.title.trim() === '' && title?.editable === true) {
      return;
    }
    onSave(patchOf(item, plan, draft, timeZone));
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate data-item-edit-form="">
      {title === undefined
        ? null
        : shell(
            title,
            `${ids}-title`,
            <Input
              id={`${ids}-title`}
              value={draft.title}
              dir="auto"
              maxLength={300}
              disabled={!title.editable}
              aria-describedby={describedBy(title)}
              aria-invalid={title.editable && draft.title.trim() === ''}
              onChange={(event) => {
                set({ title: event.target.value });
              }}
            />,
          )}
      {status === undefined && priority === undefined ? null : (
        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          {status === undefined
            ? null
            : shell(
                status,
                `${ids}-status`,
                <SelectField
                  id={`${ids}-status`}
                  value={draft.status}
                  disabled={!status.editable}
                  aria-describedby={describedBy(status)}
                  onValueChange={(next) => {
                    set({ status: next as ItemStatus });
                  }}
                  options={statusChoices(item.editing, status.origin, item.status).map((value) => ({
                    value,
                    label: t(`items.statuses.${value}`),
                  }))}
                />,
              )}
          {priority === undefined
            ? null
            : shell(
                priority,
                `${ids}-priority`,
                <SelectField
                  id={`${ids}-priority`}
                  value={draft.priority}
                  disabled={!priority.editable}
                  aria-describedby={describedBy(priority)}
                  onValueChange={(next) => {
                    set({ priority: next });
                  }}
                  options={[
                    { value: '', label: t('items.edit.priorities.none') },
                    ...PRIORITIES.map((value) => ({
                      value,
                      label: t(`items.edit.priorities.${value}`),
                    })),
                  ]}
                />,
              )}
        </div>
      )}
      {due === undefined
        ? null
        : shell(
            due,
            `${ids}-due`,
            <Input
              id={`${ids}-due`}
              type="date"
              className="w-auto self-start"
              value={draft.dueDate}
              min="1970-01-01"
              max="2999-12-31"
              disabled={!due.editable}
              aria-describedby={describedBy(due)}
              onChange={(event) => {
                set({ dueDate: event.target.value });
              }}
            />,
          )}
      {start === undefined && end === undefined ? null : (
        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          {start === undefined
            ? null
            : shell(
                start,
                `${ids}-start`,
                <div className="flex flex-wrap gap-2">
                  <Input
                    id={`${ids}-start`}
                    type="date"
                    className="w-auto"
                    value={draft.startDate}
                    min="1970-01-01"
                    max="2999-12-31"
                    disabled={!start.editable}
                    aria-describedby={describedBy(start)}
                    onChange={(event) => {
                      setDraft((current) =>
                        withStart(
                          item,
                          current,
                          { date: event.target.value, time: current.startTime },
                          timeZone,
                        ),
                      );
                    }}
                  />
                  {timed ? (
                    <Input
                      type="time"
                      className="w-auto"
                      aria-label={t('items.edit.startTime')}
                      value={draft.startTime}
                      disabled={!start.editable}
                      aria-describedby={describedBy(start)}
                      onChange={(event) => {
                        setDraft((current) =>
                          withStart(
                            item,
                            current,
                            { date: current.startDate, time: event.target.value },
                            timeZone,
                          ),
                        );
                      }}
                    />
                  ) : null}
                </div>,
              )}
          {end === undefined || !timed
            ? null
            : shell(
                end,
                `${ids}-end`,
                <div className="flex flex-wrap gap-2">
                  <Input
                    id={`${ids}-end`}
                    type="date"
                    className="w-auto"
                    value={draft.endDate}
                    min={draft.startDate || '1970-01-01'}
                    max="2999-12-31"
                    disabled={!end.editable}
                    aria-describedby={describedBy(end)}
                    onChange={(event) => {
                      set({ endDate: event.target.value });
                    }}
                  />
                  <Input
                    type="time"
                    className="w-auto"
                    aria-label={t('items.edit.endTime')}
                    value={draft.endTime}
                    disabled={!end.editable}
                    aria-describedby={describedBy(end)}
                    onChange={(event) => {
                      set({ endTime: event.target.value });
                    }}
                  />
                </div>,
              )}
        </div>
      )}
      {problem}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="submit" size="sm" disabled={saving} data-item-edit-save="">
          {t('items.edit.save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('items.edit.cancel')}
        </Button>
        {sendsToProvider ? (
          <span className="text-[13px] text-muted-foreground">
            {t('items.edit.sentTo', { source })}
          </span>
        ) : null}
        {saveStatus}
      </div>
    </form>
  );
}

/**
 * Editing a mirrored item (plan Addendum A1): its provider's fields are written back by its
 * integration's owner while it is read & write; the fields its provider lacks are kept in
 * TodoList ("Only in TodoList") by any editor. Locked fields are shown disabled under one hint
 * that says why. An event with other guests asks whether Google should tell them.
 */
export function MirroredEditor({
  item,
  timeZone,
  source,
  canEdit,
}: {
  item: ItemDetail;
  timeZone: string;
  source: string;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const { workspace } = useCurrentWorkspace();
  const update = useUpdateItem(workspace?.id ?? '', item.id);
  const integrations = useIntegrations(workspace?.id ?? '');
  const own = integrations.data?.find((entry) => entry.id === item.integrationId);
  const plan = editPlan(item, canEdit, own);
  const lockId = useId();
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  const [saved, setSaved] = useState(false);
  /** A save waiting for the guests answer. */
  const [askGuests, setAskGuests] = useState<{
    body: UpdateItemRequestBody;
    then?: () => void;
  } | null>(null);

  const touchesProvider = (body: UpdateItemRequestBody) =>
    plan.fields.some(
      (entry) =>
        entry.origin === 'provider' && (body as Record<string, unknown>)[entry.field] !== undefined,
    );

  const send = (body: UpdateItemRequestBody, then?: () => void) => {
    setProblem(null);
    setSaved(false);
    update.mutate(body, {
      onSuccess: () => {
        setSaved(true);
        then?.();
      },
      onError: (error) => {
        const next = saveProblemOf(error);
        if (next.kind === 'guests' && body.notifyGuests === undefined) {
          setAskGuests(then === undefined ? { body } : { body, then });
          return;
        }
        setProblem(next);
      },
    });
  };
  /** A save: asks about guests first when the event has them and the provider gets a change. */
  const save = (body: UpdateItemRequestBody, then?: () => void) => {
    if (item.editing.needsGuestNotice && touchesProvider(body)) {
      setAskGuests(then === undefined ? { body } : { body, then });
      return;
    }
    send(body, then);
  };

  const state: SaveState = update.isPending
    ? 'saving'
    : problem !== null
      ? 'error'
      : saved
        ? 'saved'
        : 'idle';
  const problemNote =
    problem === null ? null : <ProblemNote problem={problem} item={item} source={source} />;

  // Nothing to change here and nothing to explain: the source owns the item.
  if (!plan.anyEditable && plan.lock === null) {
    return (
      <p className="text-[13px] text-muted-foreground" data-mirrored-note="">
        {t('items.sheet.mirrored', { source })} {t('items.sheet.mirroredOpen')}
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-3" data-item-edit="" aria-label={t('items.edit.open')}>
      {editing ? (
        <>
          {plan.lock === null ? null : (
            <LockHint id={lockId} lock={plan.lock} item={item} source={source} />
          )}
          <EditForm
            item={item}
            plan={plan}
            timeZone={timeZone}
            source={source}
            lockId={lockId}
            saving={update.isPending}
            problem={problemNote}
            status={<SaveStatus state={state} />}
            onSave={(body) => {
              if (body === null) {
                setEditing(false);
                setProblem(null);
                return;
              }
              save(body, () => {
                setEditing(false);
              });
            }}
            onCancel={() => {
              setEditing(false);
              setProblem(null);
            }}
            onUseSource={(field, then) => {
              const body = clearOverrideBody(field, item.sourceValues);
              if (body !== null) {
                save(body, then);
              }
            }}
          />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            {plan.anyEditable ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditing(true);
                  setSaved(false);
                }}
              >
                <Pencil aria-hidden="true" />
                {t('items.edit.open')}
              </Button>
            ) : null}
            <SaveStatus state={state} />
          </div>
          {plan.lock === null ? null : (
            <LockHint id={lockId} lock={plan.lock} item={item} source={source} />
          )}
          {problemNote}
        </>
      )}
      <AlertDialog
        open={askGuests !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAskGuests(null);
          }
        }}
      >
        <AlertDialogContent data-guests-dialog="">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('items.edit.guests.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('items.edit.guests.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-guests="cancel">
              {t('items.edit.guests.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              data-guests="dont-send"
              onClick={() => {
                if (askGuests !== null) {
                  send({ ...askGuests.body, notifyGuests: false }, askGuests.then);
                }
              }}
            >
              {t('items.edit.guests.dontSend')}
            </AlertDialogAction>
            <AlertDialogAction
              data-guests="send"
              onClick={() => {
                if (askGuests !== null) {
                  send({ ...askGuests.body, notifyGuests: true }, askGuests.then);
                }
              }}
            >
              {t('items.edit.guests.send')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
