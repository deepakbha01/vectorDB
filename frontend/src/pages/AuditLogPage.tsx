import { Fragment, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient, AuditLogEntry, Project } from '../api/client';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

function statusColor(statusCode: number): string {
  if (statusCode >= 500) return '#c0392b';
  if (statusCode >= 400) return '#c0392b';
  return '#1e8e5a';
}

export function AuditLogPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((res) => setProject(res.data));
    apiClient.get<AuditLogEntry[]>(`/projects/${id}/audit-log`).then((res) => setEntries(res.data));
  }, [id]);

  if (!project) {
    return <div className="main-content">Loading...</div>;
  }

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Audit Log" />
        <p style={{ fontSize: 13, color: '#5a6472', marginBottom: 16 }}>
          Every action taken on this project - who, what, when - most recent first. Click a row for the request/
          response details (secrets are redacted).
        </p>

        {entries.length === 0 && <div className="card">No audited actions yet.</div>}

        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #dfe3e8' }}>
                <th style={{ padding: '6px 8px' }}>Time</th>
                <th style={{ padding: '6px 8px' }}>User</th>
                <th style={{ padding: '6px 8px' }}>Method</th>
                <th style={{ padding: '6px 8px' }}>Path</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
                <th style={{ padding: '6px 8px' }}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <Fragment key={entry.id}>
                  <tr
                    style={{ borderBottom: '1px solid #eceff3', cursor: 'pointer' }}
                    onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                  >
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{new Date(entry.createdAt).toLocaleString()}</td>
                    <td style={{ padding: '6px 8px' }}>{entry.userEmail ?? 'anonymous'}</td>
                    <td style={{ padding: '6px 8px' }}>{entry.method}</td>
                    <td style={{ padding: '6px 8px' }}>{entry.path}</td>
                    <td style={{ padding: '6px 8px', color: statusColor(entry.statusCode) }}>{entry.statusCode}</td>
                    <td style={{ padding: '6px 8px' }}>{entry.durationMs}ms</td>
                  </tr>
                  {expanded === entry.id && (
                    <tr>
                      <td colSpan={6} style={{ padding: '6px 8px', background: '#f5f6f8' }}>
                        <div style={{ fontSize: 12, marginBottom: 4 }}>
                          <strong>Request:</strong>
                        </div>
                        <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '0 0 8px' }}>
                          {JSON.stringify(entry.requestSummary, null, 2)}
                        </pre>
                        <div style={{ fontSize: 12, marginBottom: 4 }}>
                          <strong>Response:</strong>
                        </div>
                        <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0 }}>
                          {JSON.stringify(entry.responseSummary, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
