import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { House, Info, MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import { useRemovePlace, useSavePlace } from '@/api/queries/travel';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import type { PlaceView } from '@api-types/travel.ts';
import {
  EMPTY_PLACE,
  parseCoordinates,
  placeDraftOf,
  placePatchOf,
  placeRequestOf,
  neighbourAfterRemoval,
  type PlaceDraft,
} from './travelForms';

/** "Remove …?" with Cancel and Remove: removing a place or a rule changes the member's travel. */
export function ConfirmRemove({
  open,
  title,
  body,
  confirm,
  onConfirm,
  onClose,
  onCloseAutoFocus,
}: {
  open: boolean;
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
  /** Where focus goes as it closes (default: back to what opened it). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle dir="auto">{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('travel.places.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * A place's form: name, address or "lat, lon", other names, Home. Adding needs an address or
 * coordinates; editing sends only what changed, so a kept address is not looked up again.
 */
function PlaceForm({
  workspaceId,
  place,
  onDone,
  nameRef,
}: {
  workspaceId: string;
  /** The place being edited; none: a new one. */
  place?: PlaceView;
  /** Editing ends: saved, or cancelled. */
  onDone?: () => void;
  /** The name field, for focus from outside (the add form's, once the last place goes). */
  nameRef?: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const save = useSavePlace(workspaceId);
  const ownNameRef = useRef<HTMLInputElement>(null);
  const nameInput = nameRef ?? ownNameRef;
  const [draft, setDraft] = useState<PlaceDraft>(
    place === undefined ? EMPTY_PLACE : placeDraftOf(place),
  );
  const [problem, setProblem] = useState<'name' | 'address' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editing = place !== undefined;
  // Opening a place for editing puts the keyboard on its name.
  useEffect(() => {
    if (editing) {
      nameInput.current?.focus();
    }
  }, [editing, nameInput]);
  const change = (patch: Partial<PlaceDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setProblem(null);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const form = placeRequestOf(draft, editing);
    if (!form.ok) {
      setProblem(form.problem);
      return;
    }
    setError(null);
    const name = form.request.name;
    const done = () => {
      toast.success(t('travel.places.saved', { name }));
      if (editing) {
        onDone?.();
      } else {
        setDraft(EMPTY_PLACE);
      }
    };
    const fail = (failure: unknown) => {
      setError(errorMessage(t, failure, 'travel.places.saveFailed'));
    };
    if (place === undefined) {
      save.mutate({ body: form.request }, { onSuccess: done, onError: fail });
      return;
    }
    const patch = placePatchOf(place, form.request);
    if (patch === null) {
      onDone?.();
      return;
    }
    save.mutate({ id: place.id, body: patch }, { onSuccess: done, onError: fail });
  };
  const coords = parseCoordinates(draft.address) !== null;
  return (
    <form
      noValidate
      data-place-form={editing ? 'edit' : 'add'}
      aria-labelledby={editing ? undefined : `${id}-title`}
      aria-label={editing ? t('travel.places.editLabel', { name: place.name }) : undefined}
      className="flex flex-col gap-4 rounded-lg border border-dashed bg-card px-4 py-4"
      onSubmit={submit}
    >
      {editing ? null : (
        <h3 id={`${id}-title`} className="text-sm font-semibold">
          {t('travel.places.add')}
        </h3>
      )}
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>{t('travel.places.name')}</Label>
          <Input
            ref={nameInput}
            id={`${id}-name`}
            value={draft.name}
            maxLength={80}
            dir="auto"
            placeholder={t('travel.places.namePlaceholder')}
            aria-invalid={problem === 'name'}
            aria-describedby={problem === 'name' ? `${id}-problem` : undefined}
            onChange={(event) => {
              change({ name: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-address`}>{t('travel.places.address')}</Label>
          <Input
            id={`${id}-address`}
            value={draft.address}
            maxLength={300}
            dir={coords ? 'ltr' : 'auto'}
            autoComplete="off"
            aria-invalid={problem === 'address'}
            aria-describedby={`${id}-address-hint${problem === 'address' ? ` ${id}-problem` : ''}`}
            onChange={(event) => {
              change({ address: event.target.value });
            }}
          />
          <p id={`${id}-address-hint`} className="text-[13px] text-muted-foreground">
            {t('travel.places.addressHint')}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-aliases`}>{t('travel.places.aliasesLabel')}</Label>
        <Input
          id={`${id}-aliases`}
          value={draft.aliases}
          dir="auto"
          aria-describedby={`${id}-aliases-hint`}
          onChange={(event) => {
            change({ aliases: event.target.value });
          }}
        />
        <p id={`${id}-aliases-hint`} className="text-[13px] text-muted-foreground">
          {t('travel.places.aliasesHint')}
        </p>
      </div>
      <label className="flex min-h-11 w-fit cursor-pointer items-center gap-2 text-sm pointer-fine:min-h-8">
        <Checkbox
          checked={draft.home}
          onCheckedChange={(checked) => {
            change({ home: checked === true });
          }}
        />
        {t('travel.places.isHome')}
      </label>
      {problem === null ? null : (
        <p id={`${id}-problem`} role="alert" className="text-[13px] text-destructive">
          {t(problem === 'name' ? 'travel.places.errName' : 'travel.places.errAddress')}
        </p>
      )}
      {error === null ? null : <FormError>{error}</FormError>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" className="max-md:h-11" disabled={save.isPending}>
          {editing ? null : <Plus aria-hidden="true" />}
          {save.isPending
            ? t(editing ? 'travel.places.saving' : 'travel.places.adding')
            : t(editing ? 'travel.places.save' : 'travel.places.addButton')}
        </Button>
        {editing ? (
          <Button type="button" size="sm" variant="ghost" className="max-md:h-11" onClick={onDone}>
            {t('travel.places.cancel')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function PlaceRow({
  workspaceId,
  place,
  onRemove,
  editButtonRef,
}: {
  workspaceId: string;
  place: PlaceView;
  onRemove: (place: PlaceView) => void;
  /** Its Edit button, for the section to move focus to (after a neighbour is removed). */
  editButtonRef: (button: HTMLButtonElement | null) => void;
}) {
  const { t } = useTranslation();
  const save = useSavePlace(workspaceId);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement | null>(null);
  const backToEdit = useRef(false);
  // Cancelled or saved: the keyboard goes back to this place's Edit button.
  useEffect(() => {
    if (!editing && backToEdit.current) {
      backToEdit.current = false;
      editButton.current?.focus();
    }
  }, [editing]);
  if (editing) {
    return (
      <li data-place={place.name}>
        <PlaceForm
          workspaceId={workspaceId}
          place={place}
          onDone={() => {
            backToEdit.current = true;
            setEditing(false);
          }}
        />
      </li>
    );
  }
  const coords = place.address !== null && parseCoordinates(place.address) !== null;
  return (
    <li
      data-place={place.name}
      data-home={place.home ? 'true' : undefined}
      className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border bg-card px-4 py-3"
    >
      <span className="mt-0.5 text-muted-foreground" aria-hidden="true">
        {place.home ? <House className="size-4" /> : <MapPin className="size-4" />}
      </span>
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium break-words" dir="auto">
            {place.name}
          </span>
          {place.home ? (
            <span
              data-home-badge
              className="rounded-sm bg-sunken px-1.5 py-0.5 text-[12px] font-medium text-foreground"
            >
              {t('travel.places.home')}
            </span>
          ) : null}
        </p>
        {place.address === null ? null : (
          <p className="text-[13px] break-words text-muted-foreground">
            {/* Coordinates read left to right, at the start of the line in either language. */}
            <bdi data-place-address dir={coords ? 'ltr' : 'auto'}>
              {place.address}
            </bdi>
          </p>
        )}
        {place.aliases.length === 0 ? null : (
          <p className="text-[13px] text-muted-foreground">
            {t('travel.places.aliasesList')} <bdi>{place.aliases.join(', ')}</bdi>
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {place.home ? null : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="max-md:h-11"
            disabled={save.isPending}
            aria-label={t('travel.places.makeHomeLabel', { name: place.name })}
            onClick={() => {
              save.mutate(
                { id: place.id, body: { home: true } },
                {
                  onSuccess: () => {
                    // Its Make Home button goes: the keyboard moves to its Edit button.
                    editButton.current?.focus();
                    toast.success(t('travel.places.saved', { name: place.name }));
                  },
                  onError: (failure) => {
                    toast.error(errorMessage(t, failure, 'travel.places.saveFailed'));
                  },
                },
              );
            }}
          >
            <House aria-hidden="true" />
            {t('travel.places.makeHome')}
          </Button>
        )}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="max-md:size-11"
          ref={(button) => {
            editButton.current = button;
            editButtonRef(button);
          }}
          aria-label={t('travel.places.editLabel', { name: place.name })}
          onClick={() => {
            setEditing(true);
          }}
        >
          <Pencil aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="text-destructive max-md:size-11"
          aria-label={t('travel.places.removeLabel', { name: place.name })}
          onClick={() => {
            onRemove(place);
          }}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

/**
 * Places (travel-time spec, Concepts 1): the member's own, each with its name, other names and
 * address (only its owner ever sees it), one of them Home. Coordinates typed as "lat, lon" need no
 * lookup; an address is looked up once by the server.
 */
export function PlacesSection({
  workspaceId,
  places,
}: {
  workspaceId: string;
  places: readonly PlaceView[];
}) {
  const { t } = useTranslation();
  const id = useId();
  const remove = useRemovePlace(workspaceId);
  const [removing, setRemoving] = useState<PlaceView | null>(null);
  const hasHome = places.some((place) => place.home);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const addName = useRef<HTMLInputElement>(null);
  /** Set when Remove is confirmed: the place whose Edit button gets the keyboard, or none. */
  const focusAfterRemove = useRef<{ next: string | null } | null>(null);
  const focusPlace = (placeId: string | null) => {
    const target = placeId === null ? addName.current : editButtons.current.get(placeId);
    target?.focus();
  };
  return (
    <SettingsSection
      id={`${id}-title`}
      title={t('travel.places.title')}
      hint={t('travel.places.hint')}
      layout="stacked"
    >
      <div data-places className="flex flex-col gap-3">
        {places.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('travel.places.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {places.map((place) => (
              <PlaceRow
                key={place.id}
                workspaceId={workspaceId}
                place={place}
                onRemove={setRemoving}
                editButtonRef={(button) => {
                  if (button === null) {
                    editButtons.current.delete(place.id);
                  } else {
                    editButtons.current.set(place.id, button);
                  }
                }}
              />
            ))}
          </ul>
        )}
        {hasHome || places.length === 0 ? null : (
          <p
            data-no-home
            className="flex items-start gap-2 rounded-sm bg-sunken px-3 py-2.5 text-sm text-muted-foreground"
          >
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{t('travel.places.noHome')}</span>
          </p>
        )}
        <PlaceForm workspaceId={workspaceId} nameRef={addName} />
      </div>
      <ConfirmRemove
        open={removing !== null}
        title={t('travel.places.removeTitle', { name: removing?.name ?? '' })}
        body={t('travel.places.removeBody')}
        confirm={t('travel.places.removeConfirm')}
        onClose={() => {
          setRemoving(null);
        }}
        onCloseAutoFocus={(event) => {
          // Removed: the keyboard goes to the next place (or the one before), else to adding one,
          // at once; it comes back to this place if the removal fails.
          const after = focusAfterRemove.current;
          if (after !== null) {
            event.preventDefault();
            focusAfterRemove.current = null;
            focusPlace(after.next);
          }
        }}
        onConfirm={() => {
          if (removing === null) {
            return;
          }
          const { id: placeId, name } = removing;
          focusAfterRemove.current = {
            next: neighbourAfterRemoval(
              places.map((place) => place.id),
              placeId,
            ),
          };
          remove.mutate(placeId, {
            onSuccess: () => {
              toast.success(t('travel.places.removed', { name }));
            },
            onError: (failure) => {
              focusPlace(placeId);
              toast.error(errorMessage(t, failure, 'travel.places.removeFailed'));
            },
          });
        }}
      />
    </SettingsSection>
  );
}
