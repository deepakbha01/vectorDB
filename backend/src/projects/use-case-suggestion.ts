import { CustomerMode } from './enums/customer-mode.enum';

/** A pattern as read from config/patterns.yaml - only the fields the suggestion uses. */
export interface SuggestablePattern {
  id: string;
  name: string;
  industry?: string;
  suggestion?: { keywords?: string[]; useCase?: string };
}

/** Input recommendation for the New Project form. Every field is a default the requester can change. */
export interface UseCaseSuggestion {
  businessUseCase: string;
  industry: string | null;
  patternId: string | null;
  patternName: string | null;
  /** Only set when the name says the project replaces something that exists; otherwise the form keeps its choice. */
  customerMode: CustomerMode | null;
  matchedKeywords: string[];
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/** Words in an application name that mean an existing deployment is being replaced or upgraded. */
const MODERNIZATION_KEYWORDS = ['migration', 'migrate', 'modernization', 'modernisation', 'modernize', 'modernise', 'legacy', 'upgrade', 'replatform', 're-platform', 'replacement'];

/** Keywords this short must match a whole word (optionally plural), so "log" does not match "logistics". */
const WHOLE_WORD_MAX_LENGTH = 4;

const GENERIC_USE_CASE =
  '{name} uses semantic (vector) search to find relevant information by meaning across the organization\'s data. ' +
  'Describe who uses it, what data it searches and the outcome it should deliver.';

const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9&-]+/g, ' ').trim();

/**
 * The name as written ("iot", "devops") plus with camel case split
 * ("PharmaAI" -> "pharma ai"), so a keyword matches either form.
 */
function normalize(name: string): string {
  const split = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return `${clean(name)} | ${clean(split)}`;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matches(normalizedName: string, keyword: string): boolean {
  const kw = escape(keyword.toLowerCase());
  const pattern = keyword.length <= WHOLE_WORD_MAX_LENGTH ? `(^|[^a-z0-9])${kw}s?($|[^a-z0-9])` : `(^|[^a-z0-9])${kw}`;
  return new RegExp(pattern).test(normalizedName);
}

function quoted(words: string[]): string {
  return words.map((w) => `"${w}"`).join(', ');
}

/**
 * Recommends New Project inputs from the application name: the pattern whose
 * keywords match most often (ties go to the longest, i.e. most specific,
 * matched keyword, then catalog order), its industry, and a business use case
 * written for this application. With no match it returns a generic use case
 * for the requester to complete.
 */
export function suggestUseCase(applicationName: string, patterns: SuggestablePattern[]): UseCaseSuggestion {
  const name = applicationName.trim().replace(/\s+/g, ' ');
  const normalized = normalize(name);

  const modernization = MODERNIZATION_KEYWORDS.filter((k) => matches(normalized, k));
  const customerMode = modernization.length > 0 ? CustomerMode.EXISTING : null;

  let best: { pattern: SuggestablePattern; matched: string[]; longest: number } | null = null;
  for (const pattern of patterns) {
    const matched = (pattern.suggestion?.keywords ?? []).filter((k) => matches(normalized, k));
    if (matched.length === 0) continue;
    const longest = Math.max(...matched.map((k) => k.length));
    if (!best || matched.length > best.matched.length || (matched.length === best.matched.length && longest > best.longest)) {
      best = { pattern, matched, longest };
    }
  }

  const modernizationNote = customerMode
    ? ` ${quoted(modernization)} ${modernization.length > 1 ? 'suggest' : 'suggests'} an existing deployment is being modernized.`
    : '';

  if (!best) {
    return {
      businessUseCase: GENERIC_USE_CASE.replace(/\{name\}/g, name),
      industry: null,
      patternId: null,
      patternName: null,
      customerMode,
      matchedKeywords: modernization,
      confidence: 'low',
      reason: `No pattern keyword was found in the application name, so this is a generic starting point to complete.${modernizationNote}`,
    };
  }

  const template = best.pattern.suggestion?.useCase ?? GENERIC_USE_CASE;
  return {
    businessUseCase: template.replace(/\{name\}/g, name),
    industry: best.pattern.industry ?? null,
    patternId: best.pattern.id,
    patternName: best.pattern.name,
    customerMode,
    matchedKeywords: [...best.matched, ...modernization],
    confidence: best.matched.length >= 2 ? 'high' : 'medium',
    reason: `${quoted(best.matched)} in the application name matches the ${best.pattern.name} pattern.${modernizationNote}`,
  };
}
