import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChunkingService } from './chunking.service';
import { ChunkingPreviewDto } from './dto/chunking-preview.dto';

@ApiTags('chunking')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chunking')
export class ChunkingController {
  constructor(private readonly chunkingService: ChunkingService) {}

  @Post('preview')
  preview(@Body() dto: ChunkingPreviewDto) {
    return this.chunkingService.chunk(dto.text, dto.config);
  }
}
