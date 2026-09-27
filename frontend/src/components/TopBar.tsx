import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ThemeToggle } from '../theme';
import { BrandMark, usePageTitle } from './Brand';

export function TopBar({ title }: { title: string }) {
  const { user, logout } = useAuth();
  usePageTitle(title);
  return (
    <div className="top-bar">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <BrandMark />
        <h2 style={{ margin: 0 }}>{title}</h2>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: 13 }}>
        <Link to="/dashboard">Dashboard</Link>
        {user?.role === 'admin' && <Link to="/admin/users">Manage Users</Link>}
        <span style={{ color: 'var(--muted)' }}>{user?.email}</span>
        <ThemeToggle />
        <button className="primary-btn" onClick={logout}>
          Log out
        </button>
      </div>
    </div>
  );
}
