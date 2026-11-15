import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PRESELECT_KEY } from './AlsoCreateIn';
import { takeConsentReturn } from './useCopyRunner';
import { ITEM_PARAM } from '../useItemParam';

/**
 * Back from consenting to a provider (the callback lands on the integrations page with
 * `?connected=`): when a create asked for the consent, go back to that to-do's sheet with the
 * target selected; when an item's "Allow TodoList to edit" asked, back to that item's sheet. Nothing secret is stored: a path, a to-do id and an integration id.
 */
export function useConsentReturn(): void {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('connected')) {
      return;
    }
    const back = takeConsentReturn();
    if (back === null) {
      return;
    }
    if (back.preselect !== false) {
      try {
        sessionStorage.setItem(PRESELECT_KEY, back.integrationId);
      } catch {
        /* the sheet still opens */
      }
    }
    const target = new URL(back.path, window.location.origin);
    target.searchParams.set(ITEM_PARAM, back.todoId);
    void navigate(`${target.pathname}${target.search}`, {
      replace: true,
      state: { itemSheet: true },
    });
  }, [location.search, navigate]);
}
