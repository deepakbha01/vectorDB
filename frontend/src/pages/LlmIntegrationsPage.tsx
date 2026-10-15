import { FormEvent, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { extractErrorMessage } from '../api/client';
import { useFeatures } from '../api/features';
import { useAuth } from '../auth/AuthContext';
import { TopBar } from '../components/TopBar';
import {
  createLlmConnection,
  deleteLlmConnection,
  listLlmConnections,
  listLlmProviders,
  LlmConnection,
  LlmConnectionInput,
  LlmProviderOption,
  testLlmConnection,
  updateLlmConnection,
} from '../api/llmSummary';

interface FormState {
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiVersion: string;
  apiKey: string;
  isDefault: boolean;
}

const EMPTY: FormState = { name: '', provider: 'anthropic', model: '', baseUrl: '', apiVersion: '', apiKey: '', isDefault: false };

const linkBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--primary-text)', textDecoration: 'underline', cursor: 'pointer', fontSize: 13, fontWeight: 600 } as const;

/**
 * Admin page for the LLM integrations behind the optional AI summaries. Keys
 * are write-only: the page only ever learns whether one is stored.
 */
export function LlmIntegrationsPage() {
  const { user } = useAuth();
  const features = useFeatures();
  const [providers, setProviders] = useState<LlmProviderOption[]>([]);
  const [connections, setConnections] = useState<LlmConnection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LlmConnection | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowNote, setRowNote] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const isAdmin = user?.role === 'admin';

  const reload = () =>
    listLlmConnections()
      .then(setConnections)
      .catch((err) => setLoadError(extractErrorMessage(err, 'Could not load the LLM integrations.')));

  useEffect(() => {
    if (!isAdmin || !features.llmSummary) return;
    listLlmProviders().then(setProviders).catch((err) => setLoadError(extractErrorMessage(err, 'Could not load the provider list.')));
    reload();
  }, [isAdmin, features.llmSummary]);

  if (!isAdmin) return <Navigate to="/dashboard" replace />;

  const provider = providers.find((p) => p.id === form.provider);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const startNew = () => {
    setEditing('new');
    setForm({ ...EMPTY, isDefault: !connections?.some((c) => !c.fromServerSettings) });
    setFormError(null);
  };

  const startEdit = (c: LlmConnection) => {
    setEditing(c);
    setForm({ name: c.name, provider: c.provider, model: c.model, baseUrl: c.baseUrl ?? '', apiVersion: c.apiVersion ?? '', apiKey: '', isDefault: c.isDefault });
    setFormError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const body: LlmConnectionInput = { name: form.name, provider: form.provider, model: form.model, baseUrl: form.baseUrl, apiVersion: form.apiVersion, isDefault: form.isDefault };
    // A blank key field on edit keeps the stored key.
    if (form.apiKey || editing === 'new') body.apiKey = form.apiKey;
    try {
      if (editing === 'new') await createLlmConnection(body);
      else if (editing) await updateLlmConnection(editing.id, body);
      setEditing(null);
      await reload();
    } catch (err) {
      setFormError(extractErrorMessage(err, 'Could not save the integration.'));
    } finally {
      setSaving(false);
    }
  };

  const run = async (id: string, action: () => Promise<{ ok: boolean; text: string } | void>) => {
    setBusyId(id);
    setRowNote((n) => ({ ...n, [id]: { ok: true, text: '' } }));
    try {
      const note = await action();
      if (note) setRowNote((n) => ({ ...n, [id]: note }));
    } catch (err) {
      setRowNote((n) => ({ ...n, [id]: { ok: false, text: extractErrorMessage(err, 'That did not work.') } }));
    } finally {
      setBusyId(null);
    }
  };

  const test = (c: LlmConnection) =>
    run(c.id, async () => {
      const r = await testLlmConnection(c.id);
      return { ok: true, text: `Working - ${r.model} answered in ${(r.latencyMs / 1000).toFixed(1)} s: "${r.reply}"` };
    });

  const makeDefault = (c: LlmConnection) => run(c.id, async () => { await updateLlmConnection(c.id, { isDefault: true }); await reload(); });

  const remove = (c: LlmConnection) =>
    run(c.id, async () => {
      await deleteLlmConnection(c.id);
      setConfirmDelete(null);
      await reload();
    });

  return (
    <div className="main-content">
      <TopBar title="LLM integrations" />

      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, maxWidth: 900 }}>
        The LLMs that can write the optional <strong>AI summaries</strong> on the Vector DB Selection, Inference Assessment, Final
        Recommendation and Reports pages. Add as many as you like; the default is pre-selected on the summary card and people can pick
        another. Assessments never use an LLM - only the summaries do. API keys are stored encrypted and are never shown again.
      </p>

      {!features.llmSummary && (
        <div className="card" style={{ maxWidth: 900, color: 'var(--warning)' }}>
          AI summaries are switched off on this server. Set <code>LLM_SUMMARY_ENABLED=true</code> in <code>backend/.env</code> and restart the backend.
        </div>
      )}
      {loadError && <p className="error-text">{loadError}</p>}

      {features.llmSummary && connections && (
        <div className="card" style={{ overflowX: 'auto', maxWidth: 1100, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div className="card-title" style={{ margin: 0 }}>Integrations</div>
            <button className="primary-btn" type="button" onClick={startNew}>Add integration</button>
          </div>
          {connections.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>None yet. Add one to start generating AI summaries.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '8px 6px' }}>Name</th>
                  <th style={{ padding: '8px 6px' }}>Provider</th>
                  <th style={{ padding: '8px 6px' }}>Model</th>
                  <th style={{ padding: '8px 6px' }}>API key</th>
                  <th style={{ padding: '8px 6px' }}>Status</th>
                  <th style={{ padding: '8px 6px' }} />
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--border)', verticalAlign: 'top' }}>
                    <td style={{ padding: '8px 6px' }}>
                      <strong>{c.name}</strong> {c.isDefault && <span className="status-pill validated">default</span>}
                      {c.baseUrl && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{c.baseUrl}</div>}
                      {rowNote[c.id]?.text && <div style={{ fontSize: 12, marginTop: 4, color: rowNote[c.id].ok ? 'var(--success, inherit)' : 'var(--danger)' }}>{rowNote[c.id].text}</div>}
                    </td>
                    <td style={{ padding: '8px 6px' }}>{c.providerLabel}</td>
                    <td style={{ padding: '8px 6px' }}><code>{c.model}</code></td>
                    <td style={{ padding: '8px 6px' }}>{c.hasApiKey ? 'Saved' : 'None'}</td>
                    <td style={{ padding: '8px 6px' }}>
                      {c.ready ? <span className="status-pill validated">ready</span> : <span className="status-pill warning">incomplete</span>}
                    </td>
                    <td style={{ padding: '8px 6px', whiteSpace: 'nowrap' }}>
                      {c.fromServerSettings ? (
                        <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>
                          <button type="button" style={linkBtn} onClick={() => test(c)} disabled={busyId === c.id}>{busyId === c.id ? 'Testing...' : 'Test'}</button>
                          <span style={{ fontSize: 12, color: 'var(--muted)' }}>from backend/.env</span>
                        </span>
                      ) : confirmDelete === c.id ? (
                        <span style={{ display: 'inline-flex', gap: 12 }}>
                          <button type="button" style={{ ...linkBtn, color: 'var(--danger)' }} onClick={() => remove(c)} disabled={busyId === c.id}>Yes, remove</button>
                          <button type="button" style={linkBtn} onClick={() => setConfirmDelete(null)}>Keep</button>
                        </span>
                      ) : (
                        <span style={{ display: 'inline-flex', gap: 12 }}>
                          <button type="button" style={linkBtn} onClick={() => test(c)} disabled={busyId === c.id || !c.ready}>{busyId === c.id ? 'Testing...' : 'Test'}</button>
                          <button type="button" style={linkBtn} onClick={() => startEdit(c)}>Edit</button>
                          {!c.isDefault && <button type="button" style={linkBtn} onClick={() => makeDefault(c)} disabled={busyId === c.id}>Make default</button>}
                          <button type="button" style={linkBtn} onClick={() => setConfirmDelete(c.id)}>Remove</button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 0' }}>Test sends a one-line prompt to the provider, which costs a few tokens.</p>
        </div>
      )}

      {editing && (
        <form className="card" style={{ maxWidth: 700 }} onSubmit={submit}>
          <div className="card-title">{editing === 'new' ? 'Add integration' : `Edit ${editing.name}`}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '10px 12px', alignItems: 'center', fontSize: 13 }}>
            <label htmlFor="llm-name">Name</label>
            <input id="llm-name" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Claude for the pharma team" required maxLength={80} />

            <label htmlFor="llm-provider">Provider</label>
            <select id="llm-provider" value={form.provider} onChange={(e) => set('provider', e.target.value)}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>

            <label htmlFor="llm-model">{form.provider === 'azure-openai' ? 'Deployment name' : 'Model'}</label>
            <input id="llm-model" value={form.model} onChange={(e) => set('model', e.target.value)} placeholder={provider?.exampleModel} required maxLength={200} />

            <label htmlFor="llm-key">API key</label>
            <div>
              <input id="llm-key" type="password" autoComplete="new-password" value={form.apiKey} onChange={(e) => set('apiKey', e.target.value)} style={{ width: '100%' }}
                placeholder={editing !== 'new' && editing.hasApiKey ? 'Saved - leave blank to keep it' : provider?.keyOptional ? 'Optional for local servers' : 'Paste the key'} />
              {editing !== 'new' && editing.hasApiKey && (
                <button type="button" style={{ ...linkBtn, fontSize: 12, marginTop: 4 }} onClick={() => updateLlmConnection(editing.id, { apiKey: '' }).then((c) => { setEditing(c); return reload(); })}>
                  Remove the saved key
                </button>
              )}
            </div>

            <label htmlFor="llm-url">Base URL{provider?.baseUrlRequired ? '' : ' (optional)'}</label>
            <input id="llm-url" value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} required={provider?.baseUrlRequired} maxLength={500}
              placeholder={form.provider === 'azure-openai' ? 'https://<resource>.openai.azure.com' : provider?.defaultBaseUrl ?? 'https://your-server/v1'} />

            {provider?.apiVersionUsed && (
              <>
                <label htmlFor="llm-version">API version</label>
                <input id="llm-version" value={form.apiVersion} onChange={(e) => set('apiVersion', e.target.value)} placeholder="2024-10-21" maxLength={40} />
              </>
            )}

            <span />
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={form.isDefault} onChange={(e) => set('isDefault', e.target.checked)} /> Use as the default
            </label>
          </div>
          {formError && <div className="error-text" style={{ marginTop: 10 }}>{formError}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="primary-btn" type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
            <button type="button" style={linkBtn} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
