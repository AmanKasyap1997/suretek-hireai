import { Role } from '../common/enums';

/** Every enum role can read its own authenticated profile. */
export const ALL_ROLES: readonly Role[] = Object.values(Role);

/** Explicit grants: a new role receives no business access automatically. */
export const ADMIN_ROLES: readonly Role[] = [Role.SUPER_ADMIN, Role.HR_ADMIN];
export const RECRUITMENT_ROLES: readonly Role[] = [
  ...ADMIN_ROLES,
  Role.RECRUITER,
];
