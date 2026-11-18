import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useUpdateTopic } from '@/api/queries/topics';
import { errorMessage } from '@/api/errors';
import { FamilySwatch } from '@/features/colours/FamilySwatch';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { UNSORTED_FAMILY } from '@api-types/colours';
import { TOPIC_COLOURS, type TopicColour } from '@api-types/topics';
import type { TopicView } from '@api-types/api-contracts';

function isFamily(value: string): value is TopicColour {
  return (TOPIC_COLOURS as readonly string[]).includes(value);
}

/**
 * A topic's colour family (topic-colours spec, "Settings"): its shades and its name. Editors and
 * owners pick another of the nine families from a menu; the choice is saved at once.
 */
export function TopicFamilyPicker({ topic, canManage }: { topic: TopicView; canManage: boolean }) {
  const { t } = useTranslation();
  const { workspace } = useCurrentWorkspace();
  const updateTopic = useUpdateTopic(workspace?.id ?? '');
  const family = topic.colour ?? UNSORTED_FAMILY;
  const familyName = t(`colours.family.${family}`);
  const look = (
    <>
      <FamilySwatch family={family} />
      <span className="truncate">{familyName}</span>
    </>
  );

  if (!canManage) {
    return (
      <span
        data-family={family}
        className="inline-flex min-w-0 shrink-0 items-center gap-2 text-[13px] text-muted-foreground"
      >
        {look}
      </span>
    );
  }

  const choose = (value: string) => {
    // One change at a time; the trigger stays enabled so focus can return to it.
    if (!isFamily(value) || value === topic.colour || updateTopic.isPending) {
      return;
    }
    updateTopic.mutate(
      { topicId: topic.id, body: { colour: value } },
      {
        onError: (err) => {
          toast.error(errorMessage(t, err, 'colours.picker.failed'));
        },
      },
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-family={family}
          aria-label={t('colours.picker.change', { name: topic.name, family: familyName })}
          className="min-w-0 shrink-0 gap-2 text-[13px] font-normal text-muted-foreground"
        >
          {look}
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>{t('colours.picker.label')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={family} onValueChange={choose}>
          {TOPIC_COLOURS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} data-family={option}>
              <FamilySwatch family={option} />
              {t(`colours.family.${option}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
