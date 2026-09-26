import { useEffect, useState } from 'react';
import { EstimateOverrides, InputProvenance, ResolvedInput } from '../../api/tokenObservability';

/** Provenance labels (validation spec §1, §17) - every value says where it came from. */
const PROVENANCE: Record<InputProvenance, { label: string; color: string; bg: string }> = {
  user_override: { label: 'User Override', color: 'var(--text)', bg: 'var(--warning-soft)' },
  calculated: { label: 'Calculated', color: 'var(--text)', bg: 'var(--primary-soft)' },
  pattern_default: { label: 'Pattern Default', color: 'var(--text)', bg: 'var(--success-soft)' },
  not_configured: { label: 'Not configured', color: 'var(--muted)', bg: 'var(--border)' },
};

/** Derived, shown for context only - not an override field. */
const READ_ONLY = new Set(['toolCallsPerRequest']);

const LLM_USAGE_OPTIONS = [
  ['required', 'Required - every request'],
  ['optional', 'Optional - a share of requests'],
  ['none', 'No LLM / vector-only'],
] as const;

export function ProvenanceBadge({ p }: { p: InputProvenance }) {
  const s = PROVENANCE[p];
  return <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>{s.label}</span>;
}

/**
 * Estimation inputs with provenance. Editing a value makes it a User Override;
 * Reset hands it back to the calculated / pattern value. Overrides are saved
 * with the estimate and reused - a later pattern never replaces them.
 */
export function EstimateInputsPanel({
  inputs,
  saved,
  busy,
  canSave,
  onPreview,
  onSave,
}: {
  inputs: ResolvedInput[];
  saved: EstimateOverrides;
  busy: boolean;
  canSave: boolean;
  onPreview: (o: EstimateOverrides) => void;
  onSave: (o: EstimateOverrides) => void;
}) {
  const [draft, setDraft] = useState<EstimateOverrides>(saved);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const set = (key: string, raw: string) => {
    const next = { ...draft };
    if (raw === '') delete next[key];
    else next[key] = key === 'llmUsage' ? raw : Number(raw);
    setDraft(next);
  };
  const reset = (key: string) => {
    const next = { ...draft };
    delete next[key];
    setDraft(next);
  };

  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <div className="metric-label">Estimation inputs - where every value comes from</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 8px' }}>
        Values are taken from your overrides first, then the upstream phases (Calculated), then the project's pattern. Anything nothing supplies stays <em>Not configured</em> - it is never guessed.
        Utilization is never assumed to be 100%.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 12 }}>
            <th style={{ padding: '4px 8px' }}>Input</th>
            <th style={{ padding: '4px 8px' }}>Value in use</th>
            <th style={{ padding: '4px 8px' }}>Source</th>
            <th style={{ padding: '4px 8px' }}>Override</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {inputs.map((i) => {
            const overridden = draft[i.key] !== undefined;
            const shown = i.value === null ? '—' : typeof i.value === 'number' ? `${i.value.toLocaleString()}${i.unit ? ` ${i.unit}` : ''}` : (LLM_USAGE_OPTIONS.find(([v]) => v === i.value)?.[1] ?? i.value);
            return (
              <tr key={i.key} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '4px 8px' }}>{i.label}</td>
                <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>{shown}</td>
                <td style={{ padding: '4px 8px' }}>
                  <ProvenanceBadge p={i.provenance} /> <span style={{ fontSize: 12, color: 'var(--muted)' }}>{i.provenance === 'not_configured' ? '' : i.source}</span>
                </td>
                <td style={{ padding: '4px 8px' }}>
                  {READ_ONLY.has(i.key) ? (
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>derived</span>
                  ) : i.key === 'llmUsage' ? (
                    <select aria-label={i.label} value={(draft.llmUsage as string) ?? ''} onChange={(e) => set('llmUsage', e.target.value)} style={{ fontSize: 13 }}>
                      <option value="">(not overridden)</option>
                      {LLM_USAGE_OPTIONS.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={i.label}
                      type="number"
                      min={0}
                      step="any"
                      value={overridden ? String(draft[i.key]) : ''}
                      placeholder={i.value === null ? 'Not configured' : String(i.value)}
                      onChange={(e) => set(i.key, e.target.value)}
                      style={{ width: 120, fontSize: 13 }}
                    />
                  )}
                </td>
                <td style={{ padding: '4px 8px' }}>
                  {overridden && (
                    <button type="button" onClick={() => reset(i.key)} style={{ background: 'none', border: 'none', color: 'var(--primary-text)', cursor: 'pointer', fontSize: 12 }}>
                      Reset
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 12, marginTop: 10, alignItems: 'center' }}>
        <button type="button" className="secondary-btn" disabled={busy} onClick={() => onPreview(draft)}>
          Preview with these inputs
        </button>
        {canSave && (
          <button type="button" className="primary-btn" disabled={busy} onClick={() => onSave(draft)}>
            Save estimate with these inputs
          </button>
        )}
        {dirty && <span style={{ fontSize: 12, color: 'var(--warning)' }}>Unsaved changes</span>}
      </div>
    </div>
  );
}
