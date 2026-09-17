import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function TopBar({ title }: { title: string }) {
  const { user, logout } = useAuth();
  return (
    <div className="top-bar">
      <h2 style={{ margin: 0 }}>{title}</h2>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: 13 }}>
        <Link to="/dashboard">Dashboard</Link>
        {user?.role === 'admin' && <Link to="/admin/users">Manage Users</Link>}
        <span style={{ color: '#5a6472' }}>{user?.email}</span>
        <button className="primary-btn" onClick={logout}>
          Log out
        </button>
      </div>
    </div>
  );
}
