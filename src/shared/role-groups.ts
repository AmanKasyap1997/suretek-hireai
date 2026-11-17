import { Role } from './enums';

/** Every enum role can read its own authenticated profile. */
export const ALL_ROLES: readonly Role[] = Object.values(Role);

/** Explicit grants: a new role receives no business access automatically. */
// Platform Super Admins have no organization business permissions.
export const ADMIN_ROLES: readonly Role[] = [Role.HR_ADMIN];
export const RECRUITMENT_ROLES: readonly Role[] = [
  ...ADMIN_ROLES,
  Role.RECRUITER,
];

/** Only explicitly supported organization staff may be invited or created. */
export const ORGANIZATION_STAFF_ROLES = [
  Role.RECRUITER,
  Role.HIRING_MANAGER,
  Role.INTERVIEWER,
  Role.CANDIDATE,
  Role.EMPLOYEE,
  Role.REPORTING_MANAGER,
  Role.PAYROLL_FINANCE,
  Role.IT_ASSET_ADMIN,
] as const;
