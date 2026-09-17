import { Module } from '@nestjs/common';
import { EmbeddingClientService } from './embedding-client.service';

@Module({
  providers: [EmbeddingClientService],
  exports: [EmbeddingClientService],
})
export class EmbeddingClientModule {}
