import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { TimeZoneSelect } from '@/features/workspaces/TimeZoneSelect';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import type { Draft } from '@/pages/settings/general/draft';

interface TimeSectionProps {
  formId: string;
  draft: Draft;
  disabled: boolean;
  onChange: (patch: Partial<Draft>) => void;
}

/** The time zone ("today" and dates) and the first day of the week. */
export function TimeSection({ formId, draft, disabled, onChange }: TimeSectionProps) {
  const { t } = useTranslation();
  return (
    <SettingsSection
      id={`${formId}-time`}
      title={t('settings.sections.time')}
      hint={t('settings.sections.timeHint')}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${formId}-timezone`} className="text-sm font-medium">
          {t('settings.fields.timezone')}
        </label>
        <TimeZoneSelect
          id={`${formId}-timezone`}
          value={draft.timezone}
          onChange={(timezone) => {
            onChange({ timezone });
          }}
          disabled={disabled}
          searchLabel={t('settings.fields.timezoneSearch')}
          emptyLabel={t('settings.fields.timezoneEmpty')}
        />
      </div>
      <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
        <legend className="mb-1.5 text-sm font-medium">{t('settings.fields.weekStart')}</legend>
        <div className="inline-flex w-fit gap-1 rounded-md bg-sunken p-1">
          {(['sun', 'mon'] as const).map((day) => (
            <label
              key={day}
              className={cn(
                'relative flex min-h-11 min-w-24 cursor-pointer items-center justify-center rounded-sm px-3 text-sm transition-colors pointer-fine:min-h-8 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-not-allowed',
                draft.weekStart === day
                  ? 'bg-card font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <input
                type="radio"
                name={`${formId}-week-start`}
                value={day}
                checked={draft.weekStart === day}
                onChange={() => {
                  onChange({ weekStart: day });
                }}
                className="sr-only"
              />
              {day === 'sun' ? t('settings.fields.sunday') : t('settings.fields.monday')}
            </label>
          ))}
        </div>
      </fieldset>
    </SettingsSection>
  );
}
