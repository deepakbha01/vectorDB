import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { TopBar } from '../components/TopBar';

export function ProjectCreatePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [businessUseCase, setBusinessUseCase] = useState('');
  const [industry, setIndustry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { data } = await apiClient.post<Project>('/projects', {
        name,
        businessUseCase: businessUseCase || undefined,
        industry: industry || undefined,
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
      <div className="card" style={{ maxWidth: 480 }}>
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
          {error && <div className="error-text">{error}</div>}
          <button className="primary-btn" type="submit" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create Project'}
          </button>
        </form>
      </div>
    </div>
  );
}
