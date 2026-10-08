/**
 * Azure AI Factory Builder - values the IaC generator will not invent (Phase 4),
 * supplied per environment so the approved bundle (Phase 5) is the one that
 * deploys: the spoke address range, the shared DNS zone resource group and the
 * container image. Pure - no I/O.
 */
import type { TargetEnv } from './iac-bundle';

export interface EnvInputs {
  vnetAddressPrefix?: string;
  privateDnsZoneResourceGroupId?: string;
  containerImage?: string;
}

export type InputName = keyof EnvInputs;

/** What a design needs before it can be deployed (containerImage has a working placeholder, so it is never blocking). */
export function neededInputs(design: { private: boolean; reusesDnsZones: boolean }): InputName[] {
  return [...(design.private ? (['vnetAddressPrefix'] as InputName[]) : []), ...(design.private && design.reusesDnsZones ? (['privateDnsZoneResourceGroupId'] as InputName[]) : [])];
}

const RG_ID = /^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[\w.()-]{1,90}$/i;
const IMAGE = /^[a-z0-9]+([.-][a-z0-9]+)*(:\d{1,5})?(\/[a-z0-9]+([._-][a-z0-9]+)*)+(:[\w][\w.-]{0,127}|@sha256:[a-f0-9]{64})$/;

export interface Cidr { text: string; start: number; end: number; prefix: number }

/** Parses an IPv4 CIDR ("10.20.0.0/22"); null when malformed or not aligned to its prefix. */
export function parseCidr(text: string): Cidr | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return null;
  const ip = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
  const size = 2 ** (32 - prefix);
  if (ip % size !== 0) return null;
  return { text: text.trim(), start: ip, end: ip + size - 1, prefix };
}

export const overlaps = (a: Cidr, b: Cidr) => a.start <= b.end && b.start <= a.end;

/**
 * Checks the inputs for every environment: formats, a spoke range large enough for
 * the subnets the template carves (/23 apps + /27s), private (RFC 1918) addresses,
 * and no overlap between environments or with VNets found by Discover.
 */
export function validateEnvInputs(inputs: Partial<Record<TargetEnv, EnvInputs>>, existingVnets: Array<{ name: string; addressPrefixes: string[] }>): string[] {
  const problems: string[] = [];
  const ranges: Array<{ env: string; cidr: Cidr }> = [];
  const rfc1918 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map((c) => parseCidr(c)!);
  for (const [env, i] of Object.entries(inputs) as Array<[TargetEnv, EnvInputs]>) {
    if (!i) continue;
    if (i.vnetAddressPrefix) {
      const c = parseCidr(i.vnetAddressPrefix);
      if (!c) problems.push(`${env}: "${i.vnetAddressPrefix}" is not a valid IPv4 range like 10.20.0.0/22 (the address must be the first of its block).`);
      else if (c.prefix > 22) problems.push(`${env}: ${c.text} is too small - the template needs at least a /22.`);
      else if (!rfc1918.some((r) => c.start >= r.start && c.end <= r.end)) problems.push(`${env}: ${c.text} is not a private (RFC 1918) range.`);
      else ranges.push({ env, cidr: c });
    }
    if (i.privateDnsZoneResourceGroupId && !RG_ID.test(i.privateDnsZoneResourceGroupId.trim())) {
      problems.push(`${env}: the DNS zone resource group must be a resource ID like /subscriptions/<guid>/resourceGroups/<name>.`);
    }
    if (i.containerImage && !IMAGE.test(i.containerImage.trim())) problems.push(`${env}: "${i.containerImage}" is not an image reference like myregistry.azurecr.io/assistant-api:1.0.0.`);
  }
  for (let a = 0; a < ranges.length; a++) {
    for (let b = a + 1; b < ranges.length; b++) {
      if (overlaps(ranges[a].cidr, ranges[b].cidr)) problems.push(`${ranges[a].env} (${ranges[a].cidr.text}) and ${ranges[b].env} (${ranges[b].cidr.text}) overlap - each environment needs its own range.`);
    }
    for (const v of existingVnets) {
      for (const p of v.addressPrefixes) {
        const c = parseCidr(p);
        if (c && overlaps(ranges[a].cidr, c)) problems.push(`${ranges[a].env} (${ranges[a].cidr.text}) overlaps ${v.name} (${p}) found by Discover - peering would fail.`);
      }
    }
  }
  return problems;
}

/** Trims values and drops blanks, so an empty field means "not provided". */
export function normaliseEnvInputs(inputs: Partial<Record<TargetEnv, EnvInputs>> | undefined): Partial<Record<TargetEnv, EnvInputs>> {
  const out: Partial<Record<TargetEnv, EnvInputs>> = {};
  for (const [env, i] of Object.entries(inputs ?? {}) as Array<[TargetEnv, EnvInputs]>) {
    const clean: EnvInputs = {};
    for (const k of ['vnetAddressPrefix', 'privateDnsZoneResourceGroupId', 'containerImage'] as InputName[]) {
      const v = i?.[k]?.trim();
      if (v) clean[k] = v;
    }
    if (Object.keys(clean).length) out[env] = clean;
  }
  return out;
}
