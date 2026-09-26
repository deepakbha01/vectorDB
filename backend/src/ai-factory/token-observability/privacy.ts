import { UserRole } from '../../users/user.entity';

/**
 * Tenant visibility (spec §7 "tenant/customer where permitted", §18). Tenant
 * ids identify customers, so by default only admins and architects see them
 * or filter by them. TOKEN_TENANT_VISIBILITY=all opens them to viewers too.
 */
export function canSeeTenants(role: UserRole | string | undefined, visibility = process.env.TOKEN_TENANT_VISIBILITY ?? 'privileged'): boolean {
  if (visibility.trim().toLowerCase() === 'all') return true;
  return role === UserRole.ADMIN || role === UserRole.ARCHITECT;
}
