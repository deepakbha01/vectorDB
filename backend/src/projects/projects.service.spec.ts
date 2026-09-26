import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { Project } from './project.entity';
import { VectorPlatform } from './enums/platform.enum';
import { CustomerMode } from './enums/customer-mode.enum';
import { UserRole } from '../users/user.entity';
import { PlatformConfigService } from '../common/config/platform-config.service';

describe('ProjectsService', () => {
  let service: ProjectsService;
  let repo: { create: jest.Mock; save: jest.Mock; find: jest.Mock; findOne: jest.Mock; delete: jest.Mock };
  let platformConfig: { getPatternCatalog: jest.Mock };

  const owner = { id: 'owner-1', email: 'owner@example.com', role: UserRole.ARCHITECT };
  const stranger = { id: 'stranger-1', email: 'stranger@example.com', role: UserRole.VIEWER };

  beforeEach(async () => {
    repo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'project-1', ...data })),
      find: jest.fn(),
      findOne: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    platformConfig = {
      getPatternCatalog: jest.fn().mockReturnValue([{ id: 'enterprise-document-rag', name: 'Enterprise Document RAG' }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: getRepositoryToken(Project), useValue: repo },
        { provide: PlatformConfigService, useValue: platformConfig },
      ],
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

  it('creates a project seeded from a known pattern', async () => {
    const project = await service.create(owner, 'RAG Assistant', undefined, undefined, 'enterprise-document-rag');
    expect(project.patternId).toBe('enterprise-document-rag');
  });

  it('rejects an unknown patternId', async () => {
    await expect(service.create(owner, 'RAG Assistant', undefined, undefined, 'not-a-real-pattern')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('defaults customerMode to "new" when not specified', async () => {
    const project = await service.create(owner, 'RAG Assistant');
    expect(project.customerMode).toBe(CustomerMode.NEW);
  });

  it('accepts an explicit "existing" customerMode', async () => {
    const project = await service.create(owner, 'RAG Assistant', undefined, undefined, undefined, CustomerMode.EXISTING);
    expect(project.customerMode).toBe(CustomerMode.EXISTING);
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

  describe('remove', () => {
    const project = { id: 'p1', name: 'RAG Assistant', owner: { id: owner.id } };

    it('lets the owner delete the project and returns what was deleted', async () => {
      repo.findOne.mockResolvedValue(project);
      await expect(service.remove('p1', owner)).resolves.toEqual({ id: 'p1', name: 'RAG Assistant', deleted: true });
      expect(repo.delete).toHaveBeenCalledWith({ id: 'p1' });
    });

    it('lets an admin delete any project', async () => {
      repo.findOne.mockResolvedValue(project);
      await service.remove('p1', { id: 'admin-1', email: 'admin@example.com', role: UserRole.ADMIN });
      expect(repo.delete).toHaveBeenCalledWith({ id: 'p1' });
    });

    it("refuses someone else's project and deletes nothing", async () => {
      repo.findOne.mockResolvedValue(project);
      await expect(service.remove('p1', { id: 'other-architect', email: 'x@example.com', role: UserRole.ARCHITECT })).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('reports a missing project as not found', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.remove('nope', owner)).rejects.toThrow(/was not found/);
      expect(repo.delete).not.toHaveBeenCalled();
    });
  });
});
