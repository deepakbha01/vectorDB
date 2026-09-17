import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserRole } from './user.entity';

const SALT_ROUNDS = 12;

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  async create(email: string, password: string, fullName?: string, role: UserRole = UserRole.VIEWER): Promise<User> {
    const existing = await this.users.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException(`An account with email '${email}' already exists.`);
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = this.users.create({ email, passwordHash, fullName, role });
    return this.users.save(user);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.users.findOne({ where: { email } });
  }

  async findById(id: string): Promise<User> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User '${id}' was not found.`);
    }
    return user;
  }

  async validateCredentials(email: string, password: string): Promise<User | null> {
    const user = await this.findByEmail(email);
    if (!user) {
      return null;
    }
    const matches = await bcrypt.compare(password, user.passwordHash);
    return matches ? user : null;
  }

  async findAll(): Promise<User[]> {
    return this.users.find({ order: { createdAt: 'ASC' } });
  }

  /**
   * The register page always signs new users up as `architect` (see
   * AuthService.register) - this is the only way any user reaches `admin` or
   * `viewer`. Refuses to demote the last remaining admin so an admin account
   * can never lock everyone out of role management entirely.
   */
  async updateRole(id: string, role: UserRole): Promise<User> {
    const user = await this.findById(id);
    if (user.role === UserRole.ADMIN && role !== UserRole.ADMIN) {
      const adminCount = await this.users.count({ where: { role: UserRole.ADMIN } });
      if (adminCount <= 1) {
        throw new BadRequestException('Cannot change this role: at least one admin must remain.');
      }
    }
    user.role = role;
    return this.users.save(user);
  }
}
