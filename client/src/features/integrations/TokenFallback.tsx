import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/**
 * "Use an API token instead": the second way to connect, collapsed under the sign-in button. It
 * opens the token form, so a person who can't sign in (or wants a service token) isn't stuck.
 */
export function TokenFallback({
  provider,
  name,
  onOpen,
}: {
  provider: string;
  name: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <details data-token-fallback={provider} className="basis-full text-[13px]">
      <summary className="w-fit cursor-pointer text-muted-foreground underline underline-offset-2 max-md:min-h-11 max-md:content-center">
        {t('connect.signin.useToken')}
      </summary>
      <div className="mt-2 flex flex-col items-start gap-2">
        <p className="text-muted-foreground">{t('connect.signin.tokenNote', { name })}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="max-md:h-11"
          data-use-token={provider}
          onClick={onOpen}
        >
          {t('connect.signin.tokenOpen')}
        </Button>
      </div>
    </details>
  );
}
