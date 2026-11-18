import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMatch } from 'react-router-dom';
import { errorMessage } from '@/api/errors';
import { useAttributes } from '@/api/queries/attributes';
import { useCreateTimeBlock } from '@/api/queries/timeBlocks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select';
import { subjectOptions } from '@/pages/settings/general/subjectsDraft';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { CreateTravel } from '@/features/travel/TravelPanelForm';
import { useAddTravel, useTravelSetup } from '@/features/travel/travelHooks';
import { anchorPanel, type TravelPanelState } from '@/features/travel/travelPanel';
import { ROUTES } from '@/router/routes';
import type { BlockLayer } from '@api-types/scheduled.ts';
import { SpanFields, SubjectField } from './BlockFields';
import { RepeatControl } from './RepeatControl';
import { isRepeating, repeatProblem } from './recurrence';
import {
  BLOCK_REPEAT_PRESETS,
  blockRequestOf,
  blockTopicOf,
  initialBlockState,
  spanOf,
  spanProblem,
  titleProblem,
  type NewItemPreset,
  type TimeBlockFormState,
} from './timeBlockDraft';
import { newRequestId } from './useCopyRunner';

/** The Page select's values that are not topic ids. */
const AUTO_TOPIC = 'auto';
const NO_TOPIC = 'none';

/**
 * The time block form (an area is the same form, `layer: 'area'`): title, subject (one of the
 * workspace's or a new one), start, end and length (any two; the third is worked out), Repeat
 * (none, weekly on chosen days, or custom, with an optional end date) and the page. Save creates
 * it with `POST …/time-blocks` and closes the sheet.
 *
 * A block (never an area: painted time is not travelled to) can "Add travel time": the same
 * switch and panel as a to-do. A repeating block's travel is for every occurrence. Travel is
 * marked once the block is made, and how that went is a toast.
 */
export function TimeBlockForm({
  layer,
  preset,
  onClose,
}: {
  layer: BlockLayer;
  /** The times and page the sheet opened with (no page: the topic page it opens on, if any). */
  preset: NewItemPreset;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const { workspace, topics, settings } = useCurrentWorkspace();
  const timeZone = settings?.timezone ?? 'UTC';
  const weekStart = settings?.weekStart ?? 'sun';
  // The topic page under the sheet (`/:lng/t/:topic`, a group in it too).
  const page = useMatch(`/:lng/${ROUTES.TOPIC}/*`);
  const attributes = useAttributes(workspace?.id ?? null);
  const subjects = useMemo(() => subjectOptions(attributes.data), [attributes.data]);
  const create = useCreateTimeBlock(workspace?.id ?? '');
  const [state, setState] = useState(() =>
    initialBlockState(
      { ...preset, topicId: blockTopicOf(preset.topicId, page?.params.topic, topics) },
      new Date(),
      timeZone,
    ),
  );
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per request body: a retry of the same block is never a second one.
  const sent = useRef<{ body: string; key: string } | null>(null);
  // Travel: null while "Add travel time" is off; a block only.
  const [travel, setTravel] = useState<TravelPanelState | null>(null);
  const travelSetup = useTravelSetup(travel !== null);
  const addTravel = useAddTravel();

  const form: TimeBlockFormState = { ...state, layer };
  const span = spanProblem(form, timeZone);
  const naming = titleProblem(form);
  const repeat = repeatProblem(form.repeat, form.startDate);
  const [travelling, setTravelling] = useState(false);
  const saving = create.isPending || travelling;
  const anchor = spanOf(form, timeZone)?.start ?? null;
  const withTravel = layer === 'block' && travel !== null;
  const travelUnready = withTravel && (!travelSetup.ready || travelSetup.home === null);

  const set = (patch: Partial<TimeBlockFormState>) => {
    setState((previous) => ({ ...previous, ...patch }));
  };
  /** A new span: the trip there follows the block's start. */
  const setSpan = (update: (previous: TimeBlockFormState) => TimeBlockFormState) => {
    const next = update(state);
    setState(next);
    setTravel((previous) =>
      previous === null ? previous : anchorPanel(previous, spanOf(next, timeZone)?.start ?? null),
    );
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    const request = blockRequestOf(form, timeZone, weekStart);
    if (request === null || workspace === null || saving || travelUnready) {
      return;
    }
    const body = JSON.stringify(request);
    if (sent.current?.body !== body) {
      sent.current = { body, key: newRequestId() };
    }
    setError(null);
    try {
      const block = await create.mutateAsync({ ...request, idempotencyKey: sent.current.key });
      if (withTravel && anchor !== null) {
        // The block stands whatever travel answers; the toast says how travel went.
        setTravelling(true);
        await addTravel({
          itemId: block.id,
          state: travel,
          start: anchor,
          every: isRepeating(form.repeat),
          createdWithout: t('travel.add.createdWithoutBlock'),
        });
      }
      onClose();
    } catch (failure) {
      setError(
        errorMessage(
          t,
          failure,
          layer === 'area' ? 'scheduled.form.saveErrorArea' : 'scheduled.form.saveError',
        ),
      );
    }
  };

  const topicValue = state.topicId === undefined ? AUTO_TOPIC : (state.topicId ?? NO_TOPIC);
  const topicOptions = [
    { value: AUTO_TOPIC, label: t('scheduled.form.topicAuto') },
    { value: NO_TOPIC, label: t('scheduled.form.noTopic') },
    ...topics.map((topic) => ({ value: topic.id, label: topic.name })),
  ];
  const titleError = tried && naming !== null;

  return (
    <form
      onSubmit={(event) => {
        void save(event);
      }}
      className="flex flex-col gap-4"
      noValidate
      data-time-block-form={layer}
    >
      <fieldset disabled={saving} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-title`}>{t('scheduled.form.name')}</Label>
          <Input
            id={`${ids}-title`}
            dir="auto"
            value={state.title}
            maxLength={300}
            placeholder={
              layer === 'area'
                ? t('scheduled.form.namePlaceholderArea')
                : t('scheduled.form.namePlaceholderBlock')
            }
            aria-invalid={titleError}
            onChange={(event) => {
              set({ title: event.target.value });
            }}
          />
        </div>
        <SubjectField
          id={ids}
          value={state.subject}
          subjects={subjects}
          invalid={titleError && naming === 'titleOrSubject'}
          onChange={(subject) => {
            set({ subject });
          }}
        />
        <SpanFields id={ids} state={state} timeZone={timeZone} onChange={setSpan} />

        <RepeatControl
          value={state.repeat}
          onChange={(next) => {
            set({ repeat: next });
          }}
          dueDate={state.startDate}
          presets={BLOCK_REPEAT_PRESETS}
          wording={{
            dueDay: t('scheduled.form.repeat.startDay'),
            needsDue: t('scheduled.form.repeat.needsStart'),
            untilBeforeDue: t('scheduled.form.repeat.untilBeforeStart'),
          }}
        />

        {layer === 'block' ? (
          <CreateTravel
            value={travel}
            onChange={setTravel}
            anchorStart={anchor}
            needsTime={false}
            every={isRepeating(state.repeat)}
          />
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-topic`}>{t('scheduled.form.topic')}</Label>
          <SelectField
            id={`${ids}-topic`}
            value={topicValue}
            onValueChange={(next) => {
              set({
                topicId: next === AUTO_TOPIC ? undefined : next === NO_TOPIC ? null : next,
              });
            }}
            options={topicOptions}
          />
        </div>
      </fieldset>

      {titleError ? (
        <p className="text-sm text-destructive" role="alert" data-time-block-error="">
          {t(`scheduled.form.problems.${naming}`)}
        </p>
      ) : null}
      {error === null ? null : (
        <p className="text-sm text-destructive" role="alert" data-time-block-error="">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('scheduled.form.cancel')}
        </Button>
        <Button
          type="submit"
          disabled={saving || span !== null || repeat !== null || travelUnready}
          data-time-block-save=""
        >
          {saving ? t('scheduled.form.saving') : t('scheduled.form.save')}
        </Button>
      </div>
    </form>
  );
}
