import { FitRating, PlainLanguageScorecardRow } from '../api/client';

const RATING_META: Record<FitRating, { emoji: string; className: string }> = {
  great: { emoji: '✅', className: 'validated' },
  ok: { emoji: '⚠️', className: 'warning' },
  weak: { emoji: '❌', className: 'danger' },
};

interface ExecutiveSummaryCardProps {
  /** Optional overall-status badge, e.g. Phase 1's "Excellent Fit" verdict. Omit when there's no single score to summarize. */
  badge?: { text: string; tone: 'validated' | 'warning' | 'danger' };
  headline: string;
  scorecard: PlainLanguageScorecardRow[];
  /** A labeled callout below the scorecard, e.g. "Cost & Operational Effort". */
  note?: { label: string; value: string };
  considerationsTitle?: string;
  considerations: string[];
  bottomLine: string;
}

/** Shared executive-summary presentation used by every phase's plain-language report card. */
export function ExecutiveSummaryCard({
  badge,
  headline,
  scorecard,
  note,
  considerationsTitle = 'Key Considerations',
  considerations,
  bottomLine,
}: ExecutiveSummaryCardProps) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="metric-label" style={{ marginBottom: 8 }}>
        Executive Summary
      </div>
      {badge && (
        <span className={`status-pill ${badge.tone}`} style={{ marginBottom: 10, display: 'inline-block' }}>
          {badge.text}
        </span>
      )}
      <p style={{ fontSize: 15, lineHeight: 1.5, margin: '4px 0 16px' }}>{headline}</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {scorecard.map((row) => (
          <div key={row.label} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13 }}>
            <span aria-hidden style={{ fontSize: 16, lineHeight: '20px' }}>
              {RATING_META[row.rating].emoji}
            </span>
            <div>
              <strong>{row.label}</strong>
              <div style={{ color: 'var(--muted)' }}>{row.explanation}</div>
            </div>
          </div>
        ))}
      </div>

      {note && (
        <p style={{ fontSize: 13, marginBottom: 12 }}>
          <strong>{note.label}: </strong>
          {note.value}
        </p>
      )}

      {considerations.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div className="metric-label" style={{ marginBottom: 6 }}>
            {considerationsTitle}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {considerations.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{bottomLine}</p>
    </div>
  );
}
