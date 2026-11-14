import { useTranslation } from 'react-i18next';
import { Everyone } from './Everyone';
import { TimeDemo } from './demos/TimeDemo';
import { Container } from './layout';
import { LogicDemo } from './LogicDemo';
import { Showcase } from './Showcase';

/** The time section: today as a clock, the week as a calendar. */
function Time({ now, timeZone }: { now: Date; timeZone: string }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="time-title" className="border-t py-[72px] lg:py-28">
      <Container className="flex flex-col gap-8">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:gap-8">
          <h2
            id="time-title"
            className="max-w-[20ch] text-[1.875rem] leading-[1.1] font-semibold tracking-[-0.02em] text-balance lg:col-span-7 lg:text-[2.75rem]"
          >
            {t('landing.features.time.title')}
          </h2>
          <p className="max-w-[48ch] text-muted-foreground lg:col-span-5 lg:self-end">
            {t('landing.features.time.body')}
          </p>
        </div>
        <TimeDemo now={now} timeZone={timeZone} />
      </Container>
    </section>
  );
}

/**
 * Everything the product does, on sample data: who it is for, the day and week, the logic behind
 * a block, and one rotating showcase. The nav's Features link lands here.
 */
export function Features({ now, timeZone }: { now: Date; timeZone: string }) {
  return (
    <div id="features" className="scroll-mt-20 border-t">
      <Everyone now={now} timeZone={timeZone} />
      <Time now={now} timeZone={timeZone} />
      <LogicDemo />
      <Showcase now={now} timeZone={timeZone} />
    </div>
  );
}
