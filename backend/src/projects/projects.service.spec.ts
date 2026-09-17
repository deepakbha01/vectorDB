import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { Project } from './project.entity';
import { VectorPlatform } from './enums/platform.enum';
import { UserRole } from '../users/user.entity';

describe('ProjectsService', () => {
  let service: ProjectsService;
  let repo: { create: jest.Mock; save: jest.Mock; find: jest.Mock; findOne: jest.Mock };

  const owner = { id: 'owner-1', email: 'owner@example.com', role: UserRole.ARCHITECT };
  const stranger = { id: 'stranger-1', email: 'stranger@example.com', role: UserRole.VIEWER };

  beforeEach(async () => {
    repo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'project-1', ...data })),
      find: jest.fn(),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ProjectsService, { provide: getRepositoryToken(Project), useValue: repo }],
    }).compile();

    service = module.get(ProjectsService);
  });

  it('creates a project owned by the requester with all phases NOT_STARTED', async () => {
    const project = await service.create(owner, 'RAG Assistant');
    expect(project.owner).toEqual({ id: owner.id });
    expect(project.platform).toBe(VectorPlatform.UNDETERMINED);
    expect(Object.values(project.phaseStatuses)).toEqual(
      Object.values(project.phaseStatuses).map(() => 'not_started'),
    );
  });

  it('requires a rationale when manually selecting a platform', async () => {
    repo.findOne.mockResolvedValue({ id: 'project-1', owner });
    await expect(service.selectPlatform('project-1', owner, VectorPlatform.MILVUS)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('allows platform selection with a rationale and marks it a manual override', async () => {
    repo.findOne.mockResolvedValue({ id: 'project-1', owner });
    const result = await service.selectPlatform('project-1', owner, VectorPlatform.MILVUS, 'Existing k8s + 50M vectors');
    expect(result.platform).toBe(VectorPlatform.MILVUS);
    expect(result.platformIsManualOverride).toBe(true);
  });

  it('denies access to projects the requester does not own and is not an admin', async () => {
    repo.findOne.mockResolvedValue({ id: 'project-1', owner });
    await expect(service.findOne('project-1', stranger)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
