import { Module } from '@nestjs/common';
import { ChunkingService } from './chunking.service';
import { ChunkingController } from './chunking.controller';

@Module({
  providers: [ChunkingService],
  controllers: [ChunkingController],
  exports: [ChunkingService],
})
export class ChunkingModule {}
