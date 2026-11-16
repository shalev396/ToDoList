import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Languages, LogOut, Palette, UserRound } from 'lucide-react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTheme } from '@/components/theme-context';
import { useMe } from '@/api/queries/user';
import { useLanguage } from '@/hooks/useLanguage';
import { LANGUAGE_NAMES, isValidLanguage } from '@/i18n/config';
import { pathTo, ROUTES } from '@/router/routes';
import { selectUser } from '@/store/userSlice';
import { UserAvatar } from '@/features/shell/UserAvatar';
import { useSignOut } from '@/features/shell/useSignOut';

const radioItem =
  'relative flex min-h-11 cursor-default items-center gap-2 rounded-sm ps-8 pe-2 pointer-fine:min-h-8 text-sm outline-hidden select-none focus:bg-muted';

/** A radio row with its dot on the start side, for the theme and language submenus. */
function RadioRow({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <DropdownMenuPrimitive.RadioItem value={value} className={radioItem}>
      <span className="absolute start-2.5 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <span className="block size-1.5 rounded-full bg-foreground" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

/** The user menu at the foot of the sidebar: profile, theme, language, sign out. */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { language, changeLanguage, availableLanguages, isRTL } = useLanguage();
  const { theme, setTheme } = useTheme();
  const user = useSelector(selectUser);
  const { data: me } = useMe();
  const signOut = useSignOut();

  const name = me?.name ?? user?.name ?? '';
  const email = me?.email ?? user?.email ?? '';
  const display = name || email;

  const trigger = (
    <DropdownMenuTrigger
      aria-label={t('app.userMenu.trigger', { name: display })}
      className={cn(
        'flex min-h-11 min-w-0 items-center gap-2 rounded-sm px-2 text-start text-sm pointer-fine:min-h-9 transition-colors duration-150 hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:bg-sunken',
        compact ? 'w-11 justify-center px-0 pointer-fine:w-9' : 'w-full',
      )}
    >
      <UserAvatar name={display} photoUrl={me?.photoUrl} />
      {compact ? null : <span className="min-w-0 flex-1 truncate">{display}</span>}
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {compact ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side={isRTL ? 'left' : 'right'}>{display}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent align="start" side="top" className="w-60">
        <div className="flex flex-col px-2 py-1.5">
          <span className="truncate text-sm font-medium">{name || email}</span>
          {name ? <span className="truncate text-xs text-muted-foreground">{email}</span> : null}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void navigate(pathTo(ROUTES.PROFILE, language));
          }}
        >
          <UserRound aria-hidden="true" />
          {t('app.userMenu.profile')}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette aria-hidden="true" />
            {t('app.userMenu.theme')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuPrimitive.RadioGroup
              value={theme}
              onValueChange={(value) => {
                setTheme(value === 'dark' ? 'dark' : 'light');
              }}
            >
              <RadioRow value="light">{t('theme.light')}</RadioRow>
              <RadioRow value="dark">{t('theme.dark')}</RadioRow>
            </DropdownMenuPrimitive.RadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Languages aria-hidden="true" />
            {t('app.userMenu.language')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuPrimitive.RadioGroup
              value={language}
              onValueChange={(value) => {
                if (isValidLanguage(value)) {
                  changeLanguage(value);
                }
              }}
            >
              {availableLanguages.map((lng) => (
                <RadioRow key={lng} value={lng}>
                  <span lang={lng}>{LANGUAGE_NAMES[lng]}</span>
                </RadioRow>
              ))}
            </DropdownMenuPrimitive.RadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}>
          <LogOut aria-hidden="true" />
          {t('app.userMenu.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
