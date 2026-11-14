import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import { useCreateLocalItem } from '@/api/queries/providerCreate';
import { useMe } from '@/api/queries/user';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { dateInZone, instantInZone } from '@/features/items/zonedDate';
import { CopyTargets, type Funnels } from './CopyTargets';
import { isReady } from './funnel';
import { ResultRow } from './ResultRow';
import { newRequestId, useCopyRunner } from './useCopyRunner';

/** The note reaches a provider cut at this length. */
export const NOTE_MAX = 500;

/**
 * "New to-do" (H5): title, note, due date and page, then "Also create in" with a chip per own
 * integration. Save creates the local to-do, then each target in parallel; the results stream in
 * under the form ("Created in Jira · ABC-123" with its link, a plain failure with Retry, or
 * "Needs permission" with the re-consent). Saving never waits on a provider.
 */
export function NewTodoSheet({
  open,
  onOpenChange,
  presetTopicId = '',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The page the to-do starts on (a List view's page); the member may still change it. */
  presetTopicId?: string;
}) {
  const { t } = useTranslation();
  const { workspace, role, topics, settings } = useCurrentWorkspace();
  const me = useMe();
  const ids = useId();
  const createItem = useCreateLocalItem(workspace?.id ?? '');
  const userId = me.data?.id ?? '';
  const todoId = useRef<string | null>(null);
  const runner = useCopyRunner(workspace?.id ?? '', userId, () => todoId.current);
  const timeZone = settings?.timezone ?? 'UTC';
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [chosenTopic, setTopicId] = useState<string | null>(null);
  const topicId = chosenTopic ?? presetTopicId;
  const [funnels, setFunnels] = useState<Funnels>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setTitle('');
    setNote('');
    setDay('');
    setTime('');
    setTopicId(null);
    setFunnels({});
    setError(null);
    setSaving(false);
    runner.reset();
    todoId.current = null;
  };

  const canCreate = role === 'editor' || role === 'owner';
  const dueAt = day === '' ? null : instantInZone(day, time === '' ? '12:00' : time, timeZone);
  const selected = Object.values(funnels);
  const unready = selected.some((funnel) => !isReady(funnel, dueAt !== null));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (workspace === null || saving) {
      return;
    }
    if (title.trim() === '') {
      setError(t('items.newTodo.nameRequired'));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const item = await createItem.mutateAsync({
        title: title.trim(),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
        ...(dueAt === null ? {} : { dueAt, allDay: time === '' }),
        ...(topicId === '' ? {} : { topicId }),
        idempotencyKey: newRequestId(),
      });
      todoId.current = item.id;
      if (selected.length === 0) {
        onOpenChange(false);
        reset();
        return;
      }
      setSaving(false);
      await runner.run(selected);
    } catch (failure) {
      setSaving(false);
      setError(errorMessage(t, failure, 'items.newTodo.saveError'));
    }
  };

  const topicOptions = [
    { value: '', label: t('items.newTodo.noTopic') },
    ...topics.map((topic) => ({ value: topic.id, label: topic.name })),
  ];

  return (
    <Sheet
      open={open && canCreate}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          reset();
        }
      }}
    >
      <SheetContent
        closeLabel={t('items.newTodo.close')}
        aria-describedby={undefined}
        className="w-[min(32rem,100vw)] gap-0 max-md:w-screen"
        data-new-todo=""
      >
        <SheetHeader>
          <SheetTitle>{t('items.newTodo.title')}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {runner.results === null ? (
            <form
              onSubmit={(event) => {
                void save(event);
              }}
              className="flex flex-col gap-4"
              noValidate
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-title`}>{t('items.newTodo.name')}</Label>
                <Input
                  id={`${ids}-title`}
                  value={title}
                  autoFocus
                  maxLength={255}
                  placeholder={t('items.newTodo.namePlaceholder')}
                  aria-invalid={error !== null && title.trim() === ''}
                  onChange={(event) => {
                    setTitle(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-note`}>{t('items.newTodo.note')}</Label>
                <Input
                  id={`${ids}-note`}
                  value={note}
                  maxLength={NOTE_MAX}
                  onChange={(event) => {
                    setNote(event.target.value);
                  }}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${ids}-day`}>{t('items.newTodo.due')}</Label>
                  <Input
                    id={`${ids}-day`}
                    type="date"
                    value={day}
                    min={dateInZone(new Date('2000-01-01'), timeZone)}
                    onChange={(event) => {
                      setDay(event.target.value);
                      if (event.target.value === '') {
                        setTime('');
                      }
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${ids}-time`}>{t('items.newTodo.dueTime')}</Label>
                  <Input
                    id={`${ids}-time`}
                    type="time"
                    value={time}
                    disabled={day === ''}
                    onChange={(event) => {
                      setTime(event.target.value);
                    }}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-topic`}>{t('items.newTodo.topic')}</Label>
                <SelectField
                  id={`${ids}-topic`}
                  value={topicId}
                  onValueChange={setTopicId}
                  options={topicOptions}
                />
              </div>
              {workspace === null || userId === '' ? null : (
                <CopyTargets
                  workspaceId={workspace.id}
                  userId={userId}
                  hasDueDate={dueAt !== null}
                  value={funnels}
                  onChange={setFunnels}
                />
              )}
              {error === null ? null : (
                <p className="text-sm text-destructive" role="alert" data-new-todo-error="">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    onOpenChange(false);
                    reset();
                  }}
                >
                  {t('items.newTodo.cancel')}
                </Button>
                <Button type="submit" disabled={saving || unready} data-new-todo-save="">
                  {saving ? t('items.newTodo.saving') : t('items.newTodo.save')}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col gap-3" data-new-todo-results="">
              <h3 className="text-sm font-medium">{t('items.newTodo.results.title')}</h3>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                <li
                  className="flex items-center gap-2 rounded-md border p-3 text-sm"
                  data-result="local"
                >
                  <Check className="size-4 text-primary" aria-hidden="true" />
                  {t('items.newTodo.results.local')}
                </li>
                {runner.results.map((result) => (
                  <ResultRow
                    key={result.integrationId}
                    result={result}
                    onRetry={() => {
                      runner.retry(result.integrationId);
                    }}
                    onAllow={() => {
                      void runner.allow(result.integrationId);
                    }}
                  />
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                {t('items.newTodo.results.completeNote')}
              </p>
              <Button
                type="button"
                className="self-end"
                onClick={() => {
                  onOpenChange(false);
                  reset();
                }}
                data-new-todo-done=""
              >
                {t('items.newTodo.done')}
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
