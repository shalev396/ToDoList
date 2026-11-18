import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { apiErrorCode, errorMessage } from '@/api/errors';
import { queryKeys } from '@/api/queries/keys';
import { useAttributes, useCreateAttribute, useUpdateAttribute } from '@/api/queries/attributes';
import { useSubjectMatchCounts } from '@/api/queries/subjects';
import { FormError } from '@/components/auth/auth-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select';
import { FamilySwatch } from '@/features/colours/FamilySwatch';
import { useColourContext } from '@/features/colours/useColours';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import { SUBJECT_ATTRIBUTE_KEY } from '@api-types/attributes';
import { TOPIC_COLOURS, type TopicColour } from '@api-types/topics';
import {
  addSubject,
  draftOf,
  moveSubject,
  parsePatterns,
  requestOf,
  type SubjectDraft,
} from './subjectsDraft';

/** The most the match count shows before it reads "5000+". */
const COUNT_CAP = 5000;

function isFamily(value: string): value is TopicColour {
  return (TOPIC_COLOURS as readonly string[]).includes(value);
}

const TEXTAREA_CLASS =
  'min-h-20 w-full rounded-sm border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 read-only:text-muted-foreground dark:bg-input/30';

interface RowProps {
  subject: SubjectDraft;
  index: number;
  last: boolean;
  canEdit: boolean;
  count: string | null;
  onChange: (patch: Partial<SubjectDraft>) => void;
  onMove: (by: -1 | 1) => void;
}

function SubjectRow({ subject, index, last, canEdit, count, onChange, onMove }: RowProps) {
  const { t } = useTranslation();
  const id = useId();
  // The text as typed: a trailing newline or comma is not a pattern yet, so it is not parsed away.
  const [patternText, setPatternText] = useState(subject.patterns.join('\n'));
  const moveButton = (by: -1 | 1) => (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className="max-md:size-11"
      disabled={by === -1 ? index === 0 : last}
      aria-label={t(by === -1 ? 'settings.subjects.moveUp' : 'settings.subjects.moveDown', {
        name: subject.name,
      })}
      onClick={() => {
        onMove(by);
      }}
    >
      {by === -1 ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
    </Button>
  );
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border bg-card px-4 py-3"
      data-subject={subject.name}
      data-family={subject.family}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>{t('settings.subjects.name')}</Label>
          <Input
            id={`${id}-name`}
            value={subject.name}
            maxLength={40}
            dir="auto"
            readOnly={!canEdit}
            onChange={(event) => {
              onChange({ name: event.target.value });
            }}
          />
        </div>
        <div className="flex min-w-40 flex-col gap-1.5">
          <Label htmlFor={`${id}-family`}>{t('settings.subjects.family')}</Label>
          <SelectField
            id={`${id}-family`}
            value={subject.family}
            disabled={!canEdit}
            onValueChange={(next) => {
              if (isFamily(next)) {
                onChange({ family: next });
              }
            }}
            options={TOPIC_COLOURS.map((family) => ({
              value: family,
              label: (
                <span className="inline-flex items-center gap-2">
                  <FamilySwatch family={family} />
                  {t(`colours.family.${family}`)}
                </span>
              ),
            }))}
          />
        </div>
        {canEdit ? (
          <div className="flex items-center gap-1">
            {moveButton(-1)}
            {moveButton(1)}
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-patterns`}>{t('settings.subjects.patterns')}</Label>
        <textarea
          id={`${id}-patterns`}
          value={patternText}
          dir="auto"
          rows={2}
          readOnly={!canEdit}
          placeholder="*Calculus*"
          aria-describedby={`${id}-hint`}
          className={TEXTAREA_CLASS}
          onChange={(event) => {
            setPatternText(event.target.value);
            onChange({ patterns: parsePatterns(event.target.value) });
          }}
        />
        <p id={`${id}-hint`} className="text-[13px] text-muted-foreground">
          {t('settings.subjects.patternsHint')}
        </p>
      </div>
      <p
        aria-live="polite"
        data-subject-count
        className="min-h-5 text-[13px] font-medium text-muted-foreground"
      >
        {count}
      </p>
    </li>
  );
}

/**
 * Subjects (topic-colours spec): the `subject` select's options, each with a colour family and
 * title patterns, and how many items each would take. Edited as one draft and saved together;
 * editors and owners change it, viewers read it.
 */
export function SubjectsSection({
  workspaceId,
  canEdit,
}: {
  workspaceId: string;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const attributes = useAttributes(workspaceId);
  const create = useCreateAttribute(workspaceId);
  const update = useUpdateAttribute(workspaceId);
  const { topicFamilies } = useColourContext();
  const saved = useMemo(
    () => attributes.data?.find((def) => def.key === SUBJECT_ATTRIBUTE_KEY),
    [attributes.data],
  );
  const [edited, setEdited] = useState<SubjectDraft[] | null>(null);
  // Bumped on discard and save, so the rows' typed text starts again from the draft.
  const [generation, setGeneration] = useState(0);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const draft = useMemo(() => edited ?? draftOf(saved), [edited, saved]);
  const attributeName = t('settings.subjects.attributeName');
  const request = requestOf(saved, draft, attributeName);
  const names = draft.map((subject) => subject.name.trim());
  const valid = names.every((name) => name !== '') && new Set(names).size === names.length;
  const saving = create.isPending || update.isPending;

  const probes = draft
    .filter((subject) => subject.name.trim() !== '')
    .map((subject) => ({ name: subject.name.trim(), patterns: subject.patterns }));
  const counts = useSubjectMatchCounts(workspaceId, probes);
  const countOf = (subject: SubjectDraft): string | null => {
    const at = probes.findIndex((probe) => probe.name === subject.name.trim());
    const value = counts.data?.counts[at];
    if (value === undefined) {
      return null;
    }
    return counts.data?.capped === true && value >= COUNT_CAP
      ? t('settings.subjects.capped', { limit: COUNT_CAP })
      : t('settings.subjects.matches', { count: value });
  };

  const edit = (change: (rows: SubjectDraft[]) => SubjectDraft[]) => {
    setEdited(change(draft));
  };
  const reset = () => {
    setEdited(null);
    setGeneration((value) => value + 1);
    setError(null);
  };
  const save = async () => {
    if (request === null || !valid) {
      return;
    }
    setError(null);
    try {
      if ('create' in request) {
        await create.mutateAsync(request.create);
      } else {
        await update.mutateAsync({ key: SUBJECT_ATTRIBUTE_KEY, body: request.patch });
      }
      await queryClient.refetchQueries({ queryKey: queryKeys.attributes(workspaceId) });
      reset();
      toast.success(t('settings.subjects.saved'));
    } catch (failure) {
      setError(errorMessage(t, failure, 'settings.subjects.saveFailed'));
      if (apiErrorCode(failure) === 'attribute_exists') {
        // Someone else made the attribute first: the next save patches it.
        void queryClient.refetchQueries({ queryKey: queryKeys.attributes(workspaceId) });
      }
    }
  };

  return (
    <SettingsSection
      id={`${id}-title`}
      title={t('settings.subjects.title')}
      hint={t('settings.subjects.hint')}
      layout="stacked"
    >
      <div data-subjects className="flex flex-col gap-3">
        {draft.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('settings.subjects.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {draft.map((subject, index) => (
              <SubjectRow
                key={`${String(generation)}-${subject.key}`}
                subject={subject}
                index={index}
                last={index === draft.length - 1}
                canEdit={canEdit}
                count={countOf(subject)}
                onChange={(patch) => {
                  edit((rows) =>
                    rows.map((row) => (row.key === subject.key ? { ...row, ...patch } : row)),
                  );
                }}
                onMove={(by) => {
                  edit((rows) => moveSubject(rows, subject.key, by));
                }}
              />
            ))}
          </ul>
        )}
        {canEdit ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              edit((rows) => addSubject(rows, newName, [...topicFamilies.values()]));
              setNewName('');
            }}
          >
            <div className="flex min-w-40 flex-1 flex-col gap-1.5">
              <Label htmlFor={`${id}-new`}>{t('settings.subjects.name')}</Label>
              <Input
                id={`${id}-new`}
                value={newName}
                maxLength={40}
                dir="auto"
                onChange={(event) => {
                  setNewName(event.target.value);
                }}
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="max-md:h-11"
              disabled={newName.trim() === ''}
            >
              <Plus aria-hidden="true" />
              {t('settings.subjects.add')}
            </Button>
          </form>
        ) : null}
        {error === null ? null : <FormError>{error}</FormError>}
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2" data-subjects-bar>
            <Button
              type="button"
              size="sm"
              className="max-md:h-11"
              disabled={request === null || !valid || saving}
              onClick={() => {
                void save();
              }}
            >
              {t('settings.subjects.save')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="max-md:h-11"
              disabled={edited === null || saving}
              onClick={reset}
            >
              {t('settings.subjects.discard')}
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
