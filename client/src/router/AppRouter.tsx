import { lazy } from 'react';
import { Route } from 'react-router-dom';
import { ProtectedRoute } from '@/router/ProtectedRoute';
import { ROUTES } from '@/router/routes';

// The signed-in app is its own set of chunks: public pages never load the shell, the palette
// (cmdk) or the workspace pages.
const AppShellLayout = lazy(() => import('@/features/shell/AppShellLayout'));
const FocusLayout = lazy(() => import('@/components/layouts/FocusLayout'));
const RequireWorkspace = lazy(() => import('@/router/RequireWorkspace'));

const DashboardPage = lazy(() => import('@/pages/DashboardPage'));
const TopicPage = lazy(() => import('@/pages/app/TopicPage'));
const IntegrationsPage = lazy(() => import('@/pages/app/IntegrationsPage'));
const TemplatesPage = lazy(() => import('@/pages/app/TemplatesPage'));
const ItemLinkPage = lazy(() => import('@/pages/app/ItemLinkPage'));
const WorkspaceSettingsPage = lazy(() => import('@/pages/settings/WorkspaceSettingsPage'));
const MembersPage = lazy(() => import('@/pages/settings/MembersPage'));
const AgentKeysPage = lazy(() => import('@/pages/settings/AgentKeysPage'));
const ProfilePage = lazy(() => import('@/pages/ProfilePage'));
const EditProfilePage = lazy(() => import('@/pages/EditProfilePage'));
const OnboardingPage = lazy(() => import('@/pages/onboarding/OnboardingPage'));
const AuthorizeAgentPage = lazy(() => import('@/pages/agents/AuthorizeAgentPage'));
const InviteAcceptPage = lazy(() => import('@/pages/invites/InviteAcceptPage'));
const JoinLinkPage = lazy(() => import('@/pages/invites/JoinLinkPage'));

export const appRoutes = (
  <>
    <Route
      element={
        <ProtectedRoute>
          <AppShellLayout />
        </ProtectedRoute>
      }
    >
      {/* Without a workspace, these send the user to onboarding. */}
      <Route element={<RequireWorkspace />}>
        <Route path={ROUTES.DASHBOARD} element={<DashboardPage />} />
        <Route path={ROUTES.TOPIC} element={<TopicPage />} />
        <Route path={ROUTES.TOPIC_GROUP} element={<TopicPage />} />
        <Route path={ROUTES.INTEGRATIONS} element={<IntegrationsPage />} />
        <Route path={ROUTES.TEMPLATES} element={<TemplatesPage />} />
        <Route path={ROUTES.SETTINGS} element={<WorkspaceSettingsPage />} />
        <Route path={ROUTES.MEMBERS} element={<MembersPage />} />
        <Route path={ROUTES.AGENT_KEYS} element={<AgentKeysPage />} />
        <Route path={ROUTES.ITEM_LINK} element={<ItemLinkPage />} />
      </Route>
      <Route path={ROUTES.PROFILE} element={<ProfilePage />} />
      <Route path={ROUTES.EDIT_PROFILE} element={<EditProfilePage />} />
    </Route>
    <Route
      element={
        <ProtectedRoute>
          <FocusLayout />
        </ProtectedRoute>
      }
    >
      <Route path={ROUTES.ONBOARDING} element={<OnboardingPage />} />
      <Route path={ROUTES.AUTHORIZE_AGENT} element={<AuthorizeAgentPage />} />
      <Route path={ROUTES.INVITE} element={<InviteAcceptPage />} />
      <Route path={ROUTES.JOIN} element={<JoinLinkPage />} />
    </Route>
  </>
);
