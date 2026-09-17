import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { EmbeddingsService } from './embeddings.service';

@ApiTags('embeddings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('embeddings')
export class EmbeddingsController {
  constructor(private readonly embeddingsService: EmbeddingsService) {}

  @Get('catalog')
  getCatalog() {
    return this.embeddingsService.getCatalog();
  }
}
