import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import { apiErrorStatus, errorMessage } from '@/api/errors';
import { queryKeys } from '@/api/queries/keys';
import { runQuery } from '@/api/services/queryService';
import { dateLocale } from '@/components/items/format';
import { PREVIEW_DEBOUNCE_MS, useDebounced } from './useDebounced';
import { useLanguage } from '@/hooks/useLanguage';
import { CAPS, type QueryRequest } from '@api-types/builder';
import type { QueryGroup, QueryRow } from '@api-types/builder';

function rowTitle(row: QueryRow): string {
  return 'title' in row ? row.title : row.name;
}

function groupLabel(group: QueryGroup): string {
  const key = Object.values(group.key)
    .map((value) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '',
    )
    .join(' / ');
  return key === '' ? '·' : key;
}

/**
 * The live preview: the draft's query through `POST /query {draft, blockType, preview: true}`,
 * 300 ms after the last edit, at most 20 rows. A 503 means the 2 s preview limit ran out.
 */
export function Preview({
  workspaceId,
  request,
}: {
  workspaceId: string;
  request: QueryRequest | null;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const settled = useDebounced(request, PREVIEW_DEBOUNCE_MS);
  const key = settled === null ? '' : JSON.stringify(settled);
  const query = useQuery({
    queryKey: [...queryKeys.dashboards(workspaceId), 'preview', key],
    enabled: settled !== null,
    retry: false,
    gcTime: 30_000,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      if (settled === null) {
        throw new Error('No preview without a query');
      }
      const response = await runQuery(workspaceId, settled, { signal, suppressErrorToast: true });
      return response.data;
    },
  });

  if (settled === null) {
    return <p className="text-sm text-muted-foreground">{t('editor.preview.none')}</p>;
  }
  const stale = request !== settled || query.isFetching;
  const status = apiErrorStatus(query.error);
  const data = query.data;
  const rows = (data?.rows ?? []).slice(0, CAPS.previewRows);
  const groups = (data?.groups ?? []).slice(0, CAPS.previewRows);
  const format = new Intl.DateTimeFormat(dateLocale(language), { dateStyle: 'medium' });

  return (
    <section aria-label={t('editor.preview.title')} data-preview className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{t('editor.preview.title')}</h3>
        {stale ? (
          <LoaderCircle
            aria-hidden="true"
            className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        ) : null}
        {data === undefined ? null : (
          <span className="text-[13px] text-muted-foreground" data-preview-total={data.total}>
            {t('editor.preview.total', {
              total: data.total,
              shown: Math.max(rows.length, groups.length),
            })}
          </span>
        )}
      </div>
      {query.isError ? (
        <p role="alert" className="flex items-start gap-2 text-[13px] text-destructive">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {status === 503
            ? t('editor.preview.timeout')
            : errorMessage(t, query.error, 'editor.preview.failed')}
        </p>
      ) : null}
      {data !== undefined && rows.length === 0 && groups.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('editor.preview.empty')}</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="divide-y rounded-md border bg-card text-[13px]">
          {rows.map((row) => (
            <li
              key={row.id}
              data-preview-row
              className="flex items-baseline justify-between gap-3 px-3 py-1.5"
            >
              <span className="min-w-0 truncate" dir="auto">
                {rowTitle(row)}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {'dueAt' in row && row.dueAt !== null
                  ? format.format(new Date(row.dueAt))
                  : t(`sources.${row.source.provider}`, { defaultValue: row.source.provider })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {groups.length > 0 ? (
        <ul className="divide-y rounded-md border bg-card text-[13px]">
          {groups.map((group, index) => (
            <li
              key={index}
              data-preview-row
              className="flex items-baseline justify-between gap-3 px-3 py-1.5"
            >
              <span className="min-w-0 truncate" dir="auto">
                {groupLabel(group)}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {group.value === null ? '' : String(group.value)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
