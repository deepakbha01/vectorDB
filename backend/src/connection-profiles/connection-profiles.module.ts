import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectsModule } from '../projects/projects.module';
import { DatabaseAdaptersModule } from '../database-adapters/database-adapters.module';
import { ProjectConnectionProfile } from '../database-adapters/connection/project-connection-profile.entity';
import { ConnectionProfilesController } from './connection-profiles.controller';
import { ConnectionProfilesService } from './connection-profiles.service';

/** Per-project connection profiles for the target vector database. */
@Module({
  imports: [TypeOrmModule.forFeature([ProjectConnectionProfile]), ProjectsModule, DatabaseAdaptersModule],
  controllers: [ConnectionProfilesController],
  providers: [ConnectionProfilesService],
})
export class ConnectionProfilesModule {}
