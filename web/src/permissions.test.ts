import { describe, it, expect } from 'vitest';
import { visibleNavigation, homePath, allowedDestination } from './permissions';
describe('Platform menu', () => {
  it('shows exactly the six platform sections', () => {
    expect(visibleNavigation('SUPER_ADMIN').map((v) => v.label)).toEqual([
      'Dashboard',
      'Organizations',
      'Integrations',
      'Settings',
      'Audit Logs',
      'Platform Reports',
    ]);
    expect(homePath('SUPER_ADMIN')).toBe('/super-admin/dashboard');
  });
  it('does not give organization roles platform navigation', () => {
    expect(allowedDestination('/super-admin/settings', 'HR_ADMIN')).toBe(false);
    expect(
      visibleNavigation('HR_ADMIN').some((v) => v.id === 'integrations'),
    ).toBe(false);
  });
  it('hides disabled organization modules', () => {
    expect(visibleNavigation('HR_ADMIN', []).some((v) => v.id === 'jobs')).toBe(
      false,
    );
    expect(
      visibleNavigation('HR_ADMIN', ['hiring']).some((v) => v.id === 'jobs'),
    ).toBe(true);
  });
});
