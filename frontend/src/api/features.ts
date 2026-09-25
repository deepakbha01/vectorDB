import { useEffect, useState } from 'react';
import { apiClient } from './client';

export interface FeatureFlags {
  aiFactory: boolean;
  /** Token Observability (Wave 12) - on only together with aiFactory. */
  tokenObservability: boolean;
}

const OFF: FeatureFlags = { aiFactory: false, tokenObservability: false };
let cached: Promise<FeatureFlags> | null = null;

/** Fetched once per page load; any failure falls back to every flag off (the existing workflow). */
function loadFeatures(): Promise<FeatureFlags> {
  cached ??= apiClient
    .get<FeatureFlags>('/features')
    .then((res) => ({ ...OFF, ...res.data }))
    .catch(() => OFF);
  return cached;
}

export function useFeatures(): FeatureFlags {
  const [flags, setFlags] = useState<FeatureFlags>(OFF);
  useEffect(() => {
    let active = true;
    loadFeatures().then((f) => active && setFlags(f));
    return () => {
      active = false;
    };
  }, []);
  return flags;
}
