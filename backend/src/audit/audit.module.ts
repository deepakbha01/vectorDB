import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogEntry } from './audit-log-entry.entity';
import { AuditLogService } from './audit-log.service';
import { AuditLogController } from './audit-log.controller';
import { AuditLoggingInterceptor } from './audit-logging.interceptor';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLogEntry]), ProjectsModule],
  providers: [AuditLogService, { provide: APP_INTERCEPTOR, useClass: AuditLoggingInterceptor }],
  controllers: [AuditLogController],
  exports: [AuditLogService],
})
export class AuditModule {}
