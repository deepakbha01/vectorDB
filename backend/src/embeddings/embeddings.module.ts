import { Module } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service';
import { EmbeddingsController } from './embeddings.controller';

@Module({
  providers: [EmbeddingsService],
  controllers: [EmbeddingsController],
  exports: [EmbeddingsService],
})
export class EmbeddingsModule {}
