import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectsModule } from '../projects/projects.module';
import { VectorDbSelectionModule } from '../vector-db-selection/vector-db-selection.module';
import { InferenceModule } from '../inference/inference.module';
import { AiFactoryModule } from '../ai-factory/ai-factory.module';
import { LlmClientService } from './llm-client.service';
import { LlmSummaryService } from './llm-summary.service';
import { LlmSummaryController } from './llm-summary.controller';
import { LlmSummaryEnabledGuard } from './llm-summary-enabled.guard';
import { LlmConnection } from './llm-connection.entity';
import { LlmConnectionsService } from './llm-connections.service';
import { LlmConnectionsController } from './llm-connections.controller';

/**
 * Optional LLM summary step. Reads the stored rule-engine results and asks an
 * LLM for a narrative; nothing here feeds back into an engine or a decision.
 */
@Module({
  imports: [TypeOrmModule.forFeature([LlmConnection]), ProjectsModule, VectorDbSelectionModule, InferenceModule, AiFactoryModule],
  providers: [LlmClientService, LlmConnectionsService, LlmSummaryService, LlmSummaryEnabledGuard],
  controllers: [LlmSummaryController, LlmConnectionsController],
})
export class LlmSummaryModule {}
