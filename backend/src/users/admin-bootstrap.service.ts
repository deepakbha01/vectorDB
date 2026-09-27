import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs';
import { User, UserRole } from './user.entity';
import { AuditLogEntry } from '../audit/audit-log-entry.entity';

/** Serialises bootstrap across replicas starting at once (any constant; this spells "AVNT"). */
export const BOOTSTRAP_LOCK_KEY = 0x41564e54;
export const MIN_ADMIN_PASSWORD_LENGTH = 12;
const SALT_ROUNDS = 12;
const PLACEHOLDERS = new Set(['change-me', 'changeme', 'password', 'admin', 'administrator']);

export type BootstrapOutcome = 'admin-exists' | 'not-configured' | 'created';

/**
 * Creates the first admin account when the application starts against a
 * database that has none - so a fresh production deployment is usable
 * without hand-written SQL.
 *
 * Configured by BOOTSTRAP_ADMIN_EMAIL plus the password, preferably as a
 * mounted secret file (BOOTSTRAP_ADMIN_PASSWORD_FILE) or else
 * BOOTSTRAP_ADMIN_PASSWORD; BOOTSTRAP_ADMIN_NAME is optional.
 *
 * Safe to leave on and to run on every start:
 * - once any admin exists it does nothing and reads nothing - it never
 *   resets a password or changes an account;
 * - it never takes over an existing account with the same email;
 * - replicas starting together are serialised by a PostgreSQL advisory lock,
 *   so exactly one admin is created;
 * - the password is never logged; the creation is written to the audit log.
 *
 * With no admin, an email set but no usable password stops the start-up with
 * a clear error, rather than leaving a production system with no admin.
 */
@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger('AdminBootstrap');

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.run();
  }

  async run(): Promise<BootstrapOutcome> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY]);
      const users = manager.getRepository(User);
      if ((await users.count({ where: { role: UserRole.ADMIN } })) > 0) {
        this.logger.log('An admin account exists; nothing to bootstrap.');
        return 'admin-exists';
      }

      const email = (this.config.get<string>('BOOTSTRAP_ADMIN_EMAIL') ?? '').trim();
      if (!email) {
        this.logger.warn('No admin account exists and BOOTSTRAP_ADMIN_EMAIL is not set. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD_FILE (or BOOTSTRAP_ADMIN_PASSWORD) to create one on the next start - see DEPLOYMENT.md.');
        return 'not-configured';
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`BOOTSTRAP_ADMIN_EMAIL '${email}' is not an email address.`);
      const { password, source } = this.readPassword();

      const existing = await users.createQueryBuilder('u').where('LOWER(u.email) = LOWER(:email)', { email }).getOne();
      if (existing) {
        throw new Error(
          `No admin exists, but an account with ${email} already exists (role ${existing.role}). The bootstrap will not take over an existing account: promote it deliberately (RUNBOOK.md) or set BOOTSTRAP_ADMIN_EMAIL to an unused address.`,
        );
      }

      const fullName = (this.config.get<string>('BOOTSTRAP_ADMIN_NAME') ?? '').trim() || 'Administrator';
      const admin = await users.save(users.create({ email, passwordHash: await bcrypt.hash(password, SALT_ROUNDS), fullName, role: UserRole.ADMIN }));
      await manager.getRepository(AuditLogEntry).save({
        user: { id: admin.id } as User,
        userEmail: email,
        method: 'SYSTEM',
        path: 'bootstrap/first-admin',
        statusCode: 201,
        requestSummary: { email, role: UserRole.ADMIN, passwordFrom: source },
        durationMs: 0,
      });
      this.logger.log(
        `Created the first admin account ${email} (password from ${source}). ${source === 'BOOTSTRAP_ADMIN_PASSWORD' ? 'Remove BOOTSTRAP_ADMIN_PASSWORD from the environment now - it is not read again while an admin exists.' : 'The secret is not read again while an admin exists.'}`,
      );
      return 'created';
    });
  }

  /** The password from the secret file (preferred) or the variable; refused when missing, short or a placeholder. */
  private readPassword(): { password: string; source: 'BOOTSTRAP_ADMIN_PASSWORD_FILE' | 'BOOTSTRAP_ADMIN_PASSWORD' } {
    const file = (this.config.get<string>('BOOTSTRAP_ADMIN_PASSWORD_FILE') ?? '').trim();
    let password: string;
    let source: 'BOOTSTRAP_ADMIN_PASSWORD_FILE' | 'BOOTSTRAP_ADMIN_PASSWORD';
    if (file) {
      try {
        password = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
      } catch (e) {
        throw new Error(`BOOTSTRAP_ADMIN_PASSWORD_FILE could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'}).`);
      }
      source = 'BOOTSTRAP_ADMIN_PASSWORD_FILE';
    } else {
      password = this.config.get<string>('BOOTSTRAP_ADMIN_PASSWORD') ?? '';
      source = 'BOOTSTRAP_ADMIN_PASSWORD';
    }
    if (!password) throw new Error('BOOTSTRAP_ADMIN_EMAIL is set but no password was given: set BOOTSTRAP_ADMIN_PASSWORD_FILE (a mounted secret) or BOOTSTRAP_ADMIN_PASSWORD.');
    if (password.length < MIN_ADMIN_PASSWORD_LENGTH) throw new Error(`The bootstrap admin password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`);
    if (PLACEHOLDERS.has(password.toLowerCase())) throw new Error('The bootstrap admin password is a placeholder; set a real one.');
    return { password, source };
  }
}
