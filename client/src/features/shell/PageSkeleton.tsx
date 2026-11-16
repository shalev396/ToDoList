import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/skeleton';

/** While a page's data loads: the header's and a panel's shapes, and a status for screen readers. */
export function PageSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pt-6 md:px-8 md:pt-10" role="status">
      <span className="sr-only">{t('app.page.loading')}</span>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="mt-3 h-4 w-72 max-w-full" />
      <Skeleton className="mt-8 h-48 w-full rounded-lg" />
    </div>
  );
}
