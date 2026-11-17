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
    'jobs',
    'applications',
    'candidates',
    'interviews',
    'reports',
    'offers',
    'people',
    'settings',
  ],
  HR_ADMIN: [
    'jobs',
    'applications',
    'candidates',
    'interviews',
    'reports',
    'offers',
    'people',
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
export const navigation = [
  { id: 'jobs', label: 'Jobs' },
  { id: 'applications', label: 'Applications' },
  { id: 'candidates', label: 'Candidates' },
  { id: 'interviews', label: 'Interviews' },
  { id: 'reports', label: 'Reports' },
  { id: 'offers', label: 'Offers' },
  { id: 'people', label: 'People' },
  { id: 'settings', label: 'Administration' },
];
export const roleLabel = (role: Role) =>
  role
    .toLowerCase()
    .split('_')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
export const homePath = (role: Role) => `/home/${role.toLowerCase()}`;
export const visibleNavigation = (role: Role) =>
  navigation.filter((n) => permissionMap[role].includes(n.id));
export function allowedDestination(path: string, role: Role) {
  return (
    path === homePath(role) ||
    navigation.some(
      (n) => path === `/${n.id}` && permissionMap[role].includes(n.id),
    )
  );
}
