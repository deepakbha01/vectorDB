import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ThemeToggle } from '../theme';
import { BrandMark, usePageTitle } from './Brand';

/**
 * Page header: a utility row (brand, navigation, signed-in user, theme,
 * log out) above the page heading. `eyebrow` is a short label over the title,
 * e.g. "Phase 1 · Discovery".
 */
export function TopBar({ title, eyebrow }: { title: string; eyebrow?: string }) {
  const { user, logout } = useAuth();
  usePageTitle(eyebrow ? `${eyebrow} - ${title}` : title);
  const initial = user?.email?.charAt(0).toUpperCase() ?? '?';
  return (
    <header className="top-bar">
      <div className="top-bar-row">
        <BrandMark />
        <div className="top-bar-actions">
          <nav className="top-bar-nav" aria-label="Main">
            <NavLink to="/dashboard">Dashboard</NavLink>
            {user?.role === 'admin' && <NavLink to="/admin/users">Manage Users</NavLink>}
          </nav>
          <span className="top-bar-divider" aria-hidden="true" />
          <span className="top-bar-user" title={user?.email}>
            <span className="top-bar-avatar" aria-hidden="true">
              {initial}
            </span>
            <span className="top-bar-email">{user?.email}</span>
          </span>
          <ThemeToggle />
          <button type="button" className="top-bar-logout" onClick={logout}>
            Log out
          </button>
        </div>
      </div>
      <div className="page-heading">
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
      </div>
    </header>
  );
}
