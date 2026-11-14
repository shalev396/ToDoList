import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { dateLocale } from '@/components/items/format';
import { app } from '@/data';
import { pageTitle } from '@/data/pageTitles';

/** The date the legal text was last changed. Update it with the text. */
const LAST_UPDATED = new Date(2026, 10, 13);

export interface LegalDocumentProps {
  doc: 'privacy' | 'terms';
  /** Section keys under legal.<doc>.sections, in reading order. */
  sections: readonly string[];
  /** The other legal page, linked at the end. */
  other: { to: string; label: string };
}

const inlineLink =
  'rounded-sm text-foreground underline decoration-border underline-offset-4 hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/**
 * A plain-language legal page: title, date and the draft-for-review note, a list of contents on
 * wide screens, then each section. A body may hold several paragraphs separated by a blank line;
 * the contact section carries links.
 */
export function LegalDocument({ doc, sections, other }: LegalDocumentProps) {
  const { t, i18n } = useTranslation();
  const vars = { contactEmail: app.contactEmail };
  const updated = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(LAST_UPDATED);

  return (
    <article className="mx-auto w-full max-w-[1200px] px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
      <PageMetadata title={pageTitle(t(`legal.${doc}.metaTitle`))} />
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-8">
        <header className="lg:col-span-8 lg:col-start-4">
          <h1 className="text-[2.75rem] leading-[1.05] font-semibold tracking-[-0.02em] text-balance">
            {t(`legal.${doc}.title`)}
          </h1>
          <p className="mt-4 text-sm text-muted-foreground">
            {t('legal.lastUpdated', { date: updated })}
          </p>
          <p
            role="note"
            className="mt-8 flex gap-3 rounded-lg border bg-card p-4 text-[15px] leading-relaxed"
          >
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-status-warning"
            />
            {t('legal.reviewNote')}
          </p>
          <p className="mt-8 max-w-[68ch] text-lg leading-relaxed text-muted-foreground">
            {t(`legal.${doc}.intro`)}
          </p>
        </header>

        <nav
          aria-label={t('legal.contents')}
          className="hidden lg:col-span-3 lg:row-start-2 lg:block"
        >
          <div className="sticky top-24">
            <p className="text-[13px] font-medium text-foreground">{t('legal.contents')}</p>
            <ol className="mt-3 flex flex-col gap-2 text-[13px]">
              {sections.map((id) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {t(`legal.${doc}.sections.${id}.title`)}
                  </a>
                </li>
              ))}
            </ol>
          </div>
        </nav>

        <div className="flex max-w-[68ch] flex-col gap-10 lg:col-span-8 lg:col-start-4 lg:row-start-2">
          {sections.map((id) => (
            <section key={id} id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24">
              <h2
                id={`${id}-title`}
                className="text-[1.3125rem] leading-tight font-semibold tracking-[-0.01em]"
              >
                {t(`legal.${doc}.sections.${id}.title`)}
              </h2>
              {id === 'contact' || id === 'openSource' ? (
                <p className="mt-3 leading-relaxed text-muted-foreground">
                  <Trans
                    i18nKey={`legal.${doc}.sections.${id}.body`}
                    values={vars}
                    components={{
                      email: <a href={`mailto:${app.contactEmail}`} className={inlineLink} />,
                      repo: (
                        <a
                          href={app.repositoryUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={inlineLink}
                        />
                      ),
                    }}
                  />
                </p>
              ) : (
                t(`legal.${doc}.sections.${id}.body`, vars)
                  .split('\n\n')
                  .map((paragraph) => (
                    <p key={paragraph} className="mt-3 leading-relaxed text-muted-foreground">
                      {paragraph}
                    </p>
                  ))
              )}
            </section>
          ))}
          <p className="border-t pt-6 text-sm">
            <Link to={other.to} className={inlineLink}>
              {other.label}
            </Link>
          </p>
        </div>
      </div>
    </article>
  );
}
