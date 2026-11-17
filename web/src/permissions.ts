// Coarse visibility only. Backend RLS, assignments and action policies remain authoritative.
export const roles = [
  'SUPER_ADMIN',
  'HR_ADMIN',
  'RECRUITER',
  'HIRING_MANAGER',
  'INTERVIEWER',
  'CANDIDATE',
  'EMPLOYEE',
  'REPORTING_MANAGER',
  'PAYROLL_FINANCE',
  'IT_ASSET_ADMIN',
] as const;
export type Role = (typeof roles)[number];
export const permissionMap: Record<Role, readonly string[]> = {
  SUPER_ADMIN: [
    'dashboard',
    'organizations',
    'integrations',
    'platform-settings',
    'audit-logs',
    'platform-reports',
  ],
  HR_ADMIN: [
    'team',
    'jobs',
    'applications',
    'candidates',
    'interviews',
    'reports',
    'offers',
    'people',
    'leave',
    'attendance',
    'onboarding',
    'payroll',
    'compensation',
    'expenses',
    'offboarding',
    'performance',
    'learning',
    'engagement',
    'helpdesk',
    'settings',
  ],
  RECRUITER: ['jobs', 'applications', 'candidates', 'interviews', 'reports'],
  HIRING_MANAGER: ['jobs', 'applications', 'interviews'],
  INTERVIEWER: ['jobs', 'applications', 'interviews'],
  CANDIDATE: [],
  EMPLOYEE: [],
  REPORTING_MANAGER: [],
  PAYROLL_FINANCE: [],
  IT_ASSET_ADMIN: [],
};
export const platformNavigation = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    built: true,
    path: '/super-admin/dashboard',
  },
  {
    id: 'organizations',
    label: 'Organizations',
    built: true,
    path: '/super-admin/organizations',
  },
  {
    id: 'integrations',
    label: 'Integrations',
    built: true,
    path: '/super-admin/integrations',
  },
  {
    id: 'platform-settings',
    label: 'Settings',
    built: true,
    path: '/super-admin/settings',
  },
  {
    id: 'audit-logs',
    label: 'Audit Logs',
    built: true,
    path: '/super-admin/audit-logs',
  },
  {
    id: 'platform-reports',
    label: 'Platform Reports',
    built: true,
    path: '/super-admin/reports',
  },
];
export const moduleForMenu: Record<string, string> = {
  jobs: 'hiring',
  applications: 'hiring',
  candidates: 'hiring',
  interviews: 'hiring',
  reports: 'hiring',
  offers: 'hiring',
  people: 'core_hr',
  ...Object.fromEntries(
    [
      'leave',
      'attendance',
      'onboarding',
      'payroll',
      'compensation',
      'expenses',
      'offboarding',
      'performance',
      'learning',
      'engagement',
      'helpdesk',
    ].map((m) => [m, m]),
  ),
};
export const navigation: {
  id: string;
  label: string;
  built?: boolean;
  path?: string;
}[] = [
  { id: 'organizations', label: 'Organizations', built: true },
  { id: 'team', label: 'Team & invitations', built: true },
  { id: 'jobs', label: 'Jobs' },
  { id: 'applications', label: 'Applications' },
  { id: 'candidates', label: 'Candidates' },
  { id: 'interviews', label: 'Interviews' },
  { id: 'reports', label: 'Reports' },
  { id: 'offers', label: 'Offers' },
  { id: 'people', label: 'People' },
  ...[
    'leave',
    'attendance',
    'onboarding',
    'payroll',
    'compensation',
    'expenses',
    'offboarding',
    'performance',
    'learning',
    'engagement',
    'helpdesk',
  ].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
  { id: 'settings', label: 'Administration' },
];
export const roleLabel = (role: Role) =>
  role === 'HR_ADMIN'
    ? 'Organization Admin'
    : role
        .toLowerCase()
        .split('_')
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(' ');
export const homePath = (role: Role) =>
  role === 'SUPER_ADMIN'
    ? '/super-admin/dashboard'
    : `/home/${role.toLowerCase()}`;
export const visibleNavigation = (
  role: Role,
  modules?: string[],
  memberships: Role[] = [role],
) =>
  role === 'SUPER_ADMIN'
    ? platformNavigation
    : navigation.filter(
        (n) =>
          [role, ...memberships].some((r) => permissionMap[r].includes(n.id)) &&
          (!modules ||
            !moduleForMenu[n.id] ||
            modules.includes(moduleForMenu[n.id])),
      );
export function allowedDestination(path: string, role: Role) {
  return (
    path === homePath(role) ||
    (role === 'SUPER_ADMIN' &&
      platformNavigation.some((n) => path === n.path)) ||
    navigation.some(
      (n) => path === `/${n.id}` && permissionMap[role].includes(n.id),
    )
  );
}
