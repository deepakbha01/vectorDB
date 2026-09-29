import { Eligibility, ScoreContribution } from '../api/aiFactory';

/** What every AI Factory options table knows about one option (eligibility first, then scoring). */
export interface ExplainedOption {
  eligibility: Eligibility;
  failures: string[];
  conditions: string[];
  notes: string[];
  /** Mandatory requirements the option meets (absent on results saved before it was added). */
  passed?: string[];
  /** Each criterion's value x weight, largest first (absent on older results). */
  scoreBreakdown?: ScoreContribution[];
}

const CRITERION_LABEL: Record<string, string> = {
  operationalSimplicity: 'Operational simplicity',
  featureFit: 'Feature fit',
  contextHeadroom: 'Context headroom',
  deploymentFlexibility: 'Deployment flexibility',
  dataControl: 'Data control',
  coLocation: 'Co-location',
};

/** "operationalSimplicity" -> "Operational simplicity" for criteria without an explicit label. */
function criterionLabel(c: string): string {
  if (CRITERION_LABEL[c]) return CRITERION_LABEL[c];
  const words = c.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words[0].toUpperCase() + words.slice(1);
}

/**
 * Why the option got its eligibility: the mandatory requirements it fails (not eligible), the
 * conditions it must meet (conditional), or the mandatory requirements it meets (eligible).
 * Notes follow, muted.
 */
export function EligibilityWhy({ option: c }: { option: ExplainedOption }) {
  const passed = c.passed ?? [];
  const reasons =
    c.eligibility === 'not_eligible'
      ? c.failures
      : c.eligibility === 'conditional'
        ? [...c.conditions, passed.length ? `Meets all ${passed.length} mandatory requirement(s).` : 'Meets every mandatory requirement.']
        : passed.length
          ? passed
          : ['Meets every mandatory requirement, with no conditions.'];
  return (
    <div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
        {reasons.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      {c.notes.length > 0 && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{c.notes.join(' ')}</div>}
    </div>
  );
}

/** Each criterion's share of the score (value x weight), largest first. Older saved results have no breakdown. */
export function ScoreWhy({ option: c }: { option: ExplainedOption }) {
  if (!c.scoreBreakdown?.length) return <span style={{ color: 'var(--muted)', fontSize: 12 }}>Re-run to see the breakdown</span>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
      {c.scoreBreakdown.map((b) => (
        <li key={b.criterion}>
          {criterionLabel(b.criterion)}: {b.value.toFixed(2)} × {Math.round(b.weight * 100)}% = {b.contribution.toFixed(3)}
        </li>
      ))}
    </ul>
  );
}
