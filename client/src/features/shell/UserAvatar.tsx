import { cn } from '@/lib/utils';
import { initials } from '@/components/items/format';

/** A person: their photo, or their initials on the sunken wash. Ink only. */
export function UserAvatar({
  name,
  photoUrl,
  className,
}: {
  name: string;
  photoUrl?: string | null | undefined;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-sunken text-xs font-semibold text-foreground',
        className,
      )}
    >
      {photoUrl ? (
        <img src={photoUrl} alt="" className="size-full object-cover" />
      ) : (
        initials(name || '?')
      )}
    </span>
  );
}
