import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CircleAlert, LayoutTemplate, Sparkles } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import { useInstantiatePersona, usePersonas, useTemplates } from '@/api/queries/builder';
import { useCreateDashboard } from '@/api/queries/dashboards';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { pageTitle } from '@/data/pageTitles';
import { blockDefaultSize, blockEntry } from '@/features/dashboards/registry';
import { EmptyIcon, EmptyState } from '@/features/shell/EmptyState';
import { PageContainer, PageHeader } from '@/features/shell/PageHeader';
import {
  cardTopicId,
  miniLayout,
  miniRows,
  needsTopic,
  pathForScope,
} from '@/features/templates/preview';
import { useTemplateShareConfirm } from '@/features/templates/useTemplateShareConfirm';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, topicPath } from '@/router/routes';
import type { DashboardScope } from '@api-types/builder';
import type { PersonaSummary, TemplateSummary } from '@api-types/dashboards';
import type { TopicView } from '@api-types/api-contracts';

/** The template's blocks on the 12-column grid, one tile per block with its type's icon. */
function MiniPreview({ template }: { template: TemplateSummary }) {
  const { t } = useTranslation();
  const blocks = miniLayout(template.blockTypes, blockDefaultSize);
  return (
    <div
      role="img"
      aria-label={t('templates.previewLabel', { count: blocks.length })}
      className="grid grid-cols-12 gap-[3px] rounded-md bg-sunken p-2"
      style={{ gridAutoRows: '3px', minHeight: `${String(miniRows(blocks) * 3 + 16)}px` }}
    >
      {blocks.map((block, position) => {
        const Icon = blockEntry(block.type)?.icon;
        return (
          <span
            key={position}
            data-mini-block={block.type}
            className="flex items-center justify-center rounded-[3px] border bg-card text-muted-foreground"
            style={{
              gridColumn: `${String(block.x + 1)} / span ${String(block.w)}`,
              gridRow: `${String(block.y + 1)} / span ${String(block.h)}`,
            }}
          >
            {Icon === undefined || block.h < 4 ? null : (
              <Icon aria-hidden="true" className="size-3.5" />
            )}
          </span>
        );
      })}
    </div>
  );
}

function TemplateCard({ template, topics }: { template: TemplateSummary; topics: TopicView[] }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { workspace } = useCurrentWorkspace();
  const navigate = useNavigate();
  const create = useCreateDashboard(workspace?.id ?? '');
  const shareConfirm = useTemplateShareConfirm(workspace?.id ?? '');
  // Null until a topic is picked here: till then the card follows the suggestion, which can
  // only be made once the workspace's topics have loaded.
  const [picked, setPicked] = useState<string | null>(null);
  const topicId = cardTopicId(template.key, topics, picked);
  const [error, setError] = useState<string | null>(null);
  const lang = language === 'he' ? 'he' : 'en';
  const title = template.titles[lang];
  const askTopic = needsTopic(template.key);

  const use = async () => {
    if (workspace === null) {
      return;
    }
    if (askTopic && topicId === '') {
      setError(t('templates.pickTopic'));
      return;
    }
    setError(null);
    // Templates never share silently: ask first when they would attach unshared connections.
    const choice = await shareConfirm.ask([template.key]);
    if (choice === null) {
      return;
    }
    const scope: Partial<DashboardScope> | undefined = askTopic ? { topicId } : undefined;
    create.mutate(
      {
        body: {
          fromTemplate: template.key,
          language: lang,
          shareIntegrations: choice.shareIntegrations,
          ...(scope === undefined ? {} : { scope }),
        },
        filter: {},
      },
      {
        onSuccess: (created) => {
          void navigate(
            `${pathTo(pathForScope(created.scope, topics), language)}?dashboard=${created.id}`,
          );
        },
        onError: (failure) => {
          setError(errorMessage(t, failure, 'templates.createFailed'));
        },
      },
    );
  };

  return (
    <article
      data-template={template.key}
      aria-label={title}
      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"
    >
      <MiniPreview template={template} />
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold" dir="auto">
          {title}
        </h2>
        <p className="text-[13px] text-muted-foreground">
          {t('templates.blockCount', { count: template.blockTypes.length })}
        </p>
      </div>
      {askTopic ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`topic-${template.key}`} className="text-[13px] font-medium">
            {t('templates.topic')}
          </label>
          <SelectField
            id={`topic-${template.key}`}
            value={topicId}
            onValueChange={setPicked}
            options={[
              { value: '', label: t('templates.topicPlaceholder') },
              ...topics.map((topic) => ({ value: topic.id, label: topic.name })),
            ]}
          />
        </div>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        className="mt-auto w-fit max-md:h-11"
        disabled={create.isPending || shareConfirm.checking}
        onClick={() => {
          void use();
        }}
      >
        {t(create.isPending ? 'templates.using' : 'templates.use')}
      </Button>
      {shareConfirm.dialog}
    </article>
  );
}

/**
 * A persona's pages as thumbnails: one mini layout per topic (its page template's blocks), named
 * by the topic, with the views it adds as chips. A picture of what you get, not the data.
 */
function PersonaPreview({
  persona,
  templates,
  lang,
}: {
  persona: PersonaSummary;
  templates: readonly TemplateSummary[];
  lang: 'en' | 'he';
}) {
  const { t } = useTranslation();
  return (
    <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2" data-persona-topics>
      {persona.topics.map((topic) => {
        const page = templates.find((template) => template.key === topic.page);
        return (
          <li key={topic.slug} data-persona-topic={topic.slug} className="flex flex-col gap-1.5">
            {page === undefined ? null : <MiniPreview template={page} />}
            <p className="text-[13px] font-medium" dir="auto">
              {topic.names[lang]}
            </p>
            <p className="flex flex-wrap gap-1 text-xs text-muted-foreground">
              {topic.views.map((view) => (
                <span key={view.key} className="rounded-full border px-2 py-0.5" dir="auto">
                  {view.titles[lang]}
                </span>
              ))}
              <span className="sr-only">
                {t('templates.persona.viewsCount', { count: topic.views.length })}
              </span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function PersonaCard({
  persona,
  templates,
  canCreate,
}: {
  persona: PersonaSummary;
  templates: readonly TemplateSummary[];
  canCreate: boolean;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { workspace } = useCurrentWorkspace();
  const navigate = useNavigate();
  const create = useInstantiatePersona(workspace?.id ?? '');
  const shareConfirm = useTemplateShareConfirm(workspace?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const lang = language === 'he' ? 'he' : 'en';

  const use = async () => {
    if (workspace === null) {
      return;
    }
    setError(null);
    // Personas never share silently either: ask first when they would attach unshared connections.
    const choice = await shareConfirm.ask([persona.key]);
    if (choice === null) {
      return;
    }
    create.mutate(
      { key: persona.key, language: lang, shareIntegrations: choice.shareIntegrations },
      {
        onSuccess: (result) => {
          const first = result.topics[0];
          void navigate(
            first === undefined
              ? pathTo('dashboard', language)
              : `${pathTo(topicPath(first.slug), language)}?dashboard=${first.dashboardId}`,
          );
        },
        onError: (failure) => {
          setError(errorMessage(t, failure, 'templates.persona.createFailed'));
        },
      },
    );
  };

  return (
    <article
      data-persona={persona.key}
      aria-label={persona.titles[lang]}
      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold" dir="auto">
          {persona.titles[lang]}
        </h3>
        <p className="text-[13px] text-muted-foreground" dir="auto">
          {persona.descriptions[lang]}
        </p>
        <p className="text-[13px] text-muted-foreground">
          {t('templates.persona.pages', { count: persona.topics.length })}
        </p>
      </div>
      <PersonaPreview persona={persona} templates={templates} lang={lang} />
      {error === null ? null : (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}
      {canCreate ? (
        <Button
          type="button"
          variant="outline"
          className="mt-auto w-fit max-md:h-11"
          data-persona-use
          disabled={create.isPending || shareConfirm.checking}
          onClick={() => {
            void use();
          }}
        >
          {t(create.isPending ? 'templates.persona.using' : 'templates.persona.use')}
        </Button>
      ) : null}
      {shareConfirm.dialog}
    </article>
  );
}

/** The persona gallery: whole setups (topics, pages, views), smallest first. */
function PersonaGallery({
  templates,
  canCreate,
}: {
  templates: readonly TemplateSummary[];
  canCreate: boolean;
}) {
  const { t } = useTranslation();
  const { workspace } = useCurrentWorkspace();
  const personas = usePersonas(workspace?.id ?? '', workspace !== null);
  if (personas.data === undefined || personas.data.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="persona-gallery" className="mb-8" data-persona-gallery>
      <h2 id="persona-gallery" className="mb-1 flex items-center gap-2 text-base font-semibold">
        <Sparkles aria-hidden="true" className="size-4 text-muted-foreground" />
        {t('templates.persona.title')}
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">{t('templates.persona.description')}</p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {personas.data.map((persona) => (
          <PersonaCard
            key={persona.key}
            persona={persona}
            templates={templates}
            canCreate={canCreate}
          />
        ))}
      </div>
    </section>
  );
}

/** The template gallery (BUILDER.md §9): a card per template; Use template creates the page. */
export default function TemplatesPage() {
  const { t } = useTranslation();
  const { workspace, role, topics } = useCurrentWorkspace();
  const canCreate = role === 'owner' || role === 'editor';
  const templates = useTemplates(workspace?.id ?? '', workspace !== null);
  const shown = templates.data ?? [];
  return (
    <PageContainer>
      <PageMetadata title={pageTitle(t('app.templates.title'))} noIndex />
      <PageHeader title={t('app.templates.title')} description={t('templates.description')} />
      {templates.data === undefined ? (
        templates.isError ? (
          <EmptyState
            visual={
              <EmptyIcon>
                <CircleAlert aria-hidden="true" />
              </EmptyIcon>
            }
            title={t('templates.loadError')}
            body={t('connect.loadErrorBody')}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  void templates.refetch();
                }}
              >
                {t('dashboard.retry')}
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-56 rounded-lg" />
            ))}
          </div>
        )
      ) : shown.length === 0 ? (
        <EmptyState
          visual={
            <EmptyIcon>
              <LayoutTemplate aria-hidden="true" />
            </EmptyIcon>
          }
          title={t('templates.emptyTitle')}
          body={t('templates.emptyBody')}
        />
      ) : (
        <>
          {canCreate ? null : (
            <p className="mb-6 text-sm text-muted-foreground">{t('templates.viewerNote')}</p>
          )}
          <PersonaGallery templates={shown} canCreate={canCreate} />
          <h2 className="mb-3 text-base font-semibold">{t('templates.pagesTitle')}</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((template) =>
              canCreate ? (
                <TemplateCard key={template.key} template={template} topics={topics} />
              ) : (
                <TemplateCardReadOnly key={template.key} template={template} />
              ),
            )}
          </div>
        </>
      )}
    </PageContainer>
  );
}

function TemplateCardReadOnly({ template }: { template: TemplateSummary }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  return (
    <article
      data-template={template.key}
      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"
    >
      <MiniPreview template={template} />
      <h2 className="text-sm font-semibold" dir="auto">
        {template.titles[language === 'he' ? 'he' : 'en']}
      </h2>
      <p className="text-[13px] text-muted-foreground">
        {t('templates.blockCount', { count: template.blockTypes.length })}
      </p>
    </article>
  );
}
