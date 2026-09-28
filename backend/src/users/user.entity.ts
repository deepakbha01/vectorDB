import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum UserRole {
  ADMIN = 'admin',
  ARCHITECT = 'architect',
  VIEWER = 'viewer',
}

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  /**
   * Never loaded unless a query asks for it by name (only the login check
   * does), so a user joined onto another record - e.g. a project's `owner` -
   * does not carry it. toJSON() below also keeps it out of every response.
   */
  @Column({ select: false })
  passwordHash: string;

  @Column({ nullable: true })
  fullName?: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.VIEWER })
  role: UserRole;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  /** Every API response is JSON-serialized, so this keeps the hash out even when a query did load it. */
  toJSON(): Omit<User, 'passwordHash' | 'toJSON'> {
    const { passwordHash, ...rest } = this;
    return rest;
  }
}
