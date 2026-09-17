import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { BenchmarkService } from './benchmark.service';
import { CreateBenchmarkDto } from './dto/create-benchmark.dto';

@ApiTags('optimization')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/optimization')
export class BenchmarkController {
  constructor(private readonly benchmarkService: BenchmarkService) {}

  @Post('benchmarks')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  run(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBenchmarkDto,
  ) {
    return this.benchmarkService.runBenchmark(projectId, user, dto);
  }

  @Get('benchmarks')
  history(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.benchmarkService.getHistory(projectId, user);
  }

  @Get('benchmarks/latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const report = await this.benchmarkService.getLatest(projectId, user);
    if (!report) {
      throw new NotFoundException('No Optimization Report has been generated for this project yet.');
    }
    return report;
  }
}
