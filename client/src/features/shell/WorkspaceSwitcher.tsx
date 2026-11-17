import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronsUpDown, CirclePlus, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { WorkspaceMark } from '@/features/workspaces/WorkspaceMark';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useSwitchWorkspace } from '@/features/workspaces/useSwitchWorkspace';
import { useShellUi } from '@/features/shell/shellUi';

/**
 * The workspace switcher: the current workspace's ring mark and name; the menu lists my
 * workspaces with my role in each, then "Create workspace" and "Join with an invite link".
 */
export function WorkspaceSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { language, isRTL } = useLanguage();
  const { workspace, workspaces } = useCurrentWorkspace();
  const switchWorkspace = useSwitchWorkspace();
  const { openJoinDialog } = useShellUi();

  const label =
    workspace === null
      ? t('app.workspaceSwitcher.triggerEmpty')
      : t('app.workspaceSwitcher.trigger', { workspace: workspace.name });

  const trigger = (
    <DropdownMenuTrigger
      aria-label={label}
      className={cn(
        'group flex min-h-11 min-w-0 items-center gap-2 rounded-sm px-2 pointer-fine:min-h-9 text-start text-sm font-medium text-foreground transition-colors duration-150 hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:bg-sunken',
        compact ? 'w-11 justify-center px-0 pointer-fine:w-9' : 'w-full',
      )}
    >
      {workspace === null ? (
        <span className="size-5 shrink-0 rounded-[5px] border border-dashed border-muted-foreground/50" />
      ) : (
        <WorkspaceMark id={workspace.id} />
      )}
      {compact ? null : (
        <>
          <span className="min-w-0 flex-1 truncate">
            {workspace?.name ?? t('app.shell.noWorkspace')}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </>
      )}
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {compact ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side={isRTL ? 'left' : 'right'}>
            {workspace?.name ?? t('app.workspaceSwitcher.triggerEmpty')}
          </TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent align="start" className="w-64">
        {workspaces.length === 0 ? null : (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {t('app.workspaceSwitcher.yours')}
            </DropdownMenuLabel>
            <DropdownMenuPrimitive.RadioGroup
              value={workspace?.id ?? ''}
              onValueChange={(id) => {
                switchWorkspace(id);
              }}
            >
              {workspaces.map((entry) => (
                <DropdownMenuPrimitive.RadioItem
                  key={entry.workspace.id}
                  value={entry.workspace.id}
                  aria-label={`${entry.workspace.name} (${t(`app.roles.${entry.role}`)})`}
                  className="relative flex min-h-11 cursor-default items-center gap-2 rounded-sm px-2 text-sm outline-hidden pointer-fine:min-h-9 select-none focus:bg-sunken"
                >
                  <WorkspaceMark id={entry.workspace.id} />
                  <span className="min-w-0 flex-1 truncate">{entry.workspace.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t(`app.roles.${entry.role}`)}
                  </span>
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <DropdownMenuPrimitive.ItemIndicator>
                      <Check className="size-4" aria-hidden="true" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </span>
                </DropdownMenuPrimitive.RadioItem>
              ))}
            </DropdownMenuPrimitive.RadioGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          onSelect={() => {
            void navigate(pathTo(ROUTES.ONBOARDING, language));
          }}
        >
          <CirclePlus aria-hidden="true" />
          {t('app.workspaceSwitcher.create')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openJoinDialog}>
          <Link2 aria-hidden="true" />
          {t('app.workspaceSwitcher.join')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
