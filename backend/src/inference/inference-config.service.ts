import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { GpuSpec, ManagedApiTier, ModelSpec, PrecisionSpec, RackSystemSpec } from './inference.types';

/**
 * Loads the Inference Assessment catalogue (config/inference.yaml).
 *
 * Kept separate from PlatformConfigService on purpose so the inference track
 * cannot change what the vector-database engines load or score - the same
 * configuration-driven rule applies (no hard-coded GPU specs, prices, or
 * model architectures in the engine).
 */
@Injectable()
export class InferenceConfigService implements OnModuleInit {
  private catalogue: Record<string, any> = {};

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const path = this.config.get<string>('INFERENCE_CONFIG_PATH') ?? './config/inference.yaml';
    this.catalogue = (yaml.load(fs.readFileSync(path, 'utf8')) as Record<string, any>) ?? {};
  }

  /** Test seam - lets specs inject a catalogue without touching disk. */
  setCatalogue(catalogue: Record<string, any>) {
    this.catalogue = catalogue;
  }

  getRulesVersion(): string {
    return this.catalogue.rulesVersion ?? 'unknown';
  }

  getGpus(): GpuSpec[] {
    return this.catalogue.gpus ?? [];
  }

  getSystems(): RackSystemSpec[] {
    return this.catalogue.systems ?? [];
  }

  /** The rack-scale system a GPU is only sold in, if any. */
  systemForGpu(gpuId: string): RackSystemSpec | null {
    return this.getSystems().find((s) => s.gpuId === gpuId) ?? null;
  }

  getModels(): ModelSpec[] {
    return this.catalogue.models ?? [];
  }

  getPrecisions(): PrecisionSpec[] {
    return this.catalogue.precisions ?? [];
  }

  getAutoPrecisions(): string[] {
    return this.catalogue.autoPrecisions ?? ['fp16'];
  }

  getManagedApiTiers(): ManagedApiTier[] {
    return this.catalogue.managedApiTiers ?? [];
  }

  getSizing(): Record<string, any> {
    return this.catalogue.sizing ?? {};
  }

  getPricing(): Record<string, any> {
    return this.catalogue.pricing ?? {};
  }

  getForecastHorizons(): number[] {
    return this.catalogue.forecast?.horizonsMonths ?? [6, 12, 24];
  }

  getBreakEvenScan(): { minScale: number; maxScale: number; points: number } {
    return { minScale: 0.01, maxScale: 100, points: 61, ...(this.catalogue.breakEven ?? {}) };
  }

  /** Everything the UI needs to build the intake form, in one call. */
  getCatalogueForUi() {
    return {
      rulesVersion: this.getRulesVersion(),
      gpus: this.getGpus(),
      systems: this.getSystems(),
      models: this.getModels(),
      precisions: this.getPrecisions(),
      autoPrecisions: this.getAutoPrecisions(),
      managedApiTiers: this.getManagedApiTiers(),
    };
  }
}
