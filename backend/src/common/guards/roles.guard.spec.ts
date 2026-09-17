import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { UserRole } from '../../users/user.entity';

function makeContext(user: { role: UserRole } | undefined) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

describe('RolesGuard', () => {
  it('allows the request through when the handler has no @Roles decorator', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(makeContext({ role: UserRole.VIEWER }))).toBe(true);
  });

  it('allows a user whose role is in the required list', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue([UserRole.ADMIN, UserRole.ARCHITECT]) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(makeContext({ role: UserRole.ARCHITECT }))).toBe(true);
  });

  it('rejects a viewer from a route that requires admin/architect', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue([UserRole.ADMIN, UserRole.ARCHITECT]) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(makeContext({ role: UserRole.VIEWER }))).toThrow(ForbiddenException);
  });

  it('rejects when there is no authenticated user at all', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue([UserRole.ADMIN]) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(ForbiddenException);
  });

  it('rejects execute-only admin routes for an architect', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue([UserRole.ADMIN]) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(makeContext({ role: UserRole.ARCHITECT }))).toThrow(ForbiddenException);
  });
});
