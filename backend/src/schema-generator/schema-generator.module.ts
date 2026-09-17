import { Module } from '@nestjs/common';
import { SchemaGeneratorService } from './schema-generator.service';

@Module({
  providers: [SchemaGeneratorService],
  exports: [SchemaGeneratorService],
})
export class SchemaGeneratorModule {}
