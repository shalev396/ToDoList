import { Outlet } from 'react-router-dom';
import NavBar from '@/components/shared/NavBar';
import Footer from '@/components/shared/Footer';

/** Long-form pages (Privacy, Terms): the public nav and footer around a reading column. */
export function DocLayout() {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <NavBar />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
