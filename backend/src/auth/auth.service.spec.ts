import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/user.entity';

describe('AuthService', () => {
  let service: AuthService;
  let usersService: { create: jest.Mock; validateCredentials: jest.Mock };

  beforeEach(async () => {
    usersService = { create: jest.fn(), validateCredentials: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: { sign: () => 'signed-jwt' } },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('issues a token on successful registration', async () => {
    usersService.create.mockResolvedValue({ id: '1', email: 'a@b.com', role: UserRole.ARCHITECT });
    const result = await service.register('a@b.com', 'password123!');
    expect(result.accessToken).toBe('signed-jwt');
    expect(result.user.email).toBe('a@b.com');
  });

  it('self-registration defaults to architect, not viewer - a viewer cannot create a project once RBAC is enforced', async () => {
    usersService.create.mockResolvedValue({ id: '1', email: 'a@b.com', role: UserRole.ARCHITECT });
    await service.register('a@b.com', 'password123!', 'Jane Doe');
    expect(usersService.create).toHaveBeenCalledWith('a@b.com', 'password123!', 'Jane Doe', UserRole.ARCHITECT);
  });

  it('throws UnauthorizedException on bad login credentials', async () => {
    usersService.validateCredentials.mockResolvedValue(null);
    await expect(service.login('a@b.com', 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
