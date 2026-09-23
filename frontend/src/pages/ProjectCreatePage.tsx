import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient, CustomerMode, extractErrorMessage, PatternCatalogEntry, Project } from '../api/client';
import { TopBar } from '../components/TopBar';

export function ProjectCreatePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [businessUseCase, setBusinessUseCase] = useState('');
  const [industry, setIndustry] = useState('');
  const [customerMode, setCustomerMode] = useState<CustomerMode>('new');
  const [patterns, setPatterns] = useState<PatternCatalogEntry[]>([]);
  const [patternId, setPatternId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiClient.get<PatternCatalogEntry[]>('/projects/pattern-catalog').then((res) => setPatterns(res.data));
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { data } = await apiClient.post<Project>('/projects', {
        name,
        businessUseCase: businessUseCase || undefined,
        industry: industry || undefined,
        patternId: patternId || undefined,
        customerMode,
      });
      navigate(`/projects/${data.id}/discovery`);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not create project.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="main-content">
      <TopBar title="New Project" />
      <div className="card" style={{ maxWidth: 640 }}>
        <form className="stacked" onSubmit={onSubmit}>
          <div>
            <label>Application name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
          </div>
          <div>
            <label>Business use case</label>
            <textarea rows={3} value={businessUseCase} onChange={(e) => setBusinessUseCase(e.target.value)} />
          </div>
          <div>
            <label>Industry</label>
            <input value={industry} onChange={(e) => setIndustry(e.target.value)} />
          </div>

          <div>
            <label>Customer type</label>
            <div className="platform-options">
              <label className={`platform-option ${customerMode === 'new' ? 'selected' : ''}`} style={{ display: 'block' }}>
                <input
                  type="radio"
                  name="customerMode"
                  checked={customerMode === 'new'}
                  onChange={() => setCustomerMode('new')}
                  style={{ marginRight: 8 }}
                />
                <strong>New / Greenfield</strong>
                <div style={{ fontSize: 12, color: '#5a6472' }}>No existing vector/search deployment to account for.</div>
              </label>
              <label className={`platform-option ${customerMode === 'existing' ? 'selected' : ''}`} style={{ display: 'block' }}>
                <input
                  type="radio"
                  name="customerMode"
                  checked={customerMode === 'existing'}
                  onChange={() => setCustomerMode('existing')}
                  style={{ marginRight: 8 }}
                />
                <strong>Existing / Modernization</strong>
                <div style={{ fontSize: 12, color: '#5a6472' }}>
                  Migrating or upgrading an existing deployment - capture the current database, vector/search
                  technology, and Kubernetes footprint in Phase 1 Discovery's "Existing technology" fields.
                </div>
              </label>
            </div>
          </div>

          <div>
            <label>AI Factory pattern (optional)</label>
            <p style={{ fontSize: 12, color: '#5a6472', margin: '2px 0 10px' }}>
              Seeds sensible starting defaults for the Phase 1 Discovery assessment - every value stays fully
              editable, and Phase 4 (Vector DB Selection) still qualifies and scores platforms from scratch
              regardless of which pattern you pick.
            </p>
            <div className="platform-options">
              <label className={`platform-option ${patternId === '' ? 'selected' : ''}`} style={{ display: 'block' }}>
                <input
                  type="radio"
                  name="pattern"
                  value=""
                  checked={patternId === ''}
                  onChange={() => setPatternId('')}
                  style={{ marginRight: 8 }}
                />
                <strong>Start from scratch</strong>
                <div style={{ fontSize: 12, color: '#5a6472' }}>No pattern - use the generic Discovery defaults.</div>
              </label>
              {patterns.map((p) => (
                <label
                  key={p.id}
                  className={`platform-option ${patternId === p.id ? 'selected' : ''}`}
                  style={{ display: 'block' }}
                >
                  <input
                    type="radio"
                    name="pattern"
                    value={p.id}
                    checked={patternId === p.id}
                    onChange={() => setPatternId(p.id)}
                    style={{ marginRight: 8 }}
                  />
                  <strong>{p.name}</strong>
                  <div style={{ fontSize: 12, color: '#5a6472' }}>
                    {p.industry} - {p.description}
                  </div>
                </label>
              ))}
            </div>
          </div>

          {error && <div className="error-text">{error}</div>}
          <button className="primary-btn" type="submit" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create Project'}
          </button>
        </form>
      </div>
    </div>
  );
}
