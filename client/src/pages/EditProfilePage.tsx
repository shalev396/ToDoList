import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { ImageUpload } from '@/components/shared/ImageUpload';
import { useMe, useUpdateMe } from '@/api/queries';
import { stageFile, StagedUploadError, UPLOAD_RULES } from '@/api/services/stagedUpload';
import { pageTitle } from '@/data/pageTitles';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { PageContainer, PageHeader } from '@/features/shell/PageHeader';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import type { UpdateMeRequestBody } from '@api-types/api-contracts';

const PHOTO_RULE = UPLOAD_RULES['account-photo'];

export default function EditProfilePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const { data: meData } = useMe();
  const updateMe = useUpdateMe();

  // Undefined until the user types, so the field shows the server name once it arrives.
  const [nameDraft, setNameDraft] = useState<string>();
  const name = nameDraft ?? meData?.name ?? '';

  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoRemoved, setPhotoRemoved] = useState(false);
  const [isStaging, setIsStaging] = useState(false);

  const currentPhotoUrl = meData?.photoUrl ?? null;
  const isSaving = isStaging || updateMe.isPending;

  const nameChanged = name !== '' && name !== (meData?.name ?? '');
  const hasChanges = nameChanged || photoFile !== null || photoRemoved;

  function handlePhotoChange(file: File | null) {
    setPhotoFile(file);
    // Clearing only means "remove" when there is a saved photo to remove.
    setPhotoRemoved(file === null && currentPhotoUrl !== null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (!hasChanges) {
      toast.info(t('profile.edit.noChanges'));
      return;
    }

    const payload: UpdateMeRequestBody = {};
    if (nameChanged) {
      payload.name = name;
    }

    try {
      if (photoFile) {
        setIsStaging(true);
        try {
          payload.photo = await stageFile(photoFile, 'account-photo');
        } finally {
          setIsStaging(false);
        }
      } else if (photoRemoved) {
        payload.removePhoto = true;
      }
      await updateMe.mutateAsync(payload);
      toast.success(t('profile.edit.success'));
      void navigate(pathTo(ROUTES.PROFILE, language));
    } catch (err) {
      // API errors are already reported by the axios interceptor; the direct S3 upload and
      // client-side validation are not, so report those here.
      if (err instanceof StagedUploadError) {
        toast.error(t(err.i18nKey, err.params));
      }
    }
  }

  return (
    <PageContainer width="reading">
      <PageMetadata title={pageTitle(t('profile.edit.title'))} noIndex />
      <PageHeader title={t('profile.edit.title')} description={t('profile.edit.subtitle')}>
        <Link
          to={pathTo(ROUTES.PROFILE, language)}
          className="-order-1 inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          {t('profile.title')}
        </Link>
      </PageHeader>

      <form onSubmit={(e) => void handleSubmit(e)}>
        <SettingsSection
          id="edit-photo"
          title={t('profile.edit.photoLabel')}
          hint={t('profile.edit.photoHint')}
        >
          <ImageUpload
            value={photoRemoved ? null : currentPhotoUrl}
            onChange={handlePhotoChange}
            rule={PHOTO_RULE}
            chooseLabel={t('profile.edit.chooseFile')}
            changeLabel={t('profile.edit.changeFile')}
            removeLabel={t('profile.edit.removeFile')}
            previewAlt={t('profile.edit.photoPreviewAlt')}
            disabled={isSaving}
          />
          {photoFile ? (
            <p className="truncate text-xs text-muted-foreground">{photoFile.name}</p>
          ) : null}
        </SettingsSection>

        <SettingsSection id="edit-details" title={t('profile.info.title')}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="name" className="text-sm font-medium">
              {t('profile.edit.nameLabel')}
            </label>
            <Input
              id="name"
              value={name}
              autoComplete="name"
              onChange={(e) => {
                setNameDraft(e.target.value);
              }}
              placeholder={t('profile.edit.namePlaceholder')}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-sm font-medium">
              {t('profile.edit.emailLabel')}
            </label>
            <Input
              id="email"
              value={meData?.email ?? ''}
              readOnly
              dir="ltr"
              aria-describedby="email-hint"
              className="bg-sunken text-start text-muted-foreground"
            />
            <p id="email-hint" className="text-[13px] text-muted-foreground">
              {t('profile.edit.emailReadonly')}
            </p>
          </div>
        </SettingsSection>

        <div className="flex justify-end border-t pt-5">
          <Button type="submit" disabled={isSaving || !hasChanges}>
            {isSaving ? t('profile.edit.submitting') : t('profile.edit.submit')}
          </Button>
        </div>
      </form>
    </PageContainer>
  );
}
