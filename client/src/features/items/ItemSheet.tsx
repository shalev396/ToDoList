import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMembers } from '@/api/queries/members';
import { ownerOf } from './owner';
import { CircleAlert, ExternalLink, Pencil } from 'lucide-react';
import { SourceDot } from '@/components/items/SourceDot';
import { dateLocale, initials, longDate } from '@/components/items/format';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SaveStatus } from '@/components/ui/save-status';
import { SelectField } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAttributes } from '@/api/queries/attributes';
import { useItem, useUpdateItem, useUpdateOverlay } from '@/api/queries/items';
import { useMe } from '@/api/queries/user';
import { AttributeFields } from './AttributeFields';
import { apiErrorStatus, apiOpenIn, errorMessage } from '@/api/errors';
import { useLanguage } from '@/hooks/useLanguage';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { ITEM_STATUSES, type ItemStatus } from '@api-types/domain';
import type { ItemDetail } from '@api-types/api-contracts';
import { isKnownProvider } from './providers';
import { AlsoCreateIn } from './create/AlsoCreateIn';
import { CopyChips } from './CopyChips';
import { SourcePreview } from './SourcePreview';
import { describeProps, type ItemField } from './itemFields';
import { useItemParam } from './useItemParam';
import { dateInZone, noonInZone } from './zonedDate';
import { ScrollArea } from '@/components/ui/scroll-area';

/**
 * The item detail (FRONTEND.md §1: item detail lives in a Sheet, `?item=<id>`): a right Sheet on
 * desktop, a full-width drawer on phones. The back button closes it. The source owns a mirrored
 * item, so only the overlay (pin, note, hide, topic) is editable there; a local to-do is edited
 * in place.
 */
export function ItemSheet() {
  const { t } = useTranslation();
  const { id, closeItem } = useItemParam();
  const { workspace } = useCurrentWorkspace();
  const item = useItem(workspace?.id ?? null, id);
  const open = id !== null;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeItem();
        }
      }}
    >
      <SheetContent
        closeLabel={t('items.sheet.close')}
        aria-describedby={undefined}
        className="w-[min(32rem,100vw)] gap-0 max-md:w-screen"
        data-item-sheet=""
      >
        {item.data !== undefined ? (
          <ScrollArea className="min-h-0 flex-1">
            <ItemBody key={item.data.id} item={item.data} />
          </ScrollArea>
        ) : (
          <>
            <SheetHeader className="pe-14">
              <SheetTitle>{t('items.sheet.title')}</SheetTitle>
            </SheetHeader>
            <div className="p-4 pt-0">
              {item.isError ? (
                <div role="alert" className="flex flex-col items-start gap-3 text-sm">
                  <p className="flex items-center gap-2">
                    <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
                    {apiErrorStatus(item.error) === 404
                      ? t('items.sheet.notFound')
                      : t('items.sheet.loadError')}
                  </p>
                  {apiErrorStatus(item.error) === 404 ? null : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void item.refetch();
                      }}
                    >
                      {t('blocks.retry')}
                    </Button>
                  )}
                </div>
              ) : (
                <div role="status" className="flex flex-col gap-3">
                  <span className="sr-only">{t('items.sheet.loading')}</span>
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ItemBody({ item }: { item: ItemDetail }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { workspace, role } = useCurrentWorkspace();
  const timeZone = workspace?.settings.timezone ?? 'UTC';
  const canWrite = role === 'editor' || role === 'owner';
  const isLocal = item.source.provider === 'local';
  const me = useMe();
  const mine = isLocal && canWrite && item.ownerUserId === me.data?.id;
  const [focus, setFocus] = useState<{ integrationId: string; anyway: boolean } | null>(null);
  const sourceName = t(`sources.${item.source.provider}`);
  const fields = describeProps(item.props);
  const [editing, setEditing] = useState(false);
  const [refused, setRefused] = useState<{ provider: string; url: string } | null>(null);

  return (
    <>
      <SheetHeader className="gap-1 pe-14">
        <p className="text-[13px] text-muted-foreground">{t(`items.kinds.${item.kind}`)}</p>
        <SheetTitle
          dir="auto"
          className="text-lg leading-snug [overflow-wrap:anywhere]"
          data-item-title=""
        >
          {item.title}
        </SheetTitle>
      </SheetHeader>
      <div className="flex flex-col gap-6 p-4 pt-1">
        <SourcePreview item={item} timeZone={timeZone} />
        {isLocal ? <AddedBy ownerUserId={item.ownerUserId} /> : null}

        {item.copies.length > 0 ? (
          <section className="flex flex-col gap-2" data-item-copies="">
            <h3 className="text-sm font-medium">{t('items.copies.title')}</h3>
            <CopyChips copies={item.copies} />
            {mine
              ? item.copies.map((copy) =>
                  copy.status === 'failed' || copy.status === 'unknown' ? (
                    <div
                      key={copy.requestId}
                      className="flex flex-wrap items-center gap-2 text-sm"
                      data-copy-actions={copy.status}
                    >
                      {copy.status === 'unknown' && copy.url.startsWith('https://') ? (
                        <a
                          href={copy.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {t('items.newTodo.results.checkIn', {
                            source: t(`sources.${copy.provider}`),
                          })}
                        </a>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setFocus({
                            integrationId: copy.integrationId,
                            anyway: copy.status === 'unknown',
                          });
                        }}
                      >
                        {copy.status === 'unknown'
                          ? t('items.newTodo.results.retryAnyway')
                          : t('items.copies.retryHere')}
                      </Button>
                    </div>
                  ) : null,
                )
              : null}
          </section>
        ) : null}

        {mine && workspace !== null && me.data ? (
          <section className="flex flex-col gap-2" data-item-also-create="">
            <h3 className="text-sm font-medium">{t('items.newTodo.createIn')}</h3>
            <AlsoCreateIn
              item={item}
              workspaceId={workspace.id}
              userId={me.data.id}
              focus={focus}
            />
          </section>
        ) : null}

        {isLocal ? (
          canWrite ? (
            editing ? (
              <EditForm
                item={item}
                timeZone={timeZone}
                onDone={() => {
                  setEditing(false);
                }}
              />
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => {
                  setEditing(true);
                }}
              >
                <Pencil aria-hidden="true" />
                {t('items.sheet.edit')}
              </Button>
            )
          ) : null
        ) : (
          <p className="text-[13px] text-muted-foreground" data-mirrored-note="">
            {t('items.sheet.mirrored', { source: sourceName })} {t('items.sheet.mirroredOpen')}
          </p>
        )}

        {refused === null ? null : (
          <div
            role="alert"
            className="flex flex-col items-start gap-2 rounded-lg border p-3 text-sm"
          >
            <p className="flex items-center gap-2">
              <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
              {t('items.sheet.mirrored', { source: sourceName })}
            </p>
            <a
              href={refused.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-medium underline underline-offset-2"
            >
              {isKnownProvider(item.source.provider) ? (
                <SourceDot source={item.source.provider} />
              ) : null}
              {t('items.sheet.openInSource', { source: sourceName })}
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          </div>
        )}

        <section aria-labelledby="item-details" className="flex flex-col gap-2">
          <h3 id="item-details" className="text-sm font-semibold">
            {t('items.sheet.details')}
          </h3>
          {fields.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('items.sheet.noDetails')}</p>
          ) : (
            <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              {fields.map((field) => (
                <FieldRow key={field.key} field={field} language={language} timeZone={timeZone} />
              ))}
            </dl>
          )}
        </section>

        {canWrite ? (
          <OverlayControls
            item={item}
            sourceName={sourceName}
            isLocal={isLocal}
            onRefused={(openIn) => {
              setRefused(openIn);
            }}
          />
        ) : null}
      </div>
    </>
  );
}

/** "Added by Dana", or "Added by a former member" once they left (their to-dos stay). */
function AddedBy({ ownerUserId }: { ownerUserId: string | null }) {
  const { t } = useTranslation();
  const { workspace } = useCurrentWorkspace();
  const members = useMembers(workspace?.id ?? '');
  const owner = ownerOf(ownerUserId, members.data);
  if (owner === null || owner.kind === 'unknown') {
    return null;
  }
  return (
    <p className="-mt-3 text-[13px] text-muted-foreground" data-item-owner={owner.kind}>
      {owner.kind === 'former'
        ? t('items.sheet.addedByFormer')
        : t('items.sheet.addedBy', { name: owner.name })}
    </p>
  );
}

function FieldRow({
  field,
  language,
  timeZone,
}: {
  field: ItemField;
  language: string;
  timeZone: string;
}) {
  const { t } = useTranslation();
  const label = field.key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  let value;
  switch (field.type) {
    case 'date':
      value = longDate(new Date(String(field.value)), dateLocale(language), timeZone);
      break;
    case 'user':
      value = (
        <span className="inline-flex min-w-0 items-center gap-2">
          <Avatar className="size-5">
            <AvatarFallback className="text-[10px]">{initials(String(field.value))}</AvatarFallback>
          </Avatar>
          <span className="truncate" dir="auto">
            {field.value}
          </span>
        </span>
      );
      break;
    case 'url':
      value = (
        <a
          href={String(field.value)}
          target="_blank"
          rel="noopener noreferrer"
          title={t('items.sheet.openLink')}
          className="inline-flex max-w-full items-center gap-1 underline underline-offset-2"
        >
          <span className="truncate" dir="ltr">
            {hostOf(String(field.value))}
          </span>
          <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
        </a>
      );
      break;
    case 'number':
      value = new Intl.NumberFormat(dateLocale(language)).format(Number(field.value));
      break;
    case 'status':
    case 'text':
      value = <span dir="auto">{field.value}</span>;
      break;
  }
  return (
    <>
      <dt className="truncate text-muted-foreground first-letter:uppercase" title={label}>
        {label}
      </dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A local to-do, edited in place: title, due date and status. */
function EditForm({
  item,
  timeZone,
  onDone,
}: {
  item: ItemDetail;
  timeZone: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { workspace } = useCurrentWorkspace();
  const update = useUpdateItem(workspace?.id ?? '', item.id);
  const [title, setTitle] = useState(item.title);
  const [due, setDue] = useState(item.dueAt === null ? '' : dateInZone(item.dueAt, timeZone));
  const [status, setStatus] = useState<ItemStatus>(item.status);
  const ids = { title: useId(), due: useId(), status: useId() };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === '') {
      return;
    }
    const currentDue = item.dueAt === null ? '' : dateInZone(item.dueAt, timeZone);
    update.mutate(
      {
        ...(trimmed === item.title ? {} : { title: trimmed }),
        ...(due === currentDue ? {} : { dueAt: due === '' ? null : noonInZone(due, timeZone) }),
        ...(status === item.status ? {} : { status }),
      },
      { onSuccess: onDone },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.title}>{t('items.sheet.editTitle')}</Label>
        <Input
          id={ids.title}
          value={title}
          dir="auto"
          maxLength={500}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.due}>{t('items.sheet.editDue')}</Label>
          <Input
            id={ids.due}
            type="date"
            value={due}
            onChange={(event) => {
              setDue(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.status}>{t('items.sheet.editStatus')}</Label>
          <SelectField
            id={ids.status}
            value={status}
            onValueChange={(next) => {
              setStatus(next as ItemStatus);
            }}
            options={ITEM_STATUSES.map((value) => ({
              value,
              label: t(`items.statuses.${value}`),
            }))}
          />
        </div>
      </div>
      {update.isError ? (
        <p role="alert" className="flex items-center gap-1.5 text-[13px] text-destructive">
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {errorMessage(t, update.error, 'items.sheet.saveError')}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={update.isPending || title.trim() === ''}>
          {t('items.sheet.save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t('items.sheet.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Pin, hide, topic and a private note: stored beside the item, never sent to the provider. */
function OverlayControls({
  item,
  sourceName,
  isLocal,
  onRefused,
}: {
  item: ItemDetail;
  sourceName: string;
  isLocal: boolean;
  onRefused: (openIn: { provider: string; url: string }) => void;
}) {
  const { t } = useTranslation();
  const { workspace, topics } = useCurrentWorkspace();
  const overlay = useUpdateOverlay(workspace?.id ?? '', item.id);
  const attributes = useAttributes(workspace?.id ?? null);
  const [note, setNote] = useState(item.overlay.note ?? '');
  const ids = { pin: useId(), hide: useId(), topic: useId(), note: useId() };

  const save = (body: Parameters<typeof overlay.mutate>[0]) => {
    overlay.mutate(body, {
      onError: (error) => {
        const openIn = apiOpenIn(error);
        if (openIn !== null) {
          onRefused(openIn);
        }
      },
    });
  };

  return (
    <section aria-labelledby="item-overlay" className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h3 id="item-overlay" className="text-sm font-semibold">
          {t('items.sheet.yours')}
        </h3>
        <p className="text-[13px] text-muted-foreground">
          {isLocal
            ? t('items.sheet.yoursHintLocal')
            : t('items.sheet.yoursHint', { source: sourceName })}
        </p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={ids.pin}>{t('items.sheet.pinned')}</Label>
        <Switch
          id={ids.pin}
          checked={item.overlay.pinned === true}
          disabled={overlay.isPending}
          onCheckedChange={(pinned) => {
            save({ pinned });
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={ids.hide}>{t('items.sheet.hidden')}</Label>
        <Switch
          id={ids.hide}
          checked={item.overlay.hidden === true}
          disabled={overlay.isPending}
          onCheckedChange={(hidden) => {
            save({ hidden });
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.topic}>{t('items.sheet.topic')}</Label>
        <SelectField
          id={ids.topic}
          value={item.overlay.topicOverride ?? ''}
          disabled={overlay.isPending}
          onValueChange={(value) => {
            save({ topicOverride: value === '' ? null : value });
          }}
          options={[
            {
              value: '',
              label: isLocal
                ? t('items.sheet.topicDefaultLocal')
                : t('items.sheet.topicDefault', { source: sourceName }),
            },
            ...topics.map((topic) => ({ value: topic.id, label: topic.name })),
          ]}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.note}>{t('items.sheet.note')}</Label>
        <textarea
          id={ids.note}
          value={note}
          dir="auto"
          rows={3}
          maxLength={2000}
          placeholder={t('items.sheet.notePlaceholder')}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          onBlur={() => {
            const next = note.trim() === '' ? null : note;
            if (next !== item.overlay.note) {
              save({ note: next });
            }
          }}
          className="min-h-20 w-full resize-y rounded-sm border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
        />
      </div>
      <AttributeFields
        defs={attributes.data ?? []}
        attrs={item.overlay.attrs}
        disabled={overlay.isPending}
        hint={
          isLocal
            ? t('logic.attributes.itemHintLocal')
            : t('logic.attributes.itemHint', { source: sourceName })
        }
        onSave={(key, value) => {
          save({ attrs: { [key]: value } });
        }}
      />
      <SaveStatus
        className="self-start"
        state={
          overlay.isPending
            ? 'saving'
            : overlay.isError && apiOpenIn(overlay.error) === null
              ? 'error'
              : overlay.isSuccess
                ? 'saved'
                : 'idle'
        }
      />
      {overlay.isError && apiOpenIn(overlay.error) === null ? (
        <p role="alert" className="flex items-center gap-1.5 text-[13px] text-destructive">
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {errorMessage(t, overlay.error, 'items.sheet.saveError')}
        </p>
      ) : null}
    </section>
  );
}
