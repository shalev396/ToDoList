import { useTranslation } from 'react-i18next';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { cn } from '@/lib/utils';
import { limits } from '@/data/limits';
import { app } from '@/data/app';

export type FaqKey =
  | 'free'
  | 'limits'
  | 'sources'
  | 'sharing'
  | 'tokens'
  | 'agents'
  | 'languages'
  | 'openSource'
  | 'leave';

interface FaqProps {
  /** Which questions to show, in order. */
  items: readonly FaqKey[];
  className?: string | undefined;
}

/** Common questions: the heading on the start side, the answers in an accordion. */
export function Faq({ items, className }: FaqProps) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="faq-title" className={cn('py-[72px] lg:py-32', className)}>
      <div className="mx-auto grid grid-cols-1 w-full max-w-[1200px] gap-8 px-4 sm:px-6 lg:grid-cols-12 lg:px-8">
        <h2
          id="faq-title"
          className="text-[1.875rem] leading-[1.1] font-semibold tracking-[-0.02em] lg:col-span-4 lg:text-[2.75rem]"
        >
          {t('faq.title')}
        </h2>
        <Accordion type="single" collapsible className="border-t lg:col-span-8">
          {items.map((key) => (
            <AccordionItem key={key} value={key}>
              <AccordionTrigger className="py-5 text-start text-base font-medium hover:no-underline">
                {t(`faq.${key}.question`)}
              </AccordionTrigger>
              <AccordionContent className="max-w-[64ch] pb-5 text-[15px] leading-relaxed text-muted-foreground">
                {t(`faq.${key}.answer`, limits)}
                {key === 'openSource' ? (
                  <>
                    {' '}
                    <a
                      href={app.repositoryUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-sm text-foreground underline decoration-border underline-offset-4 hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {t('faq.openSource.link')}
                      <span className="sr-only"> {t('footer.newTab')}</span>
                    </a>
                  </>
                ) : null}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
