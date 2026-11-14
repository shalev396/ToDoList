import { useTranslation } from 'react-i18next';
import { sourceNameKey } from '@/components/items/sources';
import { isComingSoon } from '@/features/integrations/providers';
import { Container } from './layout';
import { ProviderIcon, type IconName } from './ProviderIcon';

const STRIP: readonly Exclude<IconName, 'mcp'>[] = [
  'jira',
  'clickup',
  'linear',
  'google_calendar',
  'github',
  'moodle',
];

/** The tools TodoList reads from, named with their marks in plain ink. */
export function SourcesStrip() {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="sources-title" className="border-y bg-card">
      <Container className="flex flex-col gap-6 py-10 lg:flex-row lg:items-center lg:gap-12">
        <h2
          id="sources-title"
          className="max-w-[30ch] text-[15px] leading-snug font-normal tracking-normal text-muted-foreground lg:shrink-0"
        >
          {t('landing.sources.title')}
        </h2>
        <ul className="grid flex-1 grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4 lg:flex lg:flex-wrap lg:justify-between">
          {STRIP.map((source) => (
            <li
              key={source}
              className="flex items-center gap-2.5 text-[15px] font-medium text-foreground"
            >
              <ProviderIcon name={source} className="size-[18px] text-muted-foreground" />
              <span>{t(sourceNameKey(source))}</span>
              {isComingSoon(source) ? (
                <span className="rounded-full border px-2 py-0.5 text-[12px] font-normal text-muted-foreground">
                  {t('connect.signin.comingSoon')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
