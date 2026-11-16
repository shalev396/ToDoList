import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { selectIsAuthenticated, selectIsRestoringSession } from '@/store/userSlice';
import { selectCurrentWorkspaceId } from '@/store/workspaceSlice';
import { pathTo, ROUTES } from '@/router/routes';
import { safeNextPath } from '@/router/next';

interface GuestRouteProps {
  children: React.ReactNode;
}

/**
 * The auth pages, for signed-out visitors. Once signed in (also right after logging in here) the
 * user goes to `?next=` when it is an app page, else to the dashboard, or to onboarding when the
 * login reported no workspace (LoginPage then selects none).
 */
export function GuestRoute({ children }: GuestRouteProps) {
  const isAuthenticated = useSelector(selectIsAuthenticated);
  const isRestoring = useSelector(selectIsRestoringSession);
  const currentWorkspaceId = useSelector(selectCurrentWorkspaceId);
  const [searchParams] = useSearchParams();
  const { lng } = useParams<{ lng: string }>();
  const language = lng ?? 'en';

  if (isRestoring) {
    return null;
  }

  if (isAuthenticated) {
    const next = safeNextPath(searchParams.get('next'));
    const fallback = currentWorkspaceId === null ? ROUTES.ONBOARDING : ROUTES.DASHBOARD;
    return <Navigate to={next ?? pathTo(fallback, language)} replace />;
  }

  return <>{children}</>;
}
