import { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { useBlockData } from '@/api/queries/blocks';
import { browserTimeZone } from '@/components/items/format';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { selectUser } from '@/store/userSlice';
import type { Block, ItemQueryRow } from '@api-types/builder';
import type { DashboardView } from '@api-types/dashboards';
import type { BlockStatus } from '../../BlockFrame';
import { applyDisplayRules, type DisplayedRow } from '../../rules/applyDisplayRules';
import { usePageVars } from '../../variables/pageVars';
import { itemRowsOf } from './rows';

/** The current time, refreshed every minute so "today" and "overdue" move on without a reload. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 60_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  return now;
}

/**
 * What every data block needs: its query result, the item rows after the display rules (hidden
 * rows already removed), the frame status, and the workspace's clock (time zone, week start).
 */
export function useDataBlock(dashboard: DashboardView, block: Block) {
  const { vars } = usePageVars();
  const query = useBlockData(dashboard, block, vars);
  const { workspace } = useCurrentWorkspace();
  const user = useSelector(selectUser);
  const now = useNow();
  const timeZone = workspace?.settings.timezone ?? browserTimeZone();
  const weekStart = workspace?.settings.weekStart;
  const userId = user?.id ?? '';
  const data = query.data;

  const rows = useMemo((): DisplayedRow<ItemQueryRow>[] => {
    return applyDisplayRules(itemRowsOf(data), block.rules, {
      now,
      timeZone,
      userId,
      weekStart,
      vars,
    }).filter((entry) => !entry.hidden);
  }, [data, block.rules, now, timeZone, userId, weekStart, vars]);

  const loadState: BlockStatus = query.isLoading ? 'loading' : query.isError ? 'error' : 'ready';
  return { query, rows, loadState, now, timeZone, weekStart, vars };
}
