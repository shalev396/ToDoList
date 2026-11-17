import { useId, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { SOURCE_STYLES } from '@/components/items/sources';
import type { Provider } from '@/components/items/types';
import {
  angleForTime,
  arcPath,
  assignLanes,
  clipToDay,
  dayArcAngles,
  polar,
} from './ClockRing.math';

export interface ClockEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  source: Provider;
}

export interface ClockRingLabels {
  /** The ring's accessible name: a short summary of the day, written by the caller. */
  summary: string;
  /** Accessible name of the visually hidden list of the day's events. */
  eventList: string;
  /** One event as text, for the hidden list and the hover tooltip ("Lecture, 14:00 to 15:30, Moodle"). */
  describeEvent: (event: ClockEvent) => string;
}

export interface ClockRingProps {
  events: readonly ClockEvent[];
  /** Places the needle, and picks the day the ring shows. */
  now: Date;
  /** IANA zone whose wall clock the ring shows. */
  timeZone: string;
  /** Width and height in px. The ring scales down with a narrower container. */
  size?: number | undefined;
  labels: ClockRingLabels;
  /** Draw the ring in once when it mounts (the landing hero). Never runs with reduced motion. */
  animateIn?: boolean | undefined;
  /** An event whose arc just changed (the landing hero's live sample): it fades in with a halo. */
  emphasize?: string | undefined;
  className?: string | undefined;
}

const TICK_HOURS = [0, 3, 6, 9, 12, 15, 18, 21] as const;
const LABELLED_HOURS = new Set<number>([0, 6, 12, 18]);
/** Surface gap between neighbouring arcs and lanes, in px. */
const GAP = 2;
/** Lanes for overlapping events, outermost first. */
const MAX_LANES = 3;
/**
 * The colour of the surface the ring sits on, for the needle's halo and the hub's ring. A block
 * is a card; set --ring-surface on any ancestor to match another surface.
 */
const SURFACE = { stroke: 'var(--ring-surface, var(--card))' } as const;

/**
 * Today on a 24-hour ring: midnight at the top, running clockwise, one arc per event in its
 * source colour, and an ink needle at now. Events that cross midnight are clipped to the day.
 *
 * Presentational only: the caller passes the events, the time and all accessible text. The ring
 * is never mirrored in right-to-left pages. It assumes a card surface behind it; on another
 * surface, set --ring-surface (e.g. `[--ring-surface:var(--background)]`).
 */
export function ClockRing({
  events,
  now,
  timeZone,
  size = 240,
  labels,
  animateIn = false,
  emphasize,
  className,
}: ClockRingProps) {
  const maskId = useId();
  const half = size / 2;
  const scale = size / 240;
  const showHourLabels = size >= 160;
  // Hour labels sit outside the ring, where the needle never reaches, so they are never covered.
  const labelSpace = showHourLabels ? 17 * scale : 0;
  const outer = half - 1 - labelSpace;
  const band = Math.max(8, Math.round(19 * scale));
  const inner = outer - band;

  const placed = useMemo(() => {
    const onDay = events.flatMap((event) => {
      const clipped = clipToDay(event, now, timeZone);
      const angles = dayArcAngles(event, now, timeZone);
      return clipped && angles ? [{ event, clipped, ...angles }] : [];
    });
    const lanes = assignLanes(
      onDay.map((item) => item.clipped),
      MAX_LANES,
    );
    return onDay.map((item, index) => ({ ...item, lane: lanes[index] ?? 0 }));
  }, [events, now, timeZone]);

  const laneCount = Math.max(1, ...placed.map((item) => item.lane + 1));
  const laneWidth = (band - (laneCount - 1) * GAP) / laneCount;
  const listed = [...placed].sort((a, b) => a.clipped.start.getTime() - b.clipped.start.getTime());
  const needleAngle = angleForTime(now, timeZone);
  const tick = (hour: number) => {
    const angle = (hour / 24) * 360;
    const length = (LABELLED_HOURS.has(hour) ? 6 : 4) * scale;
    const from = polar(inner - 3 * scale, angle);
    const to = polar(inner - 3 * scale - length, angle);
    return { hour, angle, from, to };
  };

  return (
    <div className={cn('relative', className)}>
      <svg
        role="img"
        aria-label={labels.summary}
        width={size}
        height={size}
        viewBox={`${String(-half)} ${String(-half)} ${String(size)} ${String(size)}`}
        className={cn('block h-auto max-w-full', animateIn && 'clock-ring-animate')}
        style={{ direction: 'ltr' }}
      >
        {animateIn ? (
          <defs>
            <mask
              id={maskId}
              maskUnits="userSpaceOnUse"
              x={-half}
              y={-half}
              width={size}
              height={size}
            >
              {/* A stroke from the centre to past the corners, so it covers the labels too. */}
              <circle
                className="clock-ring-sweep"
                r={half * 0.75}
                fill="none"
                stroke="white"
                strokeWidth={half * 1.5}
                pathLength={1}
                transform="rotate(-90)"
              />
            </mask>
          </defs>
        ) : null}

        <g mask={animateIn ? `url(#${maskId})` : undefined}>
          <path
            className="fill-sunken"
            d={arcPath({ innerRadius: inner, outerRadius: outer, startAngle: 0, endAngle: 360 })}
          />
          {placed.map(({ event, startAngle, endAngle, lane }) => {
            const laneOuter = outer - lane * (laneWidth + GAP);
            return (
              <path
                // A new key restarts the arc's fade-in when it is the one that just changed.
                key={
                  event.id === emphasize ? `${event.id}-${String(event.start.getTime())}` : event.id
                }
                className={cn(
                  SOURCE_STYLES[event.source].fill,
                  event.id === emphasize && 'clock-arc-fresh',
                )}
                d={arcPath({
                  innerRadius: laneOuter - laneWidth,
                  outerRadius: laneOuter,
                  startAngle,
                  endAngle,
                  gap: GAP,
                  minLength: 1.5,
                })}
              >
                <title>{labels.describeEvent(event)}</title>
              </path>
            );
          })}
          {TICK_HOURS.map(tick).map(({ hour, from, to }) => (
            <line
              key={hour}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              className="stroke-muted-foreground"
              strokeWidth={1}
              strokeLinecap="round"
            />
          ))}
          {showHourLabels
            ? TICK_HOURS.filter((hour) => LABELLED_HOURS.has(hour)).map((hour) => {
                const at = polar(outer + labelSpace / 2 + 1, (hour / 24) * 360);
                return (
                  <text
                    key={hour}
                    x={at.x}
                    y={at.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="fill-muted-foreground tabular-nums"
                    style={{ fontSize: Math.max(10, 11 * scale) }}
                  >
                    {String(hour).padStart(2, '0')}
                  </text>
                );
              })
            : null}
        </g>

        <g className="clock-ring-needle" style={{ transform: `rotate(${String(needleAngle)}deg)` }}>
          <line
            x1={0}
            y1={0}
            x2={0}
            y2={-outer}
            style={SURFACE}
            strokeWidth={5}
            strokeLinecap="round"
          />
          <line
            x1={0}
            y1={0}
            x2={0}
            y2={-outer}
            className="stroke-foreground"
            strokeWidth={2}
            strokeLinecap="round"
          />
        </g>
        <circle
          r={Math.max(3, 4.5 * scale)}
          className="fill-foreground"
          style={SURFACE}
          strokeWidth={2}
        />
      </svg>

      <ul className="sr-only" aria-label={labels.eventList}>
        {listed.map(({ event }) => (
          <li key={event.id}>{labels.describeEvent(event)}</li>
        ))}
      </ul>
    </div>
  );
}
