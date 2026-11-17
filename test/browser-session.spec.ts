import { Request } from 'express';
import {
  assertBrowserOrigin,
  cookieToken,
  sessionCookieOptions,
} from '../src/modules/auth';
describe('browser session CSRF and cookie boundaries', () => {
  const previous = process.env;
  beforeEach(() => {
    process.env = {
      ...previous,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://app:test@localhost/test',
      JWT_SECRET: 'test-secret-with-at-least-thirty-two-characters',
      CORS_ORIGINS: 'https://console.test',
    };
  });
  afterEach(() => {
    process.env = previous;
  });
  it('requires an exact trusted origin', () => {
    for (const origin of [
      undefined,
      'null',
      'https://evil.test',
      'https://console.test.evil.test',
    ])
      expect(() =>
        assertBrowserOrigin({ headers: { origin } } as Request),
      ).toThrow();
    expect(() =>
      assertBrowserOrigin({
        headers: { origin: 'https://console.test' },
      } as Request),
    ).not.toThrow();
  });
  it('extracts only the session cookie and rejects malformed values', () => {
    expect(
      cookieToken({
        headers: { cookie: 'other=x; hireai_session=abc.def.sig' },
      } as Request),
    ).toBe('abc.def.sig');
    expect(
      cookieToken({ headers: { cookie: 'hireai_session=%00' } } as Request),
    ).toBeUndefined();
    expect(sessionCookieOptions()).toMatchObject({
      httpOnly: true,
      sameSite: 'strict',
      path: '/api/v1',
    });
  });
});
