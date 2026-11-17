import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/skeleton';
import { PageContainer } from '@/features/shell/PageHeader';
import { cn } from '@/lib/utils';

/** Block shapes on the 12-column grid while a dashboard loads, in the main template's spirit. */
const SHAPES = [
  'md:col-span-8 lg:col-span-12 h-[88px]',
  'md:col-span-4 lg:col-span-4 h-[400px]',
  'md:col-span-4 lg:col-span-4 h-[400px]',
  'hidden lg:block lg:col-span-4 h-[400px]',
];

/** While a dashboard loads: the header's shape and a few blocks, and a status for screen readers. */
export function DashboardSkeleton() {
  const { t } = useTranslation();
  return (
    <PageContainer>
      <div role="status" className="pt-6 pb-5 md:pt-10 md:pb-6">
        <span className="sr-only">{t('app.page.loading')}</span>
        <Skeleton className="h-7 w-44" />
        <Skeleton className="mt-3 h-4 w-60 max-w-full" />
      </div>
      <div aria-hidden="true" className="grid grid-cols-1 gap-4 md:grid-cols-8 lg:grid-cols-12">
        {SHAPES.map((shape, index) => (
          <div key={index} className={cn('rounded-lg border bg-card p-4', shape)}>
            <Skeleton className="h-3.5 w-28 rounded-full" />
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
