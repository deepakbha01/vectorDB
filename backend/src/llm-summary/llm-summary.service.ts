import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedUser } from '../auth/auth.service';
import { ProjectsService } from '../projects/projects.service';
import { VectorDbSelectionService } from '../vector-db-selection/vector-db-selection.service';
import { InferenceService } from '../inference/inference.service';
import { FinalRecommendationService } from '../ai-factory/final/final.service';
import { FeaturesController } from '../features/features.controller';
import { LlmClientService, LlmProvider } from './llm-client.service';
import { LlmConnectionsService } from './llm-connections.service';
import { compactFacts, LlmSummaryAudience, LlmSummarySubject, systemPrompt, userPrompt } from './llm-summary.prompt';

export interface LlmSummary {
  subject: LlmSummarySubject;
  audience: LlmSummaryAudience;
  text: string;
  provider: LlmProvider;
  model: string;
  /** The LLM integration used. */
  connection: { id: string; name: string };
  generatedAt: string;
  truncated: boolean;
  usage: { inputTokens: number; outputTokens: number } | null;
  /** The rule-engine record the summary was written from. */
  source: { id: string; version: number | null; createdAt: string; rulesVersion: string };
  disclaimer: string;
}

const DISCLAIMER =
  'AI-generated narrative of the rule-based result above. The rule-based result is the record of decision; check any figure against it before you reuse this text.';

interface SourceRecord {
  facts: unknown;
  source: LlmSummary['source'];
}

/**
 * Optional LLM step: turns an already-computed, stored assessment into a
 * readable narrative. It never feeds back into any engine and saves nothing;
 * the request itself is recorded by the audit interceptor.
 */
@Injectable()
export class LlmSummaryService {
  private readonly features: FeaturesController;

  constructor(
    config: ConfigService,
    private readonly llm: LlmClientService,
    private readonly connections: LlmConnectionsService,
    private readonly projects: ProjectsService,
    private readonly vectorDbSelection: VectorDbSelectionService,
    private readonly inference: InferenceService,
    private readonly finals: FinalRecommendationService,
  ) {
    this.features = new FeaturesController(config);
  }

  async summarize(projectId: string, subject: LlmSummarySubject, audience: LlmSummaryAudience, user: AuthenticatedUser, connectionId?: string): Promise<LlmSummary> {
    const project = await this.projects.findOne(projectId, user);
    const record = await this.load(projectId, subject, user);
    const llm = await this.connections.resolve(connectionId);
    const completion = await this.llm.complete(systemPrompt(audience), userPrompt(subject, project.name, compactFacts(record.facts)), llm.settings);
    return {
      subject,
      audience,
      text: completion.text,
      provider: completion.provider,
      model: completion.model,
      connection: { id: llm.connectionId, name: llm.connectionName },
      generatedAt: new Date().toISOString(),
      truncated: completion.truncated,
      usage: completion.usage,
      source: record.source,
      disclaimer: DISCLAIMER,
    };
  }

  private async load(projectId: string, subject: LlmSummarySubject, user: AuthenticatedUser): Promise<SourceRecord> {
    if (subject === 'vector-db-selection') {
      const outcome = await this.vectorDbSelection.getLatest(projectId, user);
      if (!outcome) throw new NotFoundException('Vector DB Selection has not been run for this project yet.');
      const { id, createdAt, rulesVersion, project: _project, assessment: _assessment, ...facts } = outcome.adr;
      return { facts, source: { id, version: null, createdAt: createdAt.toISOString(), rulesVersion } };
    }
    if (subject === 'inference') {
      const a = await this.inference.getLatest(projectId, user);
      if (!a) throw new NotFoundException('No Inference assessment has been submitted for this project yet.');
      // The step-by-step workings are long and only restate the figures already in the result.
      const { workings: _workings, ...result } = a.result;
      return { facts: { decision: a.decision, inputsUsed: a.inputsUsed, result }, source: { id: a.id, version: a.version, createdAt: a.createdAt.toISOString(), rulesVersion: a.rulesVersion } };
    }
    if (!this.features.flags().aiFactory) throw new NotFoundException('The AI Factory workflow is not enabled on this server.');
    const f = await this.finals.getLatest(projectId, user);
    if (!f) throw new NotFoundException('No final recommendation has been made for this project yet.');
    return { facts: f.result, source: { id: f.id, version: f.version, createdAt: f.createdAt.toISOString(), rulesVersion: f.rulesVersion } };
  }
}
