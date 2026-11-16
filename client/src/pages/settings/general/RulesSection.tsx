import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select';
import { topicById } from '@/features/workspaces/topics';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import { MAX_RULES, newRuleKey, type Draft, type RuleDraft } from '@/pages/settings/general/draft';

interface RulesSectionProps {
  formId: string;
  draft: Draft;
  canEdit: boolean;
  disabled: boolean;
  /** Point out rules without a pattern (after a save attempt). */
  showErrors: boolean;
  onChange: (patch: Partial<Draft>) => void;
}

/** Topic rules: an ordered list of {pattern, topic}, added, moved and removed here. */
export function RulesSection({
  formId,
  draft,
  canEdit,
  disabled,
  showErrors,
  onChange,
}: RulesSectionProps) {
  const { t } = useTranslation();
  const { topics } = useCurrentWorkspace();
  const [firstTopic] = topics;
  const topicOptions = topics.map((topic) => ({ value: topic.id, label: topic.name }));

  const updateRule = (key: number, patch: Partial<RuleDraft>) => {
    onChange({
      rules: draft.rules.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)),
    });
  };
  const moveRule = (index: number, offset: -1 | 1) => {
    const rules = [...draft.rules];
    const [rule] = rules.splice(index, 1);
    if (rule !== undefined) {
      rules.splice(index + offset, 0, rule);
    }
    onChange({ rules });
  };

  return (
    <SettingsSection
      id={`${formId}-rules`}
      title={t('settings.sections.rules')}
      hint={t('settings.sections.rulesHint')}
    >
      {draft.rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settings.rules.empty')}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {draft.rules.map((rule, index) => {
            const n = index + 1;
            const missing = showErrors && rule.match.trim() === '';
            const label = t('settings.rules.rule', { n });
            return (
              <li key={rule.key} aria-label={label} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="w-5 shrink-0 text-center text-[13px] text-muted-foreground tabular-nums"
                  >
                    {n}
                  </span>
                  <Input
                    value={rule.match}
                    dir="ltr"
                    maxLength={200}
                    spellCheck={false}
                    aria-label={`${t('settings.rules.match')} (${label})`}
                    aria-invalid={missing}
                    placeholder={t('settings.rules.matchPlaceholder')}
                    className="min-w-40 flex-1 text-start"
                    onChange={(e) => {
                      updateRule(rule.key, { match: e.target.value });
                    }}
                    disabled={disabled}
                  />
                  <SelectField
                    value={rule.topicId}
                    aria-label={`${t('settings.rules.topic')} (${label})`}
                    className="w-40"
                    onValueChange={(next) => {
                      if (topicById(topics, next) !== null) {
                        updateRule(rule.key, { topicId: next });
                      }
                    }}
                    disabled={disabled}
                    options={topicOptions}
                  />
                  {canEdit ? (
                    <div className="flex items-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('settings.rules.moveUp', { n })}
                        disabled={disabled || index === 0}
                        onClick={() => {
                          moveRule(index, -1);
                        }}
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('settings.rules.moveDown', { n })}
                        disabled={disabled || index === draft.rules.length - 1}
                        onClick={() => {
                          moveRule(index, 1);
                        }}
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('settings.rules.remove', { n })}
                        disabled={disabled}
                        onClick={() => {
                          onChange({ rules: draft.rules.filter((r) => r.key !== rule.key) });
                        }}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </div>
                  ) : null}
                </div>
                {missing ? (
                  <p className="ps-7 text-[13px] text-destructive">
                    {t('settings.rules.matchRequired')}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {canEdit ? (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={disabled || draft.rules.length >= MAX_RULES || firstTopic === undefined}
            onClick={() => {
              if (firstTopic === undefined) {
                return;
              }
              onChange({
                rules: [...draft.rules, { key: newRuleKey(), match: '', topicId: firstTopic.id }],
              });
            }}
          >
            <Plus aria-hidden="true" />
            {t('settings.rules.add')}
          </Button>
          <p className="text-[13px] text-muted-foreground">{t('settings.rules.matchHint')}</p>
        </div>
      ) : null}
    </SettingsSection>
  );
}
