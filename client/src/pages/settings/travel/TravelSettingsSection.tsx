import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { errorMessage } from '@/api/errors';
import { useSaveTravelSettings } from '@/api/queries/travel';
import { FormError } from '@/components/auth/auth-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import { DEFAULT_TRAVEL_SETTINGS, TRAVEL_MODES, type TravelSettings } from '@api-types/travel.ts';
import {
  bufferFromInput,
  factorFromInput,
  goHomeFromInput,
  sameSettings,
  settingsDraftOf,
} from './travelForms';

/**
 * A number field that keeps what is typed while focused and shows the value as kept (clamped)
 * once it loses focus. The digits read left to right in both languages, after their sign.
 */
function NumberField({
  id,
  value,
  parse,
  onValue,
  label,
  sign,
  unit,
  inputMode,
  disabled,
}: {
  id: string;
  value: number;
  parse: (text: string, fallback: number) => number;
  onValue: (value: number) => void;
  /** Its name when no visible label names it (a table cell). */
  label?: string;
  sign?: string;
  unit?: string;
  inputMode: 'decimal' | 'numeric';
  disabled?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span dir="ltr" className="inline-flex items-center gap-1">
        {sign === undefined ? null : (
          <span aria-hidden="true" className="text-sm text-muted-foreground">
            {sign}
          </span>
        )}
        <Input
          id={id}
          dir="ltr"
          inputMode={inputMode}
          aria-label={label}
          disabled={disabled}
          className="w-[4.5rem] text-end tabular-nums"
          value={text ?? String(value)}
          onChange={(event) => {
            setText(event.target.value);
            onValue(parse(event.target.value, value));
          }}
          onBlur={() => {
            setText(null);
          }}
        />
      </span>
      {unit === undefined ? null : (
        <span aria-hidden="true" className="text-sm text-muted-foreground">
          {unit}
        </span>
      )}
    </span>
  );
}

/**
 * The member's travel settings (travel-time spec, Concepts 5): per mode a factor (×, 0.5–3) and a
 * buffer (+ minutes, 0–120), going home in a long window (a window of at least 3 h that leaves at
 * least an hour at home), and the default mode. Edited as one draft and saved together.
 */
export function TravelSettingsSection({
  workspaceId,
  saved,
}: {
  workspaceId: string;
  saved: TravelSettings;
}) {
  const { t } = useTranslation();
  const id = useId();
  const save = useSaveTravelSettings(workspaceId);
  const [edited, setEdited] = useState<TravelSettings | null>(null);
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const draft = edited ?? saved;
  const dirty = edited !== null && !sameSettings(edited, saved);
  const change = (update: (next: TravelSettings) => void) => {
    const next = settingsDraftOf(draft);
    update(next);
    setEdited(next);
  };
  const reset = () => {
    setEdited(null);
    setGeneration((value) => value + 1);
    setError(null);
  };
  const goHomeOff = !draft.goHome.enabled;
  return (
    <SettingsSection
      id={`${id}-title`}
      title={t('travel.settings.title')}
      hint={t('travel.settings.hint')}
      layout="stacked"
    >
      <div data-travel-settings className="flex flex-col gap-6" key={generation}>
        <div className="flex flex-col gap-2">
          <table className="w-full max-w-md text-sm">
            <thead>
              <tr className="text-start text-[13px] text-muted-foreground">
                <th scope="col" className="pb-1 text-start font-medium">
                  {t('travel.settings.mode')}
                </th>
                <th scope="col" className="pb-1 text-start font-medium">
                  {t('travel.settings.factor')}
                </th>
                <th scope="col" className="pb-1 text-start font-medium">
                  {t('travel.settings.buffer')}
                </th>
              </tr>
            </thead>
            <tbody>
              {TRAVEL_MODES.map((mode) => {
                const name = t(`travel.modes.${mode}`);
                return (
                  <tr key={mode} data-travel-mode={mode}>
                    <th scope="row" className="py-1.5 pe-3 text-start font-normal">
                      {name}
                    </th>
                    <td className="py-1.5 pe-3">
                      <NumberField
                        id={`${id}-${mode}-factor`}
                        value={draft.factors[mode]}
                        parse={factorFromInput}
                        inputMode="decimal"
                        sign="×"
                        label={t('travel.settings.factorOf', { mode: name })}
                        onValue={(value) => {
                          change((next) => {
                            next.factors[mode] = value;
                          });
                        }}
                      />
                    </td>
                    <td className="py-1.5">
                      <NumberField
                        id={`${id}-${mode}-buffer`}
                        value={draft.buffers[mode]}
                        parse={bufferFromInput}
                        inputMode="numeric"
                        sign="+"
                        unit={t('travel.settings.minutes')}
                        label={t('travel.settings.bufferOf', { mode: name })}
                        onValue={(value) => {
                          change((next) => {
                            next.buffers[mode] = value;
                          });
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p data-travel-defaults className="text-[13px] text-muted-foreground">
            {t('travel.settings.defaults')}{' '}
            {TRAVEL_MODES.map((mode, index) => (
              <span key={mode}>
                {index === 0 ? '' : ', '}
                {t(`travel.modes.${mode}`)}{' '}
                <span dir="ltr">
                  ×{DEFAULT_TRAVEL_SETTINGS.factors[mode]} +{DEFAULT_TRAVEL_SETTINGS.buffers[mode]}
                </span>{' '}
                {t('travel.settings.minutes')}
              </span>
            ))}
          </p>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border bg-card px-4 py-3">
          <div className="relative flex min-h-11 items-center gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <label
                htmlFor={`${id}-go-home`}
                className="cursor-pointer text-sm font-medium after:absolute after:inset-0"
              >
                {t('travel.settings.goHome')}
              </label>
              <p id={`${id}-go-home-hint`} className="text-[13px] text-muted-foreground">
                {t('travel.settings.goHomeHint')}
              </p>
            </div>
            <Switch
              id={`${id}-go-home`}
              data-go-home
              className="relative z-10"
              checked={draft.goHome.enabled}
              aria-describedby={`${id}-go-home-hint`}
              onCheckedChange={(checked) => {
                change((next) => {
                  next.goHome.enabled = checked;
                });
              }}
            />
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {(['minWindowMinutes', 'minAtHomeMinutes'] as const).map((field) => (
              <div key={field} className="flex flex-col gap-1.5">
                <label
                  htmlFor={`${id}-${field}`}
                  className={cn('text-sm', goHomeOff && 'text-muted-foreground')}
                >
                  {t(
                    field === 'minWindowMinutes'
                      ? 'travel.settings.minWindow'
                      : 'travel.settings.minAtHome',
                  )}
                </label>
                <NumberField
                  id={`${id}-${field}`}
                  value={draft.goHome[field]}
                  parse={(text, fallback) => goHomeFromInput(text, field, fallback)}
                  inputMode="numeric"
                  unit={t('travel.settings.minutes')}
                  disabled={goHomeOff}
                  onValue={(value) => {
                    change((next) => {
                      next.goHome[field] = value;
                    });
                  }}
                />
              </div>
            ))}
          </div>
        </div>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">{t('travel.settings.defaultMode')}</legend>
          <div className="inline-flex w-fit flex-wrap gap-1 rounded-md bg-sunken p-1">
            {TRAVEL_MODES.map((mode) => (
              <label
                key={mode}
                className={cn(
                  'relative flex min-h-11 min-w-24 cursor-pointer items-center justify-center rounded-sm px-3 text-sm transition-colors pointer-fine:min-h-8 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                  draft.defaultMode === mode
                    ? 'bg-card font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <input
                  type="radio"
                  name={`${id}-default-mode`}
                  value={mode}
                  checked={draft.defaultMode === mode}
                  onChange={() => {
                    change((next) => {
                      next.defaultMode = mode;
                    });
                  }}
                  className="sr-only"
                />
                {t(`travel.modes.${mode}`)}
              </label>
            ))}
          </div>
          <p className="text-[13px] text-muted-foreground">
            {t('travel.settings.defaultModeHint')}
          </p>
        </fieldset>

        {error === null ? null : <FormError>{error}</FormError>}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="max-md:h-11"
            disabled={!dirty || save.isPending}
            onClick={() => {
              if (edited === null) {
                return;
              }
              setError(null);
              save.mutate(settingsDraftOf(edited), {
                onSuccess: () => {
                  reset();
                  toast.success(t('travel.settings.saved'));
                },
                onError: (failure) => {
                  setError(errorMessage(t, failure, 'travel.settings.saveFailed'));
                },
              });
            }}
          >
            {save.isPending ? t('travel.settings.saving') : t('travel.settings.save')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="max-md:h-11"
            disabled={edited === null || save.isPending}
            onClick={reset}
          >
            {t('travel.settings.discard')}
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}
