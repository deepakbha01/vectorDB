import { useState } from 'react';
import { apiClient, extractErrorMessage, Project } from '../api/client';

const MAX_LENGTH = 4000;

/**
 * The project's business use case, editable after creation by its owner (or
 * an admin): PATCH /projects/:id/use-case. The AI Factory Use Case step and
 * Workload Profile read the saved text.
 */
export function BusinessUseCaseCard({ project, onSaved }: { project: Project; onSaved: (project: Project) => void }) {
  const [editing, setEditing] = useState(false);
  const [useCase, setUseCase] = useState(project.businessUseCase ?? '');
  const [industry, setIndustry] = useState(project.industry ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEditing = () => {
    setUseCase(project.businessUseCase ?? '');
    setIndustry(project.industry ?? '');
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { data } = await apiClient.patch<Project>(`/projects/${project.id}/use-case`, { businessUseCase: useCase, industry });
      onSaved(data);
      setEditing(false);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not save the business use case.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div className="metric-label">Business use case</div>
        {!editing && (
          <button type="button" className="secondary-btn" onClick={startEditing}>
            {project.businessUseCase ? 'Edit' : 'Add'}
          </button>
        )}
      </div>

      {!editing ? (
        <>
          <p style={{ fontSize: 13, lineHeight: 1.6, margin: '8px 0 0', whiteSpace: 'pre-wrap', color: project.businessUseCase ? 'var(--text-2)' : 'var(--muted)' }}>
            {project.businessUseCase || 'No business use case recorded yet.'}
          </p>
          {project.industry && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 0' }}>Industry: {project.industry}</p>}
        </>
      ) : (
        <div className="stacked" style={{ marginTop: 8 }}>
          <div>
            <label htmlFor="edit-use-case">Business use case</label>
            <textarea id="edit-use-case" rows={5} maxLength={MAX_LENGTH} value={useCase} onChange={(e) => setUseCase(e.target.value)} />
          </div>
          <div>
            <label htmlFor="edit-industry">Industry</label>
            <input id="edit-industry" maxLength={200} value={industry} onChange={(e) => setIndustry(e.target.value)} />
          </div>
          {error && <div className="error-text">{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="primary-btn" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button type="button" className="secondary-btn" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
