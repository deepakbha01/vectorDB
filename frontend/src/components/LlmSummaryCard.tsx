import { useState } from 'react';
import { useFeatures } from '../api/features';
import { extractErrorMessage } from '../api/client';
import { generateLlmSummary, LlmSummary, LlmSummaryAudience, LlmSummarySubject } from '../api/llmSummary';

const SECTION_TITLE = /^(Recommendation|Why|Risks and conditions|Next steps):\s*(.*)$/;

/** Renders the model's plain-text answer: section-title lines, "- " bullets, paragraphs. */
function SummaryText({ text }: { text: string }) {
  const blocks: JSX.Element[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) blocks.push(<ul key={`ul${blocks.length}`} style={{ margin: '4px 0 8px', paddingLeft: 18 }}>{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>);
    bullets = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-*•]\s+/.test(line)) {
      bullets.push(line.replace(/^[-*•]\s+/, ''));
      continue;
    }
    flush();
    const title = SECTION_TITLE.exec(line.replace(/\*\*/g, ''));
    if (title) {
      blocks.push(<div key={`h${blocks.length}`} style={{ fontWeight: 600, marginTop: blocks.length ? 10 : 0 }}>{title[1]}</div>);
      if (title[2]) blocks.push(<p key={`p${blocks.length}`} style={{ margin: '2px 0 6px' }}>{title[2]}</p>);
    } else {
      blocks.push(<p key={`p${blocks.length}`} style={{ margin: '2px 0 6px' }}>{line}</p>);
    }
  }
  flush();
  return <div style={{ fontSize: 13, lineHeight: 1.5 }}>{blocks}</div>;
}

/**
 * Optional AI-written narrative of the saved rule-based result. Shown only
 * when the server has LLM summaries enabled, and only runs when asked - teams
 * that don't want it simply never press the button.
 */
export function LlmSummaryCard({ projectId, subject }: { projectId: string; subject: LlmSummarySubject }) {
  const features = useFeatures();
  const [audience, setAudience] = useState<LlmSummaryAudience>('executive');
  const [summary, setSummary] = useState<LlmSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!features.llmSummary) return null;

  const generate = async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      setSummary(await generateLlmSummary(projectId, subject, audience));
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not generate the AI summary.'));
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(`${summary.text}\n\n(${summary.disclaimer})`);
      setCopied(true);
    } catch {
      setError('Could not copy to the clipboard.');
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16, borderLeft: '4px solid var(--border)' }} aria-label="AI summary">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <div className="card-title" style={{ marginBottom: 2 }}>AI summary <span className="status-pill">optional</span></div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            An LLM writes a narrative from the saved rule-based result. It does not change the result.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={audience} onChange={(e) => setAudience(e.target.value as LlmSummaryAudience)} disabled={loading} aria-label="Summary audience">
            <option value="executive">For executives</option>
            <option value="technical">For architects</option>
          </select>
          <button className="primary-btn" type="button" onClick={generate} disabled={loading}>
            {loading ? 'Writing...' : summary ? 'Regenerate' : 'Generate AI summary'}
          </button>
        </div>
      </div>
      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      {summary && (
        <div style={{ marginTop: 12 }}>
          <SummaryText text={summary.text} />
          {summary.truncated && <div style={{ fontSize: 12, color: 'var(--warning)' }}>The answer hit the output limit and may be cut short.</div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
            <span>
              {summary.provider} · {summary.model} · {new Date(summary.generatedAt).toLocaleString()}
              {summary.source.version !== null && ` · from v${summary.source.version}`}
              {summary.usage && ` · ${summary.usage.inputTokens + summary.usage.outputTokens} tokens`}
            </span>
            <button type="button" onClick={copy} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--primary-text)', textDecoration: 'underline', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              {copied ? 'Copied' : 'Copy text'}
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, fontStyle: 'italic' }}>{summary.disclaimer}</div>
        </div>
      )}
    </div>
  );
}
