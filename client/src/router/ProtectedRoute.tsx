import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useSelector } from 'react-redux';
import {
  selectIsAuthenticated,
  selectIsRestoringSession,
  selectSignedOut,
} from '@/store/userSlice';
import { pathTo, ROUTES } from '@/router/routes';
import { loginPathWithNext } from '@/router/next';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const isAuthenticated = useSelector(selectIsAuthenticated);
  const isRestoring = useSelector(selectIsRestoringSession);
  const signedOut = useSelector(selectSignedOut);
  const location = useLocation();
  const { lng } = useParams<{ lng: string }>();
  const language = lng ?? 'en';

  // App.tsx is performing a silent token refresh (new tab with refresh token)
  if (isRestoring) {
    return null;
  }

  if (!isAuthenticated) {
    // A user who just logged out or deleted their account goes home, not to the login page.
    // Anyone else logs in and comes back here (an invite link, an item link).
    const target = signedOut
      ? pathTo(ROUTES.HOME, language)
      : loginPathWithNext(language, `${location.pathname}${location.search}`);
    return <Navigate to={target} replace />;
  }

  return <>{children}</>;
}
