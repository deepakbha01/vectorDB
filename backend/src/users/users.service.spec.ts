import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { User, UserRole } from './user.entity';

describe('UsersService', () => {
  let service: UsersService;
  let repo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock; find: jest.Mock; count: jest.Mock };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'generated-id', ...data })),
      find: jest.fn(),
      count: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: getRepositoryToken(User), useValue: repo }],
    }).compile();

    service = module.get(UsersService);
  });

  it('creates a user with a hashed password', async () => {
    repo.findOne.mockResolvedValue(null);
    const user = await service.create('architect@example.com', 'S3curePassw0rd!', 'Jane Architect', UserRole.ARCHITECT);

    expect(user.email).toBe('architect@example.com');
    expect(user.passwordHash).not.toBe('S3curePassw0rd!');
    expect(user.role).toBe(UserRole.ARCHITECT);
  });

  it('rejects duplicate emails', async () => {
    repo.findOne.mockResolvedValue({ id: 'existing' });
    await expect(service.create('dup@example.com', 'whatever')).rejects.toBeInstanceOf(ConflictException);
  });

  it('validates correct credentials and rejects incorrect ones', async () => {
    repo.findOne.mockResolvedValue(null);
    const created = await service.create('viewer@example.com', 'CorrectHorseBattery1');
    repo.findOne.mockResolvedValue(created);

    const ok = await service.validateCredentials('viewer@example.com', 'CorrectHorseBattery1');
    const bad = await service.validateCredentials('viewer@example.com', 'wrong-password');

    expect(ok?.email).toBe('viewer@example.com');
    expect(bad).toBeNull();
  });

  it('findAll lists users ordered by creation date', async () => {
    repo.find.mockResolvedValue([{ id: '1' }, { id: '2' }]);
    const users = await service.findAll();
    expect(repo.find).toHaveBeenCalledWith({ order: { createdAt: 'ASC' } });
    expect(users).toHaveLength(2);
  });

  it('updateRole changes a non-admin user to any role without checking admin count', async () => {
    repo.findOne.mockResolvedValue({ id: 'u1', role: UserRole.ARCHITECT });
    const updated = await service.updateRole('u1', UserRole.VIEWER);
    expect(repo.count).not.toHaveBeenCalled();
    expect(updated.role).toBe(UserRole.VIEWER);
  });

  it('updateRole allows demoting an admin when another admin still exists', async () => {
    repo.findOne.mockResolvedValue({ id: 'u1', role: UserRole.ADMIN });
    repo.count.mockResolvedValue(2);
    const updated = await service.updateRole('u1', UserRole.ARCHITECT);
    expect(updated.role).toBe(UserRole.ARCHITECT);
  });

  it('updateRole refuses to demote the last remaining admin', async () => {
    repo.findOne.mockResolvedValue({ id: 'u1', role: UserRole.ADMIN });
    repo.count.mockResolvedValue(1);
    await expect(service.updateRole('u1', UserRole.ARCHITECT)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('updateRole raises NotFoundException for an unknown user id', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.updateRole('missing', UserRole.VIEWER)).rejects.toBeInstanceOf(NotFoundException);
  });
});
