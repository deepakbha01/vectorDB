import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/user.entity';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async register(email: string, password: string, fullName?: string) {
    // Self-registration defaults to `architect`, not `usersService.create`'s own
    // default of `viewer` - since Sprint 9's RBAC enforcement, a viewer cannot
    // create a project or submit any phase, so defaulting new signups to viewer
    // would lock every new user out of the app with no self-service way to fix
    // it. `viewer` remains available as an explicit, admin-assigned role for
    // read-only collaborators (see RUNBOOK.md).
    const user = await this.usersService.create(email, password, fullName, UserRole.ARCHITECT);
    return this.buildSession(user.id, user.email, user.role);
  }

  async login(email: string, password: string) {
    const user = await this.usersService.validateCredentials(email, password);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    return this.buildSession(user.id, user.email, user.role);
  }

  private buildSession(id: string, email: string, role: UserRole) {
    const payload: AuthenticatedUser = { id, email, role };
    return {
      accessToken: this.jwtService.sign(payload),
      user: payload,
    };
  }
}
