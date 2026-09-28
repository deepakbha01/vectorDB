import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient, CustomerMode, extractErrorMessage, PatternCatalogEntry, Project, UseCaseSuggestion } from '../api/client';
import { TopBar } from '../components/TopBar';

/** Wait this long after the last keystroke in the application name before asking for a suggestion. */
const SUGGEST_DEBOUNCE_MS = 400;
const SUGGEST_MIN_LENGTH = 3;

type SuggestedField = 'businessUseCase' | 'industry' | 'patternId' | 'customerMode';
const UNTOUCHED: Record<SuggestedField, boolean> = { businessUseCase: false, industry: false, patternId: false, customerMode: false };

const CONFIDENCE_PILL: Record<UseCaseSuggestion['confidence'], string> = { high: 'validated', medium: 'warning', low: '' };

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
  const [suggestion, setSuggestion] = useState<UseCaseSuggestion | null>(null);
  // Fields the requester has typed in or chosen - a suggestion never overwrites these.
  const [touched, setTouched] = useState<Record<SuggestedField, boolean>>(UNTOUCHED);
  const touchedRef = useRef(touched);
  touchedRef.current = touched;

  useEffect(() => {
    apiClient.get<PatternCatalogEntry[]>('/projects/pattern-catalog').then((res) => setPatterns(res.data));
  }, []);

  const applySuggestion = (s: UseCaseSuggestion, keep: Record<SuggestedField, boolean>) => {
    if (!keep.businessUseCase) setBusinessUseCase(s.businessUseCase);
    if (!keep.industry) setIndustry(s.industry ?? '');
    if (!keep.patternId) setPatternId(s.patternId ?? '');
    if (!keep.customerMode) setCustomerMode(s.customerMode ?? 'new');
  };

  // Recommend inputs from the application name as it is typed.
  useEffect(() => {
    const trimmed = name.trim();
    if (trimmed.length < SUGGEST_MIN_LENGTH) {
      setSuggestion(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      apiClient
        .get<UseCaseSuggestion>('/projects/use-case-suggestion', { params: { name: trimmed } })
        .then((res) => {
          if (cancelled) return;
          setSuggestion(res.data);
          applySuggestion(res.data, touchedRef.current);
        })
        .catch(() => {
          // A suggestion is a convenience - the form works the same without one.
          if (!cancelled) setSuggestion(null);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [name]);

  const touch = (field: SuggestedField) => setTouched((t) => (t[field] ? t : { ...t, [field]: true }));

  const differsFromSuggestion =
    !!suggestion &&
    (businessUseCase !== suggestion.businessUseCase ||
      industry !== (suggestion.industry ?? '') ||
      patternId !== (suggestion.patternId ?? '') ||
      customerMode !== (suggestion.customerMode ?? 'new'));

  const useSuggestion = () => {
    if (!suggestion) return;
    setTouched(UNTOUCHED);
    applySuggestion(suggestion, UNTOUCHED);
  };

  const suggestedLabel = (isSuggested: boolean) =>
    isSuggested ? (
      <span className="status-pill" style={{ marginLeft: 8 }} title="Recommended from the application name - edit freely">
        suggested
      </span>
    ) : null;

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
          {suggestion && (
            <div className="card" style={{ padding: 12, background: 'var(--surface-2)' }} aria-live="polite">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <strong style={{ fontSize: 13 }}>Recommended inputs</strong>
                <span className={`status-pill ${CONFIDENCE_PILL[suggestion.confidence]}`}>{suggestion.confidence} confidence</span>
              </div>
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0' }}>{suggestion.reason}</p>
              <div style={{ fontSize: 12 }}>
                Pattern: <strong>{suggestion.patternName ?? 'Start from scratch'}</strong>
                {suggestion.industry && (
                  <>
                    {' '}· Industry: <strong>{suggestion.industry}</strong>
                  </>
                )}
                {suggestion.customerMode === 'existing' && (
                  <>
                    {' '}· Customer type: <strong>Existing / Modernization</strong>
                  </>
                )}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Filled in below wherever you have not typed yet - every field stays editable.
                </span>
                {differsFromSuggestion && (
                  <button type="button" className="secondary-btn" onClick={useSuggestion}>
                    Use suggestion
                  </button>
                )}
              </div>
            </div>
          )}
          <div>
            <label>
              Business use case
              {suggestedLabel(!!suggestion && businessUseCase === suggestion.businessUseCase)}
            </label>
            <textarea
              rows={4}
              value={businessUseCase}
              onChange={(e) => {
                touch('businessUseCase');
                setBusinessUseCase(e.target.value);
              }}
            />
          </div>
          <div>
            <label>
              Industry
              {suggestedLabel(!!suggestion?.industry && industry === suggestion.industry)}
            </label>
            <input
              value={industry}
              onChange={(e) => {
                touch('industry');
                setIndustry(e.target.value);
              }}
            />
          </div>

          <div>
            <label>Customer type</label>
            <div className="platform-options">
              <label className={`platform-option ${customerMode === 'new' ? 'selected' : ''}`} style={{ display: 'block' }}>
                <input
                  type="radio"
                  name="customerMode"
                  checked={customerMode === 'new'}
                  onChange={() => {
                    touch('customerMode');
                    setCustomerMode('new');
                  }}
                  style={{ marginRight: 8 }}
                />
                <strong>New / Greenfield</strong>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>No existing vector/search deployment to account for.</div>
              </label>
              <label className={`platform-option ${customerMode === 'existing' ? 'selected' : ''}`} style={{ display: 'block' }}>
                <input
                  type="radio"
                  name="customerMode"
                  checked={customerMode === 'existing'}
                  onChange={() => {
                    touch('customerMode');
                    setCustomerMode('existing');
                  }}
                  style={{ marginRight: 8 }}
                />
                <strong>Existing / Modernization</strong>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Migrating or upgrading an existing deployment - capture the current database, vector/search
                  technology, and Kubernetes footprint in Phase 1 Discovery's "Existing technology" fields.
                </div>
              </label>
            </div>
          </div>

          <div>
            <label>AI Factory pattern (optional)</label>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 10px' }}>
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
                  onChange={() => {
                    touch('patternId');
                    setPatternId('');
                  }}
                  style={{ marginRight: 8 }}
                />
                <strong>Start from scratch</strong>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>No pattern - use the generic Discovery defaults.</div>
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
                    onChange={() => {
                      touch('patternId');
                      setPatternId(p.id);
                    }}
                    style={{ marginRight: 8 }}
                  />
                  <strong>{p.name}</strong>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
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
