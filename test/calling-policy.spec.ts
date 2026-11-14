import {
  callPolicyFromEnv,
  isWithinCallingWindow,
} from '../src/calling/calling.policy';

describe('local calling policy', () => {
  it('defaults to disabled planning and the Asia/Kolkata business window', () => {
    expect(callPolicyFromEnv({})).toEqual({
      enabled: false,
      timezone: 'Asia/Kolkata',
      startMinute: 9 * 60,
      endMinute: 18 * 60,
    });
  });

  it('includes the opening minute and excludes the closing minute in the configured timezone', () => {
    const policy = callPolicyFromEnv({});
    expect(
      isWithinCallingWindow(policy, new Date('2026-01-01T03:29:00Z')),
    ).toBe(false);
    expect(
      isWithinCallingWindow(policy, new Date('2026-01-01T03:30:00Z')),
    ).toBe(true);
    expect(
      isWithinCallingWindow(policy, new Date('2026-01-01T12:29:59Z')),
    ).toBe(true);
    expect(
      isWithinCallingWindow(policy, new Date('2026-01-01T12:30:00Z')),
    ).toBe(false);
  });

  it.each([
    { CALL_PLANNING_ENABLED: 'yes' },
    { CALL_TIMEZONE: 'invalid/timezone' },
    { CALL_WINDOW_START: '24:00' },
    { CALL_WINDOW_START: '18:00', CALL_WINDOW_END: '09:00' },
    { CALL_WINDOW_START: '09:00', CALL_WINDOW_END: '09:00' },
  ])('rejects invalid configuration %j', (env) => {
    expect(() => callPolicyFromEnv(env)).toThrow();
  });
});
