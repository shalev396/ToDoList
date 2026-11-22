import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { dateLocale } from '@/components/items/format';
import { app } from '@/data';
import { pageTitle } from '@/data/pageTitles';

/** The date the legal text was last changed. Update it with the text. */
const LAST_UPDATED = new Date(2026, 10, 23);

export interface LegalDocumentProps {
  doc: 'privacy' | 'terms';
  /** Section keys under legal.<doc>.sections, in reading order. */
  sections: readonly string[];
  /** The other legal page, linked at the end. */
  other: { to: string; label: string };
}

/**
 * Where each link tag in the legal text points: `<aws>Amazon’s privacy notice</aws>` links its
 * label to LINKS.aws. Every URL here was checked to resolve when the text was written.
 */
const LINKS: Readonly<Record<string, string>> = {
  /** Google's policy that the Limited Use statement (privacy, googleLimitedUse) links to. */
  policy: 'https://developers.google.com/terms/api-services-user-data-policy',
  permissions: 'https://myaccount.google.com/permissions',
  aws: 'https://aws.amazon.com/privacy/',
  mongodb: 'https://www.mongodb.com/legal/privacy/privacy-policy',
  google: 'https://policies.google.com/privacy',
  atlassian: 'https://www.atlassian.com/legal/privacy-policy',
  clickup: 'https://clickup.com/terms/privacy',
  linear: 'https://linear.app/privacy',
  github:
    'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement',
  moodle: 'https://moodle.com/privacy-notice/',
  repo: app.repositoryUrl,
};

/** Israel's Privacy Protection Authority, in the reader's language. */
const PRIVACY_AUTHORITY_URL = {
  en: 'https://www.gov.il/en/departments/the_privacy_protection_authority',
  he: 'https://www.gov.il/he/departments/the_privacy_protection_authority',
} as const;

/** A link tag: `<name>label</name>`, lower-case letters only, no nesting. */
const LINK_TAG = /<([a-z]+)>([^<]*)<\/\1>/g;

/** How a bullet line of a list paragraph starts. */
const BULLET = '- ';

const inlineLink =
  'rounded-sm text-foreground underline decoration-border underline-offset-4 hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/** One link of the text: the contact email opens mail, every other one opens in a new tab. */
function LegalLink({ href, children }: { href: string; children: ReactNode }) {
  if (href.startsWith('mailto:')) {
    return (
      <a href={href} className={inlineLink}>
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={inlineLink}>
      {children}
    </a>
  );
}

/** The text with its link tags made links; a tag with no known address stays plain text. */
function withLinks(text: string, hrefs: Readonly<Record<string, string>>): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_TAG)) {
    const [whole, name = '', label = ''] = match;
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }
    const href = hrefs[name];
    parts.push(
      href === undefined ? (
        label
      ) : (
        <LegalLink key={match.index} href={href}>
          {label}
        </LegalLink>
      ),
    );
    last = match.index + whole.length;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts;
}

/**
 * A section body: paragraphs separated by a blank line. A paragraph whose every line starts with
 * "- " is a bulleted list. Any paragraph or bullet may carry link tags.
 */
function SectionBody({ body, hrefs }: { body: string; hrefs: Readonly<Record<string, string>> }) {
  return body.split('\n\n').map((paragraph, index) => {
    const lines = paragraph.split('\n');
    if (lines.every((line) => line.startsWith(BULLET))) {
      return (
        <ul
          key={index}
          className="mt-3 flex list-disc flex-col gap-2 ps-5 leading-relaxed text-muted-foreground"
        >
          {lines.map((line, item) => (
            <li key={item}>{withLinks(line.slice(BULLET.length), hrefs)}</li>
          ))}
        </ul>
      );
    }
    return (
      <p key={index} className="mt-3 leading-relaxed text-muted-foreground">
        {withLinks(paragraph, hrefs)}
      </p>
    );
  });
}

/**
 * A plain-language legal page: title and date, a list of contents on wide screens, then each
 * section. A body may hold several paragraphs and bulleted lists, with links in any of them.
 */
export function LegalDocument({ doc, sections, other }: LegalDocumentProps) {
  const { t, i18n } = useTranslation();
  const vars = { contactEmail: app.contactEmail };
  const hrefs: Readonly<Record<string, string>> = {
    ...LINKS,
    email: `mailto:${app.contactEmail}`,
    authority: i18n.language === 'he' ? PRIVACY_AUTHORITY_URL.he : PRIVACY_AUTHORITY_URL.en,
  };
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
              <SectionBody body={t(`legal.${doc}.sections.${id}.body`, vars)} hrefs={hrefs} />
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
