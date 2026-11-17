import { DashboardPage } from '@/features/dashboards/DashboardPage';
import type { DashboardRoute } from '@/features/dashboards/variables/routeBindings';

const MAIN: DashboardRoute = { kind: 'main' };

/** `/dashboard`: the workspace's main dashboard. */
export default function MainDashboardPage() {
  return <DashboardPage route={MAIN} />;
}
