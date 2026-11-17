import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ProviderIcon, type IconName } from '@/features/landing/ProviderIcon';
import { PROVIDER_REGISTRY } from '@/features/integrations/providers';
import type { Provider } from '@api-types/domain';

function iconOf(provider: Provider): IconName | null {
  return provider in PROVIDER_REGISTRY
    ? PROVIDER_REGISTRY[provider as keyof typeof PROVIDER_REGISTRY].icon
    : null;
}

/**
 * The providers of the integrations a member owns in this workspace (PERMISSIONS-V2 ruling 21):
 * one icon each, deduplicated by the server; hovering or focusing shows the provider names only.
 * Never an account, a label or a status: those are the member's own. Nothing when they own none.
 */
export function MemberProviders({ providers }: { providers: readonly Provider[] }) {
  const { t } = useTranslation();
  const icons = providers.flatMap((provider) => {
    const icon = iconOf(provider);
    return icon === null ? [] : [{ provider, icon }];
  });
  if (icons.length === 0) {
    return null;
  }
  const names = icons.map(({ provider }) => t(`sources.${provider}`)).join(', ');
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="img"
            aria-label={t('members.list.connections', { names })}
            data-member-providers={icons.map(({ provider }) => provider).join(' ')}
            className="inline-flex min-h-6 items-center gap-1.5 rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            {icons.map(({ provider, icon }) => (
              <ProviderIcon key={provider} name={icon} className="size-4" />
            ))}
          </span>
        </TooltipTrigger>
        <TooltipContent>{names}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
