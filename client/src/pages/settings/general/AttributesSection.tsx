import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import {
  useAttributes,
  useCreateAttribute,
  useDeleteAttribute,
  useUpdateAttribute,
} from '@/api/queries/attributes';
import { FormError } from '@/components/auth/auth-ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select';
import { parseOptions, slugKey } from '@/features/items/attributeValues';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import { ATTRIBUTE_TYPES, type AttributeDef, type AttributeType } from '@api-types/attributes';
import { PLAN_LIMITS } from '@api-types/limits';

/** One definition: its name (renamable, the built-in too), key, type and, for custom ones, delete. */
function AttributeRow({
  def,
  workspaceId,
  canEdit,
}: {
  def: AttributeDef;
  workspaceId: string;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const update = useUpdateAttribute(workspaceId);
  const remove = useDeleteAttribute(workspaceId);
  const [name, setName] = useState(def.name);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = name.trim() !== '' && name.trim() !== def.name;
  return (
    <div
      role="group"
      aria-label={def.name}
      className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3"
      data-attribute={def.key}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>{t('logic.attributes.name')}</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={40}
            dir="auto"
            disabled={!canEdit}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-0.5 text-[13px] text-muted-foreground">
          <span>
            {t(`logic.attributes.types.${def.type}`)}
            {def.builtIn ? ` · ${t('logic.attributes.builtIn')}` : ''}
          </span>
          <code dir="ltr">attr.{def.key}</code>
        </div>
        {canEdit ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="max-md:h-11"
              disabled={!changed || update.isPending}
              onClick={() => {
                setError(null);
                update.mutate(
                  { key: def.key, body: { name: name.trim() } },
                  {
                    onSuccess: () => {
                      toast.success(t('logic.attributes.saved'));
                    },
                    onError: (failure) => {
                      setError(errorMessage(t, failure, 'logic.attributes.loadError'));
                    },
                  },
                );
              }}
            >
              {t('logic.attributes.rename')}
            </Button>
            {def.builtIn ? null : (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="max-md:size-11"
                aria-label={t('logic.attributes.deleteTitle', { name: def.name })}
                onClick={() => {
                  setConfirming(true);
                }}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            )}
          </div>
        ) : null}
      </div>
      {def.options === undefined ? null : (
        <p className="text-[13px] text-muted-foreground" dir="auto">
          {def.options.join(' · ')}
        </p>
      )}
      {def.builtIn ? (
        <p className="text-[13px] text-muted-foreground">{t('logic.attributes.builtInKeep')}</p>
      ) : null}
      {error === null ? null : <FormError>{error}</FormError>}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('logic.attributes.deleteTitle', { name: def.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('logic.attributes.deleteBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('logic.attributes.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                remove.mutate(def.key, {
                  onError: (failure) => {
                    setError(errorMessage(t, failure, 'logic.attributes.loadError'));
                  },
                });
              }}
            >
              {t('logic.attributes.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function NewAttribute({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const id = useId();
  const create = useCreateAttribute(workspaceId);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [type, setType] = useState<AttributeType>('rating');
  const [options, setOptions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listed = type === 'select' || type === 'multiSelect';
  const shownKey = keyTouched ? key : slugKey(name);
  const ready =
    name.trim() !== '' && shownKey !== '' && (!listed || parseOptions(options).length > 0);
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-dashed px-4 py-4"
      aria-label={t('logic.attributes.add')}
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        create.mutate(
          {
            key: shownKey,
            name: name.trim(),
            type,
            ...(listed ? { options: parseOptions(options) } : {}),
          },
          {
            onSuccess: () => {
              setName('');
              setKey('');
              setKeyTouched(false);
              setOptions('');
              toast.success(t('logic.attributes.saved'));
            },
            onError: (failure) => {
              setError(errorMessage(t, failure, 'logic.attributes.loadError'));
            },
          },
        );
      }}
    >
      <h3 className="text-sm font-semibold">{t('logic.attributes.add')}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>{t('logic.attributes.name')}</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={40}
            dir="auto"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-type`}>{t('logic.attributes.type')}</Label>
          <SelectField
            id={`${id}-type`}
            value={type}
            onValueChange={(next) => {
              const found = ATTRIBUTE_TYPES.find((entry) => entry === next);
              if (found !== undefined) {
                setType(found);
              }
            }}
            options={ATTRIBUTE_TYPES.map((entry) => ({
              value: entry,
              label: t(`logic.attributes.types.${entry}`),
            }))}
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={`${id}-key`}>{t('logic.attributes.key')}</Label>
          <Input
            id={`${id}-key`}
            value={shownKey}
            dir="ltr"
            maxLength={32}
            onChange={(event) => {
              setKeyTouched(true);
              setKey(event.target.value.toLowerCase());
            }}
          />
          <p className="text-[13px] text-muted-foreground">{t('logic.attributes.keyHint')}</p>
        </div>
        {listed ? (
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`${id}-options`}>{t('logic.attributes.options')}</Label>
            <textarea
              id={`${id}-options`}
              value={options}
              dir="auto"
              rows={3}
              className="min-h-20 w-full rounded-sm border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              onChange={(event) => {
                setOptions(event.target.value);
              }}
            />
            <p className="text-[13px] text-muted-foreground">{t('logic.attributes.optionsHint')}</p>
          </div>
        ) : null}
      </div>
      {error === null ? null : <FormError>{error}</FormError>}
      <div>
        <Button
          type="submit"
          size="sm"
          className="max-md:h-11"
          disabled={!ready || create.isPending}
        >
          {create.isPending ? t('logic.attributes.creating') : t('logic.attributes.create')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Custom attributes (H4): fields every item can carry, with the built-in Importance first. Editors
 * and owners define them; viewers see the list. The values live in TodoList only.
 */
export function AttributesSection({
  workspaceId,
  canEdit,
}: {
  workspaceId: string;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const attributes = useAttributes(workspaceId);
  return (
    <SettingsSection
      id={`${id}-title`}
      title={t('logic.attributes.title')}
      hint={t('logic.attributes.description')}
      layout="stacked"
    >
      {attributes.isError ? <FormError>{t('logic.attributes.loadError')}</FormError> : null}
      <div className="flex flex-col gap-3" data-attributes>
        {(attributes.data ?? []).map((def) => (
          <AttributeRow key={def.key} def={def} workspaceId={workspaceId} canEdit={canEdit} />
        ))}
      </div>
      {canEdit ? (
        <>
          <p className="text-[13px] text-muted-foreground">
            {t('logic.attributes.limit', { max: PLAN_LIMITS.attributesPerWorkspace })}
          </p>
          <NewAttribute workspaceId={workspaceId} />
        </>
      ) : (
        <p className="text-[13px] text-muted-foreground">{t('logic.attributes.viewerNote')}</p>
      )}
    </SettingsSection>
  );
}
