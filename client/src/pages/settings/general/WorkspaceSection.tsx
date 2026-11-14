import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import type { Draft } from '@/pages/settings/general/draft';

interface WorkspaceSectionProps {
  formId: string;
  draft: Draft;
  slug: string;
  disabled: boolean;
  onChange: (patch: Partial<Draft>) => void;
}

/** The workspace's name (editable) and slug (not yet: PATCH doesn't take it). */
export function WorkspaceSection({
  formId,
  draft,
  slug,
  disabled,
  onChange,
}: WorkspaceSectionProps) {
  const { t } = useTranslation();
  const nameMissing = draft.name.trim() === '';
  return (
    <SettingsSection
      id={`${formId}-workspace`}
      title={t('settings.sections.workspace')}
      hint={t('settings.sections.workspaceHint')}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${formId}-name`} className="text-sm font-medium">
          {t('settings.fields.name')}
        </label>
        <Input
          id={`${formId}-name`}
          value={draft.name}
          maxLength={80}
          required
          aria-invalid={nameMissing}
          onChange={(e) => {
            onChange({ name: e.target.value });
          }}
          disabled={disabled}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${formId}-slug`} className="text-sm font-medium">
          {t('settings.fields.slug')}
        </label>
        <Input
          id={`${formId}-slug`}
          value={slug}
          readOnly
          dir="ltr"
          aria-describedby={`${formId}-slug-hint`}
          className="bg-sunken text-start text-muted-foreground"
        />
        <p id={`${formId}-slug-hint`} className="text-[13px] text-muted-foreground">
          {t('settings.fields.slugHint')}
        </p>
      </div>
    </SettingsSection>
  );
}
