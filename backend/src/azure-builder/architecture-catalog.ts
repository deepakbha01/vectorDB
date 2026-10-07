import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { AzureCatalog } from './architecture';

const REQUIRED_COMPONENTS = ['aoai', 'search', 'storage', 'keyvault', 'identity', 'cae', 'app', 'log-analytics', 'app-insights'];

/** Problems that would make the rules engine misbehave; an empty list means the catalog is usable. */
export function validateCatalog(c: Partial<AzureCatalog>): string[] {
  const problems: string[] = [];
  if (!c.rulesVersion) problems.push('rulesVersion is missing');
  const comps = c.patterns?.['rag-assistant']?.components ?? {};
  for (const id of REQUIRED_COMPONENTS) if (!comps[id]) problems.push(`rag-assistant component ${id} is missing`);
  if (!c.models?.chat || !c.rates?.models?.[c.models.chat]) problems.push('the chat model has no rate');
  if (!c.models?.embedding || !c.rates?.models?.[c.models.embedding]) problems.push('the embedding model has no rate');
  if (!c.searchTiers?.length) problems.push('searchTiers is empty');
  for (const t of c.searchTiers ?? []) if (c.rates?.searchUnitMonth?.[t.tier] == null) problems.push(`search tier ${t.tier} has no rate`);
  return problems;
}

let cached: { file: string; catalog: AzureCatalog } | null = null;

/** Reads config/azure-builder.yaml (or AZURE_BUILDER_CATALOG_PATH) once and checks it. */
export function loadAzureCatalog(file = process.env.AZURE_BUILDER_CATALOG_PATH ?? path.join(process.cwd(), 'config', 'azure-builder.yaml')): AzureCatalog {
  if (cached?.file === file) return cached.catalog;
  const catalog = yaml.load(fs.readFileSync(file, 'utf8')) as AzureCatalog;
  const problems = validateCatalog(catalog);
  if (problems.length) throw new Error(`Invalid Azure Builder catalog ${file}: ${problems.join('; ')}`);
  cached = { file, catalog };
  return catalog;
}
