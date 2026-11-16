import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Mail } from 'lucide-react';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { pageTitle } from '@/data/pageTitles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { FormError, FormField } from '@/components/auth/auth-ui';
import { browserTimeZone, dateLocale, shortDate } from '@/components/items/format';
import { useCreateWorkspace, useMyInvites, useRuntime } from '@/api/queries';
import { apiErrorCode, errorMessage } from '@/api/errors';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { selectUser } from '@/store/userSlice';
import {
  isValidSlug,
  randomWorkspaceSlug,
  slugForForm,
  tidySlugInput,
} from '@/features/workspaces/slug';
import { TimeZoneSelect } from '@/features/workspaces/TimeZoneSelect';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useSwitchWorkspace } from '@/features/workspaces/useSwitchWorkspace';
import type { CreateWorkspaceRequestBody } from '@api-types/api-contracts';

function CreateWorkspaceForm() {
  const { t } = useTranslation();
  const switchWorkspace = useSwitchWorkspace();
  const createWorkspace = useCreateWorkspace();
  const { data: runtime } = useRuntime();
  const formId = useId();

  const [name, setName] = useState('');
  const [typedSlug, setTypedSlug] = useState<string | null>(null);
  const [randomFallback] = useState(() => randomWorkspaceSlug());
  const [timezone, setTimezone] = useState(browserTimeZone);
  const [loadDemoData, setLoadDemoData] = useState(true);
  const [slugTaken, setSlugTaken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = slugForForm({ name, typed: typedSlug, randomFallback });
  const slugInvalid = typedSlug !== null && !isValidSlug(typedSlug);
  const demoAvailable = runtime?.demoDataAvailable === true;
  const slugHintId = `${formId}-slug-hint`;
  const slugErrorId = `${formId}-slug-error`;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim() === '' || slugInvalid) {
      return;
    }
    setError(null);
    setSlugTaken(false);
    const body: CreateWorkspaceRequestBody = {
      name: name.trim(),
      timezone,
      ...(slug.send ? { slug: slug.slug } : {}),
      ...(demoAvailable ? { loadDemoData } : {}),
    };
    createWorkspace.mutate(body, {
      onSuccess: (created) => {
        // The server made it my default already; switch without asking it again.
        switchWorkspace(created.id, { remember: false });
      },
      onError: (err) => {
        // A slug the person typed (or the random one shown) is reported on its field.
        if (apiErrorCode(err) === 'slug_taken' && slug.send) {
          setSlugTaken(true);
          return;
        }
        setError(errorMessage(t, err, 'onboarding.form.failed'));
      },
    });
  };

  const slugError = slugInvalid
    ? t('onboarding.form.slugInvalid')
    : slugTaken
      ? t('onboarding.form.slugTaken')
      : null;

  return (
    <section
      aria-labelledby={`${formId}-title`}
      className="flex flex-col gap-5 rounded-lg border bg-card p-5 sm:p-6"
    >
      <h2 id={`${formId}-title`} className="text-base font-semibold">
        {t('onboarding.form.title')}
      </h2>
      <form onSubmit={submit} className="flex flex-col gap-5">
        {error === null ? null : <FormError>{error}</FormError>}

        <FormField label={t('onboarding.form.name')} htmlFor={`${formId}-name`}>
          <Input
            id={`${formId}-name`}
            value={name}
            maxLength={80}
            autoComplete="organization"
            onChange={(e) => {
              setName(e.target.value);
            }}
            required
            disabled={createWorkspace.isPending}
          />
        </FormField>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${formId}-slug`} className="text-sm font-medium">
            {t('onboarding.form.slug')}
          </label>
          <Input
            id={`${formId}-slug`}
            value={slug.slug}
            dir="ltr"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            className="text-start"
            aria-invalid={slugError !== null}
            aria-describedby={slugError === null ? slugHintId : `${slugErrorId} ${slugHintId}`}
            onChange={(e) => {
              setTypedSlug(tidySlugInput(e.target.value));
              setSlugTaken(false);
            }}
            disabled={createWorkspace.isPending}
          />
          {slugError === null ? null : (
            <p id={slugErrorId} className="text-[13px] text-destructive">
              {slugError}
            </p>
          )}
          <p id={slugHintId} className="text-[13px] text-muted-foreground">
            {t('onboarding.form.slugHint')}
          </p>
        </div>

        <FormField
          label={t('onboarding.form.timezone')}
          htmlFor={`${formId}-timezone`}
          hint={t('onboarding.form.timezoneHint')}
        >
          <TimeZoneSelect
            id={`${formId}-timezone`}
            value={timezone}
            onChange={setTimezone}
            disabled={createWorkspace.isPending}
            searchLabel={t('settings.fields.timezoneSearch')}
            emptyLabel={t('settings.fields.timezoneEmpty')}
            aria-describedby={`${formId}-timezone-hint`}
          />
        </FormField>

        {demoAvailable ? (
          // The whole box toggles: the label stretches over it, the checkbox stays on top.
          <div className="relative flex items-start gap-3 rounded-sm bg-sunken p-3">
            <Checkbox
              id={`${formId}-demo`}
              checked={loadDemoData}
              onCheckedChange={(checked) => {
                setLoadDemoData(checked === true);
              }}
              aria-describedby={`${formId}-demo-hint`}
              disabled={createWorkspace.isPending}
              className="relative z-10 mt-0.5"
            />
            <div className="flex flex-col gap-0.5">
              <label
                htmlFor={`${formId}-demo`}
                className="cursor-pointer text-sm font-medium after:absolute after:inset-0"
              >
                {t('onboarding.form.demo')}
              </label>
              <p id={`${formId}-demo-hint`} className="text-[13px] text-muted-foreground">
                {t('onboarding.form.demoHint')}
              </p>
            </div>
          </div>
        ) : null}

        <Button
          type="submit"
          className="h-10 self-start px-5"
          disabled={createWorkspace.isPending || name.trim() === '' || slugInvalid}
        >
          {createWorkspace.isPending
            ? t('onboarding.form.submitting')
            : t('onboarding.form.submit')}
        </Button>
      </form>
    </section>
  );
}

function PendingInvites() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const user = useSelector(selectUser);
  const { data: invites } = useMyInvites();
  const locale = dateLocale(language);
  const timeZone = browserTimeZone();

  return (
    <section aria-labelledby="pending-invites-title" className="flex flex-col gap-3">
      <h2 id="pending-invites-title" className="text-base font-semibold break-words">
        {t('onboarding.invites.title', { email: user?.email ?? '' })}
      </h2>
      {invites !== undefined && invites.length > 0 ? (
        <>
          <ul className="flex flex-col divide-y rounded-lg border bg-card">
            {invites.map((invite) => (
              <li key={invite.id} className="flex items-center gap-3 px-4 py-3">
                <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{invite.workspaceName}</span>
                  <span className="text-[13px] text-muted-foreground">
                    {t('onboarding.invites.detail', {
                      role: t(`app.roles.${invite.role}`),
                      date: shortDate(new Date(invite.expiresAt), locale, timeZone),
                    })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">{t('onboarding.invites.open')}</p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('onboarding.invites.none')}</p>
      )}
    </section>
  );
}

/**
 * First sign-in, or "Create workspace" later: create a workspace, or see the invites
 * waiting for my email (joining needs the emailed link, which carries the token).
 */
export default function OnboardingPage() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { workspace } = useCurrentWorkspace();
  const another = workspace !== null;

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-8">
      <PageMetadata
        title={pageTitle(another ? t('onboarding.titleAnother') : t('onboarding.title'))}
        noIndex
      />
      <div className="flex flex-col gap-2">
        {another ? (
          <Link
            to={pathTo(ROUTES.DASHBOARD, language)}
            className="mb-3 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-sm text-sm pointer-fine:min-h-0 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            {t('onboarding.back', { workspace: workspace.name })}
          </Link>
        ) : null}
        <h1 className="text-2xl leading-tight font-semibold md:text-3xl">
          {another ? t('onboarding.titleAnother') : t('onboarding.title')}
        </h1>
        <p className="max-w-[60ch] text-base text-pretty text-muted-foreground">
          {another ? t('onboarding.leadAnother') : t('onboarding.lead')}
        </p>
      </div>
      <CreateWorkspaceForm />
      <PendingInvites />
    </div>
  );
}
