import { useId, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select';
import { useCreateTopic, useDeleteTopic, useUpdateTopic } from '@/api/queries/topics';
import { errorMessage } from '@/api/errors';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES, topicPath } from '@/router/routes';
import { useTemplateShareConfirm } from '@/features/templates/useTemplateShareConfirm';
import { renameStep } from '@/features/shell/renameTopic';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { cn } from '@/lib/utils';
import { TOPIC_NAME_MAX } from '@api-types/topics';
import type { TopicView } from '@api-types/api-contracts';

/** The page templates a new page may start from (topic pages only), by key. */
const PAGE_TEMPLATES = [
  { key: '', label: 'topics.templates.none' },
  { key: 'work@1', label: 'topics.templates.work' },
  { key: 'college@1', label: 'topics.templates.college' },
  { key: 'personal@1', label: 'topics.templates.personal' },
  { key: 'dashboard@1', label: 'topics.templates.dashboard' },
] as const;

/**
 * "+ Add page": a name and an optional template; the new page opens at once. Its first page is
 * made with it on the server (empty, or from the template).
 */
export function AddPageDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const navigate = useNavigate();
  const { workspace } = useCurrentWorkspace();
  const createTopic = useCreateTopic(workspace?.id ?? '');
  const shareConfirm = useTemplateShareConfirm(workspace?.id ?? '');
  const formId = useId();
  const [name, setName] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = (next: boolean) => {
    if (!next) {
      setName('');
      setTemplateKey('');
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError(t('topics.add.nameRequired'));
      return;
    }
    setError(null);
    // A page template never shares silently: ask first when it would attach unshared connections.
    const choice = templateKey === '' ? null : await shareConfirm.ask([templateKey]);
    if (templateKey !== '' && choice === null) {
      return;
    }
    createTopic.mutate(
      {
        name: trimmed,
        language: language === 'he' ? 'he' : 'en',
        ...(templateKey === '' ? {} : { templateKey }),
        ...(choice === null ? {} : { shareIntegrations: choice.shareIntegrations }),
      },
      {
        onSuccess: ({ topic }) => {
          toast.success(t('topics.add.done', { name: topic.name }));
          close(false);
          void navigate(pathTo(topicPath(topic.slug), language));
        },
        onError: (err) => {
          setError(errorMessage(t, err, 'topics.add.failed'));
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('topics.add.title')}</DialogTitle>
          <DialogDescription>
            {t('topics.add.body', { workspace: workspace?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-name`}>{t('topics.add.name')}</Label>
            <Input
              id={`${formId}-name`}
              value={name}
              dir="auto"
              maxLength={TOPIC_NAME_MAX}
              autoComplete="off"
              placeholder={t('topics.add.namePlaceholder')}
              aria-invalid={error !== null}
              aria-describedby={error === null ? undefined : `${formId}-error`}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label id={`${formId}-template-label`}>{t('topics.add.template')}</Label>
            <SelectField
              aria-labelledby={`${formId}-template-label`}
              value={templateKey}
              onValueChange={setTemplateKey}
              options={PAGE_TEMPLATES.map(({ key, label }) => ({ value: key, label: t(label) }))}
            />
          </div>
          {error === null ? null : (
            <p id={`${formId}-error`} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={createTopic.isPending}
            onClick={() => {
              close(false);
            }}
          >
            {t('topics.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={createTopic.isPending || shareConfirm.checking}
          >
            {createTopic.isPending ? t('topics.add.submitting') : t('topics.add.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
      {shareConfirm.dialog}
    </Dialog>
  );
}

/**
 * A topic's name, edited in place: Enter or leaving the field saves, Escape keeps the old one. While
 * the name is being saved the field stays (renameStep), so its toast shows.
 */
export function RenameTopicInput({
  topic,
  onDone,
  className,
}: {
  topic: TopicView;
  onDone: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const { workspace } = useCurrentWorkspace();
  const updateTopic = useUpdateTopic(workspace?.id ?? '');
  const [name, setName] = useState(topic.name);

  const save = () => {
    const step = renameStep(name, topic.name, updateTopic.isPending);
    if (step === 'wait') {
      return;
    }
    if (step === 'close') {
      onDone();
      return;
    }
    updateTopic.mutate(
      { topicId: topic.id, body: { name: name.trim() } },
      {
        onSuccess: (updated) => {
          toast.success(t('topics.renamed', { name: updated.name }));
          onDone();
        },
        onError: (err) => {
          toast.error(errorMessage(t, err, 'topics.renameFailed'));
          onDone();
        },
      },
    );
  };

  return (
    <Input
      autoFocus
      value={name}
      dir="auto"
      maxLength={TOPIC_NAME_MAX}
      aria-label={t('topics.renameLabel', { name: topic.name })}
      disabled={updateTopic.isPending}
      className={cn('h-8 min-h-0 text-[13px]', className)}
      onChange={(event) => {
        setName(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          save();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onDone();
        }
      }}
      onBlur={save}
    />
  );
}

/**
 * Deleting a topic, after a confirmation: its pages go (dashboards, views, layout, filters), its
 * items stay as Unsorted. Leaving its page when it was open.
 */
export function DeleteTopicDialog({
  topic,
  open,
  onOpenChange,
}: {
  topic: TopicView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { workspace } = useCurrentWorkspace();
  const ownPath = pathTo(topicPath(topic.slug), language);
  // Before the topic leaves the cache (and this dialog with it): leave its page, then say so.
  const deleteTopic = useDeleteTopic(workspace?.id ?? '', () => {
    onOpenChange(false);
    if (pathname === ownPath || pathname.startsWith(`${ownPath}/`)) {
      void navigate(pathTo(ROUTES.DASHBOARD, language), { replace: true });
    }
    toast.success(t('topics.deleted', { name: topic.name }));
  });
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('topics.deleteTitle', { name: topic.name })}</AlertDialogTitle>
          <AlertDialogDescription>{t('topics.deleteBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteTopic.isPending}>
            {t('topics.cancel')}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={deleteTopic.isPending}
            onClick={() => {
              deleteTopic.mutate(topic.id, {
                onError: (err) => {
                  toast.error(errorMessage(t, err, 'topics.deleteFailed'));
                },
              });
            }}
          >
            {t('topics.deleteConfirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A topic row's "…" menu: Rename (in place) and Delete (after a confirmation). */
export function TopicRowMenu({
  topic,
  onRename,
  className,
}: {
  topic: TopicView;
  onRename: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('topics.menu', { name: topic.name })}
            className={cn('shrink-0 text-muted-foreground hover:text-foreground', className)}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={onRename}>
            <Pencil aria-hidden="true" />
            {t('topics.rename')}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              setDeleting(true);
            }}
          >
            <Trash2 aria-hidden="true" />
            {t('topics.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteTopicDialog topic={topic} open={deleting} onOpenChange={setDeleting} />
    </>
  );
}
