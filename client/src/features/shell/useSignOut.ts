import { useCallback } from 'react';
import { useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { logout } from '@/store/userSlice';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';

/**
 * Signs out and goes home. App clears the query cache when the user changes, and the workspace
 * slice forgets the workspace on logout.
 */
export function useSignOut(): () => void {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { language } = useLanguage();
  return useCallback(() => {
    dispatch(logout({ signedOut: true }));
    void navigate(pathTo(ROUTES.HOME, language));
  }, [dispatch, navigate, language]);
}
