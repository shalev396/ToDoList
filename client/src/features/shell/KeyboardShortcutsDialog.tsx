import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Kbd } from '@/components/ui/kbd';
import { isApplePlatform } from '@/features/shell/shellUi';
import { SHORTCUT_GROUPS } from '@/features/shell/shortcuts';

/** The "Keyboard shortcuts" dialog, opened with `?` or from the ⌘K menu. */
export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const mod = isApplePlatform() ? '⌘' : 'Ctrl';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t('app.page.close')}
        className="max-w-md gap-3 outline-none"
        onOpenAutoFocus={(event) => {
          // Land on the dialog itself, not the close button: no focus ring on open, and the
          // close button still shows its ring when Tab reaches it.
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('shortcuts.description')}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60dvh]" viewportClassName="max-h-[inherit]">
          <div className="flex flex-col gap-5 pe-3">
            {SHORTCUT_GROUPS.map((group) => (
              <section key={group.group} aria-labelledby={`shortcuts-${group.group}`}>
                <h3 id={`shortcuts-${group.group}`} className="mb-1 text-sm font-semibold">
                  {t(`shortcuts.groups.${group.group}`)}
                </h3>
                <ul className="flex flex-col divide-y">
                  {group.items.map((item) => (
                    <li key={item.id} className="flex min-h-10 items-center justify-between gap-4">
                      <span className="text-sm">{t(`shortcuts.items.${item.id}`)}</span>
                      <span className="flex shrink-0 gap-1" dir="ltr">
                        {item.keys.map((key) => (
                          <Kbd key={key}>{key === 'mod' ? mod : key}</Kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
