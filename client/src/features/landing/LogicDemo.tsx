import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flag, MousePointer2, Pause, Pencil, Play, X } from 'lucide-react';
import { SourceDot } from '@/components/items/SourceDot';
import type { Provider } from '@/components/items/types';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { cn } from '@/lib/utils';
import { demoLanguage } from './demoData';
import { Block, Container } from './layout';

interface Row {
  id: string;
  source: Provider;
  important: boolean;
  title: { en: string; he: string };
  due: { en: string; he: string };
}

/** Sorted by due date, as the block lists them before any logic is applied. */
const ROWS: readonly Row[] = [
  {
    id: 'cable',
    source: 'local',
    important: false,
    title: { en: 'Buy a USB-C cable', he: 'לקנות כבל USB-C' },
    due: { en: 'Today', he: 'היום' },
  },
  {
    id: 'review',
    source: 'github',
    important: true,
    title: { en: 'Review pull request 48', he: 'סקירה של בקשת מיזוג 48' },
    due: { en: 'Tomorrow', he: 'מחר' },
  },
  {
    id: 'email',
    source: 'local',
    important: false,
    title: { en: 'Email the TA about the lab', he: 'לכתוב למתרגל על המעבדה' },
    due: { en: 'Tomorrow', he: 'מחר' },
  },
  {
    id: 'exercise',
    source: 'moodle',
    important: true,
    title: { en: 'Exercise 4: graphs', he: 'תרגיל 4: גרפים' },
    due: { en: 'Friday', he: 'יום ו׳' },
  },
  {
    id: 'card',
    source: 'local',
    important: false,
    title: { en: 'Renew student card', he: 'לחדש כרטיס סטודנט' },
    due: { en: 'Sunday', he: 'יום א׳' },
  },
  {
    id: 'notes',
    source: 'jira',
    important: true,
    title: { en: 'PAY-150 Release notes', he: 'PAY-150 הערות גרסה' },
    due: { en: 'Monday', he: 'יום ב׳' },
  },
];

const ROW_HEIGHT = 52;
const HEADER_HEIGHT = 48;

/** One frame of the walkthrough: what is open, what is chosen, and where the pointer is. */
interface Phase {
  panel: boolean;
  tab: 'data' | 'logic';
  filtered: boolean;
  pointer: 'edit' | 'logic' | 'chip' | null;
  /** How long this frame stays, in ms. */
  hold: number;
}

/** focus the block, Edit, Logic, "Only important", the list re-sorts, then back to the start. */
const SCRIPT: readonly Phase[] = [
  { panel: false, tab: 'data', filtered: false, pointer: null, hold: 1600 },
  { panel: false, tab: 'data', filtered: false, pointer: 'edit', hold: 1100 },
  { panel: true, tab: 'data', filtered: false, pointer: 'edit', hold: 900 },
  { panel: true, tab: 'data', filtered: false, pointer: 'logic', hold: 1000 },
  { panel: true, tab: 'logic', filtered: false, pointer: 'logic', hold: 900 },
  { panel: true, tab: 'logic', filtered: false, pointer: 'chip', hold: 1000 },
  { panel: true, tab: 'logic', filtered: true, pointer: 'chip', hold: 3200 },
];

/** What a still frame shows (reduced motion, or paused on the last frame): the finished result. */
const STILL: Phase = { panel: false, tab: 'data', filtered: true, pointer: null, hold: 0 };

type Anchor = 'edit' | 'logic' | 'chip';

/**
 * "Logic at every turn": a scripted walkthrough on a to-do list. A pointer opens Edit, then
 * Logic, picks "Only important", and the list drops the rest and re-sorts. It is a picture of the
 * app, so assistive tech gets one sentence instead; people can pause it, and with reduced motion
 * it stays on the finished frame.
 */
export function LogicDemo() {
  const { t, i18n } = useTranslation();
  const lang = demoLanguage(i18n.language);
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const still = reduced || paused;
  const phase = still ? STILL : (SCRIPT[index] ?? STILL);

  useEffect(() => {
    if (still) {
      return undefined;
    }
    const id = window.setTimeout(() => {
      setIndex((current) => (current + 1) % SCRIPT.length);
    }, phase.hold);
    return () => {
      window.clearTimeout(id);
    };
  }, [index, still, phase.hold]);

  const stage = useRef<HTMLDivElement>(null);
  const anchors = useRef<Partial<Record<Anchor, HTMLElement | null>>>({});
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const target = phase.pointer;

  useEffect(() => {
    // Measured a frame later: the panel may still be sliding in when the frame changes.
    const frame = window.requestAnimationFrame(() => {
      const stageBox = stage.current?.getBoundingClientRect();
      const box = target ? anchors.current[target]?.getBoundingClientRect() : undefined;
      if (!stageBox || !box) {
        setPointer(null);
        return;
      }
      // The pointer's tip lands in the lower part of the target, like a real click.
      setPointer({
        x: box.left - stageBox.left + box.width * 0.55,
        y: box.top - stageBox.top + box.height * 0.6,
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [target, phase.panel, phase.tab, phase.filtered]);

  const visible = ROWS.filter((row) => !phase.filtered || row.important);
  const slotOf = (id: string): number => visible.findIndex((row) => row.id === id);
  const bind = (name: Anchor) => (element: HTMLElement | null) => {
    anchors.current[name] = element;
  };

  return (
    <section aria-labelledby="logic-title" className="border-t py-[72px] lg:py-28">
      <Container className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:items-center lg:gap-8">
        <div className="flex flex-col lg:order-2 lg:col-span-5">
          <h2
            id="logic-title"
            className="max-w-[16ch] text-[1.875rem] leading-[1.1] font-semibold tracking-[-0.02em] text-balance lg:text-[2.75rem]"
          >
            {t('landing.logic.title')}
          </h2>
          <p className="mt-5 max-w-[42ch] text-muted-foreground">{t('landing.logic.body')}</p>
          <p className="mt-4 max-w-[42ch] text-sm text-muted-foreground">
            {t('landing.logic.steps')}
          </p>
          {reduced ? null : (
            <button
              type="button"
              onClick={() => {
                setPaused((value) => !value);
              }}
              className="mt-6 inline-flex min-h-10 w-fit items-center gap-2 rounded-full border px-4 text-sm hover:bg-accent"
            >
              {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
              {paused ? t('landing.logic.play') : t('landing.logic.pause')}
            </button>
          )}
        </div>

        <div className="lg:order-1 lg:col-span-7">
          <p className="sr-only">{t('landing.logic.description')}</p>
          <div
            ref={stage}
            aria-hidden="true"
            className="relative overflow-hidden rounded-lg border bg-sunken p-3 sm:p-5"
          >
            <Block className="relative overflow-hidden">
              <div
                className="flex items-center justify-between gap-3 px-4"
                style={{ height: HEADER_HEIGHT }}
              >
                <p className="truncate text-sm font-semibold">{t('landing.dashboard.openTodos')}</p>
                <span className="flex items-center gap-3 text-[13px] text-muted-foreground">
                  <span className="tabular-nums">
                    {t('landing.logic.count', { shown: visible.length, total: ROWS.length })}
                  </span>
                  <span
                    ref={bind('edit')}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-foreground transition-colors',
                      phase.panel && 'border-foreground bg-accent',
                    )}
                  >
                    <Pencil className="size-3.5" />
                    {t('landing.dashboard.edit')}
                  </span>
                </span>
              </div>
              <ul className="relative border-t" style={{ height: ROWS.length * ROW_HEIGHT }}>
                {ROWS.map((row) => {
                  const slot = slotOf(row.id);
                  const shown = slot !== -1;
                  return (
                    <li
                      key={row.id}
                      className={cn(
                        'absolute inset-x-0 top-0 flex items-center gap-3 border-b px-4 text-sm transition-[transform,opacity] duration-700 ease-[cubic-bezier(0.3,0.7,0.2,1)] motion-reduce:transition-none',
                        !shown && 'pointer-events-none opacity-0',
                      )}
                      style={{
                        height: ROW_HEIGHT,
                        transform: `translateY(${String(
                          (shown ? slot : ROWS.indexOf(row)) * ROW_HEIGHT,
                        )}px)`,
                      }}
                    >
                      <SourceDot source={row.source} />
                      <span className="min-w-0 flex-1 truncate">{row.title[lang]}</span>
                      {row.important ? (
                        <Flag className="size-3.5 shrink-0 fill-primary text-primary" />
                      ) : null}
                      <span className="w-16 shrink-0 text-end text-[13px] text-muted-foreground">
                        {row.due[lang]}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Block>

            <div
              className={cn(
                'absolute inset-y-3 end-3 z-10 flex w-[68%] max-w-[300px] flex-col rounded-lg border bg-card transition-[transform,opacity] duration-500 sm:inset-y-5 sm:end-5 motion-reduce:transition-none',
                phase.panel
                  ? 'translate-x-0 opacity-100'
                  : 'pointer-events-none translate-x-6 opacity-0 rtl:-translate-x-6',
              )}
            >
              <div className="flex h-12 items-center justify-between border-b ps-4 pe-2.5">
                <p className="text-sm font-semibold">{t('landing.dashboard.openTodos')}</p>
                <X className="size-4 text-muted-foreground" />
              </div>
              <div className="flex gap-4 border-b px-4 text-sm">
                {(['data', 'logic'] as const).map((tab) => (
                  <span
                    key={tab}
                    ref={tab === 'logic' ? bind('logic') : undefined}
                    className={cn(
                      'flex h-10 items-center border-b-2',
                      phase.tab === tab
                        ? 'border-foreground font-medium'
                        : 'border-transparent text-muted-foreground',
                    )}
                  >
                    {t(`landing.logic.tabs.${tab}`)}
                  </span>
                ))}
              </div>
              <div className="flex flex-col gap-3 p-4 text-sm">
                <p className="text-[13px] text-muted-foreground">
                  {phase.tab === 'logic' ? t('landing.logic.show') : t('landing.logic.sources')}
                </p>
                {phase.tab === 'logic' ? (
                  <div className="flex flex-wrap gap-2">
                    <span
                      className={cn(
                        'inline-flex h-8 items-center rounded-full border px-3',
                        !phase.filtered && 'border-foreground bg-accent font-medium',
                      )}
                    >
                      {t('landing.logic.all')}
                    </span>
                    <span
                      ref={bind('chip')}
                      className={cn(
                        'inline-flex h-8 items-center rounded-full border px-3 transition-colors',
                        phase.filtered && 'border-foreground bg-accent font-medium',
                      )}
                    >
                      {t('landing.logic.important')}
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {(['moodle', 'jira', 'github'] as const).map((source) => (
                      <span key={source} className="flex h-8 items-center rounded-md border px-3">
                        <SourceDot source={source} showName />
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {pointer ? (
              <MousePointer2
                className="pointer-events-none absolute top-0 left-0 z-20 size-5 fill-foreground text-background transition-transform duration-700 ease-out motion-reduce:transition-none"
                style={{ transform: `translate(${String(pointer.x)}px, ${String(pointer.y)}px)` }}
              />
            ) : null}
          </div>
        </div>
      </Container>
    </section>
  );
}
