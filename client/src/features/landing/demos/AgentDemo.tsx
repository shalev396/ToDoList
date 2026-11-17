import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DeadlineRow } from '@/components/items/DeadlineRow';
import { demoAgentChat, demoLanguage, demoUpcomingDeadlines } from '../demoData';
import { Block } from '../layout';
import { ProviderIcon } from '../ProviderIcon';

/** An AI agent answering from TodoList's MCP server with the same deadline rows as the app. */
export function AgentDemo({ now, timeZone }: { now: Date; timeZone: string }) {
  const { t, i18n } = useTranslation();
  const lang = demoLanguage(i18n.language);
  const chat = demoAgentChat(lang);
  const deadlines = useMemo(() => demoUpcomingDeadlines(now, lang, 3), [now, lang]);

  return (
    <Block className="flex flex-col gap-5 p-4">
      <div className="flex flex-col items-end gap-1.5">
        <p className="text-xs text-muted-foreground">{t('landing.agents.you')}</p>
        <p className="max-w-[85%] rounded-lg bg-sunken px-3.5 py-2.5 text-sm">{chat.question}</p>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">{t('landing.agents.agent')}</p>
        <p className="text-sm">{chat.answer}</p>
        <ul className="mt-1 divide-y rounded-md border px-3">
          {deadlines.map((deadline) => (
            <li key={deadline.id}>
              <DeadlineRow
                title={deadline.title}
                context={deadline.context}
                source={deadline.source}
                due={deadline.due}
                now={now}
                timeZone={timeZone}
                showSource
              />
            </li>
          ))}
        </ul>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ProviderIcon name="mcp" className="size-3.5" />
          {t('landing.agents.via')}
        </p>
      </div>
    </Block>
  );
}
