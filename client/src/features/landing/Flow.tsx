import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, UserPlus } from 'lucide-react';
import { initials } from '@/components/items/format';
import { SOURCE_STYLES, sourceNameKey } from '@/components/items/sources';
import { cn } from '@/lib/utils';
import { demoLanguage, demoMembers } from './demoData';
import { Container } from './layout';
import { ProviderIcon, type IconName } from './ProviderIcon';

/** Moves a scene part in with its own delay; see .landing-snap in index.css. */
function snap(index: number, from: string): CSSProperties {
  return { '--i': index, '--from': from } as CSSProperties;
}

const CONNECTED: readonly Exclude<IconName, 'mcp'>[] = [
  'moodle',
  'jira',
  'google_calendar',
  'github',
];

/** Provider rows snapping into a workspace, each ending on a check. */
function ConnectScene() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      {CONNECTED.map((source, index) => (
        <div
          key={source}
          style={snap(index, 'translateX(-28px)')}
          className="landing-snap flex h-10 items-center gap-3 rounded-md border bg-card ps-3 pe-2.5 text-sm"
        >
          <ProviderIcon name={source} className="size-4 text-muted-foreground" />
          <span className="flex-1 truncate">{t(sourceNameKey(source))}</span>
          <span
            className={cn(
              'flex size-5 items-center justify-center rounded-full text-background',
              SOURCE_STYLES[source].bg,
            )}
          >
            <Check className="size-3" strokeWidth={3} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** A page assembling itself from blocks, under the template's name. */
function BuildScene() {
  const { t } = useTranslation();
  const slot = 'landing-snap rounded-md border bg-card';
  return (
    <div className="flex h-full flex-col justify-center gap-3">
      <div className="flex gap-1.5">
        {(['college', 'work', 'personal'] as const).map((template) => (
          <span
            key={template}
            className={cn(
              'inline-flex h-6 items-center rounded-full border px-2.5 text-xs',
              template === 'college' ? 'border-foreground font-medium' : 'text-muted-foreground',
            )}
          >
            {t(`landing.templates.${template}`)}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-6 grid-rows-[56px_56px] gap-2">
        <div
          style={snap(0, 'scale(0.85)')}
          className={cn(slot, 'col-span-2 grid place-items-center')}
        >
          <span className="size-9 rounded-full border-[5px] border-sunken border-t-source-moodle border-e-source-moodle" />
        </div>
        <div
          style={snap(1, 'scale(0.85)')}
          className={cn(slot, 'col-span-4 flex flex-col justify-center gap-2 px-3')}
        >
          <span className="h-2 w-4/5 rounded-full bg-source-jira/70" />
          <span className="h-2 w-3/5 rounded-full bg-source-moodle/70" />
          <span className="h-2 w-2/5 rounded-full bg-source-github/70" />
        </div>
        <div
          style={snap(2, 'scale(0.85)')}
          className={cn(slot, 'col-span-3 flex flex-col justify-center gap-2 px-3')}
        >
          <span className="h-2 w-full rounded-full bg-sunken" />
          <span className="h-2 w-2/3 rounded-full bg-sunken" />
        </div>
        <div
          style={snap(3, 'scale(0.85)')}
          className={cn(slot, 'col-span-3 flex items-end gap-1.5 p-3')}
        >
          {[40, 70, 52, 90].map((height, index) => (
            <span
              key={index}
              className="flex-1 rounded-[2px] bg-source-linear/70"
              style={{ height: `${String(height)}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** An invite landing in the workspace, with the access it gives. */
function ShareScene() {
  const { t, i18n } = useTranslation();
  const people = demoMembers(demoLanguage(i18n.language)).slice(1);
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      {people.map((member, index) => (
        <div
          key={member.id}
          style={snap(index, 'translateY(-18px)')}
          className="landing-snap flex h-12 items-center gap-3 rounded-md border bg-card ps-3 pe-3 text-sm"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sunken text-[11px] font-medium">
            {initials(member.name)}
          </span>
          <span className="flex-1 truncate">{member.name}</span>
          <span className="inline-flex h-6 items-center rounded-full border px-2.5 text-xs text-muted-foreground">
            {t(`landing.roles.${member.role === 'editor' ? 'editor' : 'viewer'}`)}
          </span>
        </div>
      ))}
      <div
        style={snap(people.length, 'translateY(-18px)')}
        className="landing-snap flex h-9 items-center justify-center gap-2 rounded-md border border-dashed text-[13px] text-muted-foreground"
      >
        <UserPlus className="size-4" />
        {t('landing.sharing.invite')}
      </div>
    </div>
  );
}

const FLOW: readonly { key: 'connect' | 'build' | 'share'; Scene: () => ReactNode }[] = [
  { key: 'connect', Scene: ConnectScene },
  { key: 'build', Scene: BuildScene },
  { key: 'share', Scene: ShareScene },
];

/**
 * Connect, build, share: three small scenes that play on a loop, each with a title and one line.
 * The scenes are pictures; the words carry the meaning, so they are hidden from screen readers.
 * It is the order things happen in, but nothing is numbered: the scenes read left to right.
 */
export function Flow() {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="flow-title" className="py-[72px] lg:py-32">
      <Container>
        <h2
          id="flow-title"
          className="max-w-[20ch] text-[1.875rem] leading-[1.1] font-semibold tracking-[-0.02em] text-balance lg:text-[2.75rem]"
        >
          {t('landing.flow.title')}
        </h2>
        <ul className="mt-12 grid grid-cols-1 gap-6 md:mt-16 md:grid-cols-3 md:gap-8">
          {FLOW.map(({ key, Scene }) => (
            <li key={key} className="flex flex-col gap-5">
              <div
                aria-hidden="true"
                className="h-[248px] overflow-hidden rounded-lg border bg-sunken p-4"
              >
                <Scene />
              </div>
              <div>
                <h3 className="text-[1.3125rem] leading-tight font-semibold tracking-[-0.01em]">
                  {t(`landing.flow.${key}.title`)}
                </h3>
                <p className="mt-2 max-w-[34ch] text-muted-foreground">
                  {t(`landing.flow.${key}.body`)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
