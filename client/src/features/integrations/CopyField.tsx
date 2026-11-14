import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * A value shown for copying: read-only, selected on focus. Toasts say only that it was copied
 * (never the value).
 */
export function CopyField({
  label,
  value,
  name,
}: {
  label: string;
  value: string;
  /** For tests and the page's own bookkeeping: `data-copy-field`. */
  name: string;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('connect.copied'));
    } catch {
      inputRef.current?.select();
      toast.error(t('connect.copyFailed'));
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          value={value}
          readOnly
          dir="ltr"
          data-copy-field={name}
          aria-label={label}
          className="min-w-0 flex-1 bg-sunken text-start font-mono text-[13px]"
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => void copy()}
          aria-label={t('connect.copyLabel', { label })}
        >
          <Copy aria-hidden="true" />
          {t('connect.copy')}
        </Button>
      </div>
    </div>
  );
}
