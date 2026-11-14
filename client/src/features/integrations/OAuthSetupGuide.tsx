import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { OAuthProviderInfo } from '@api-types/integrations';
import { CopyField } from './CopyField';
import { SECRET_JSON_EXAMPLE } from './oauthSetup';

/**
 * "Set up <provider> sign-in": for the operator of this server (not the end user), how to
 * register the OAuth app at the provider. Shows what the provider asks for: this server's exact
 * callback URL, the scopes or permissions to request, the developer console, and where the client
 * id and secret go (the stage's secret in Secrets Manager).
 */
export function OAuthSetupGuide({
  info,
  name,
  onClose,
}: {
  info: OAuthProviderInfo;
  name: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const steps = t(`connect.guide.steps.${info.provider}`, { returnObjects: true }) as Record<
    string,
    string
  >;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent data-oauth-guide={info.provider} className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('connect.guide.title', { name })}</DialogTitle>
          <DialogDescription>{t('connect.guide.description', { name })}</DialogDescription>
        </DialogHeader>
        <ol className="flex list-decimal flex-col gap-2 ps-5 text-sm">
          <li>
            <a
              href={info.consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline underline-offset-2"
              data-guide-console
            >
              {t('connect.guide.openConsole', { name })}
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          </li>
          {Object.entries(steps).map(([key, step]) => (
            <li key={key}>{step}</li>
          ))}
        </ol>
        <CopyField
          label={t('connect.guide.callback')}
          value={info.callbackUrl}
          name="oauth-callback"
        />
        <section className="flex flex-col gap-1.5 text-sm" data-guide-scopes>
          <h3 className="font-medium">{t('connect.guide.scopes')}</h3>
          {info.scopes.length === 0 ? (
            <p className="text-muted-foreground">{t(`connect.guide.noScopes.${info.provider}`)}</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {info.scopes.map((scope) => (
                <li key={scope}>
                  <code className="rounded-sm bg-sunken px-1.5 py-0.5 text-[13px]" dir="ltr">
                    {scope}
                  </code>
                </li>
              ))}
            </ul>
          )}
          {info.writeScopes.length === 0 ? null : (
            <p className="text-[13px] text-muted-foreground">
              {t('connect.guide.writeScopes', { scopes: info.writeScopes.join(', ') })}
            </p>
          )}
        </section>
        <section className="flex flex-col gap-1.5 text-sm" data-guide-secret>
          <h3 className="font-medium">{t('connect.guide.secret')}</h3>
          <p>{t('connect.guide.secretDeployed')}</p>
          <code className="rounded-sm bg-sunken px-2 py-1 text-[13px] break-all" dir="ltr">
            {info.secretName}
          </code>
          <p className="text-muted-foreground">{t('connect.guide.secretJson')}</p>
          <code className="rounded-sm bg-sunken px-2 py-1 text-[13px] break-all" dir="ltr">
            {SECRET_JSON_EXAMPLE}
          </code>
          {info.provider === 'github' ? (
            <p className="text-[13px] text-muted-foreground">{t('connect.guide.githubSlug')}</p>
          ) : null}
          <p className="text-[13px] text-muted-foreground">{t('connect.guide.afterSecret')}</p>
        </section>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t('connect.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
