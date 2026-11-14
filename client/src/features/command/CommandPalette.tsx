import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Kbd } from '@/components/ui/kbd';
import { useCommandRegistry } from '@/features/command/commandRegistry';
import { filterCommands, groupCommands, type AppCommand } from '@/features/command/registry';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * ⌘K: every registered command, filtered by registry.ts (cmdk's own filter is off, so what the
 * tests cover is what people get). Choosing one closes the palette first, so a command that opens
 * a dialog of its own gets the focus.
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const { t } = useTranslation();
  const { commands } = useCommandRegistry();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupCommands(filterCommands(commands, query)), [commands, query]);

  const close = () => {
    onOpenChange(false);
    setQuery('');
  };

  const choose = (command: AppCommand) => {
    close();
    window.setTimeout(command.run, 0);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          onOpenChange(true);
        } else {
          close();
        }
      }}
    >
      <DialogContent className="top-[12vh] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 md:top-[16vh]">
        <DialogTitle className="sr-only">{t('commandPalette.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('commandPalette.description')}</DialogDescription>
        <Command shouldFilter={false} loop label={t('commandPalette.title')}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t('commandPalette.placeholder')}
            aria-label={t('commandPalette.placeholder')}
          />
          <CommandList className="p-1">
            <CommandEmpty>{t('commandPalette.empty')}</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.group} heading={t(`commandPalette.groups.${group.group}`)}>
                {group.commands.map((command) => {
                  const Icon = command.icon;
                  return (
                    <CommandItem
                      key={command.id}
                      value={command.id}
                      onSelect={() => {
                        choose(command);
                      }}
                    >
                      {Icon === undefined ? null : <Icon aria-hidden="true" />}
                      <span className="min-w-0 flex-1 truncate">{command.label}</span>
                      {command.shortcut === undefined ? null : (
                        <span
                          className="hidden shrink-0 gap-1 pointer-fine:flex"
                          dir="ltr"
                          aria-hidden="true"
                        >
                          {command.shortcut.map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))}
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
