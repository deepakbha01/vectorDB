import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { AdminUserSummary, apiClient, extractErrorMessage, UserRole } from '../api/client';
import { TopBar } from '../components/TopBar';
import { useAuth } from '../auth/AuthContext';

const ROLES: UserRole[] = ['admin', 'architect', 'viewer'];

export function UsersManagementPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AdminUserSummary[] | null>(null);
  const [pendingRole, setPendingRole] = useState<Record<string, UserRole>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (currentUser?.role !== 'admin') return;
    apiClient
      .get<AdminUserSummary[]>('/users')
      .then((res) => setUsers(res.data))
      .catch((err) => setLoadError(extractErrorMessage(err, 'Could not load users.')));
  }, [currentUser]);

  if (currentUser?.role !== 'admin') {
    return <Navigate to="/dashboard" replace />;
  }

  const saveRole = async (id: string) => {
    const role = pendingRole[id];
    if (!role) return;
    setSavingId(id);
    setRowError((prev) => ({ ...prev, [id]: '' }));
    try {
      const { data } = await apiClient.patch<AdminUserSummary>(`/users/${id}/role`, { role });
      setUsers((prev) => prev?.map((u) => (u.id === id ? data : u)) ?? null);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [id]: extractErrorMessage(err, 'Could not update this role.') }));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="main-content">
      <TopBar title="Manage Users" />

      <p style={{ fontSize: 13, color: '#5a6472', marginBottom: 20 }}>
        The Create Account page always signs new users up as <strong>architect</strong> - this is the only place to
        promote someone to <strong>admin</strong> (who can execute real infrastructure changes in Phase 4) or restrict
        them to <strong>viewer</strong> (read-only).
      </p>

      {loadError && <p className="error-text">{loadError}</p>}

      {users && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #dfe3e8' }}>
                <th style={{ padding: '6px 8px' }}>Email</th>
                <th style={{ padding: '6px 8px' }}>Name</th>
                <th style={{ padding: '6px 8px' }}>Current role</th>
                <th style={{ padding: '6px 8px' }}>Created</th>
                <th style={{ padding: '6px 8px' }}>Change role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ borderBottom: '1px solid #eceff3' }}>
                  <td style={{ padding: '6px 8px' }}>
                    {u.email}
                    {u.id === currentUser.id && <span style={{ color: '#5a6472' }}> (you)</span>}
                  </td>
                  <td style={{ padding: '6px 8px' }}>{u.fullName ?? '-'}</td>
                  <td style={{ padding: '6px 8px' }}>
                    <span className="status-pill">{u.role}</span>
                  </td>
                  <td style={{ padding: '6px 8px' }}>{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td style={{ padding: '6px 8px' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <select
                        value={pendingRole[u.id] ?? u.role}
                        onChange={(e) => setPendingRole((prev) => ({ ...prev, [u.id]: e.target.value as UserRole }))}
                        style={{ padding: '4px 6px', border: '1px solid #dfe3e8', borderRadius: 6, fontSize: 13 }}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <button
                        className="primary-btn"
                        disabled={savingId === u.id || (pendingRole[u.id] ?? u.role) === u.role}
                        onClick={() => saveRole(u.id)}
                      >
                        {savingId === u.id ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                    {rowError[u.id] && <div className="error-text" style={{ marginTop: 4 }}>{rowError[u.id]}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
