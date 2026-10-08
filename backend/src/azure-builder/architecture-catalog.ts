import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { AzureCatalog } from './architecture';
import { IacCatalog } from './iac-bundle';

export type FullCatalog = AzureCatalog & { iac: IacCatalog };

const REQUIRED_COMPONENTS = ['aoai', 'search', 'storage', 'keyvault', 'identity', 'cae', 'app', 'log-analytics', 'app-insights'];
const REQUIRED_ROLES = ['cognitiveServicesOpenAiUser', 'searchIndexDataContributor', 'searchServiceContributor', 'storageBlobDataContributor', 'keyVaultSecretsUser', 'monitoringMetricsPublisher', 'cosmosDataContributor'];

/** Problems that would make the rules engine or the IaC generator misbehave; an empty list means the catalog is usable. */
export function validateCatalog(c: Partial<FullCatalog>): string[] {
  const problems: string[] = [];
  if (!c.rulesVersion) problems.push('rulesVersion is missing');
  const comps = c.patterns?.['rag-assistant']?.components ?? {};
  for (const id of REQUIRED_COMPONENTS) if (!comps[id]) problems.push(`rag-assistant component ${id} is missing`);
  if (!c.models?.chat || !c.rates?.models?.[c.models.chat]) problems.push('the chat model has no rate');
  if (!c.models?.embedding || !c.rates?.models?.[c.models.embedding]) problems.push('the embedding model has no rate');
  if (!c.searchTiers?.length) problems.push('searchTiers is empty');
  for (const t of c.searchTiers ?? []) if (c.rates?.searchUnitMonth?.[t.tier] == null) problems.push(`search tier ${t.tier} has no rate`);
  // Phase 4: every AVM module the pattern uses is pinned (spec 11.1); local wrapper modules are not.
  if (!c.iac) problems.push('iac section is missing');
  else {
    for (const [id, d] of Object.entries(comps)) {
      if (d.module.startsWith('avm/') && !/^\d+\.\d+\.\d+$/.test(c.iac.avm?.[d.module] ?? '')) problems.push(`component ${id} module ${d.module} has no pinned version`);
    }
    for (const m of [c.models?.chat, c.models?.embedding]) if (m && !c.iac.modelVersions?.[m]) problems.push(`model ${m} has no pinned version`);
    for (const r of REQUIRED_ROLES) if (!c.iac.roles?.[r]) problems.push(`role ${r} is missing`);
  }
  return problems;
}

let cached: { file: string; catalog: FullCatalog } | null = null;

/** Reads config/azure-builder.yaml (or AZURE_BUILDER_CATALOG_PATH) once and checks it. */
export function loadAzureCatalog(file = process.env.AZURE_BUILDER_CATALOG_PATH ?? path.join(process.cwd(), 'config', 'azure-builder.yaml')): FullCatalog {
  if (cached?.file === file) return cached.catalog;
  const catalog = yaml.load(fs.readFileSync(file, 'utf8')) as FullCatalog;
  const problems = validateCatalog(catalog);
  if (problems.length) throw new Error(`Invalid Azure Builder catalog ${file}: ${problems.join('; ')}`);
  cached = { file, catalog };
  return catalog;
}
