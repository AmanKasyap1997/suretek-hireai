import { migrationDatabaseUrl } from '../scripts/database-connection';

describe('Migration database credentials', () => {
  const runtimeUrl = 'postgresql://runtime:password@localhost:5432/hireai';
  const ownerUrl = 'postgresql://owner:password@localhost:5432/hireai';

  it.each([undefined, '', '   '])(
    'requires owner credentials in production when the migration URL is %j',
    (migrationUrl) => {
      expect(() =>
        migrationDatabaseUrl({
          NODE_ENV: 'production',
          DATABASE_URL: runtimeUrl,
          DATABASE_MIGRATION_URL: migrationUrl,
        }),
      ).toThrow('DATABASE_MIGRATION_URL is required in production');
    },
  );

  it('selects explicit owner credentials instead of runtime credentials in production', () => {
    expect(
      migrationDatabaseUrl({
        NODE_ENV: 'production',
        DATABASE_URL: runtimeUrl,
        DATABASE_MIGRATION_URL: ` ${ownerUrl} `,
      }),
    ).toBe(ownerUrl);
  });

  it.each(['development', 'test'])(
    'allows runtime URL fallback in %s',
    (nodeEnv) => {
      expect(
        migrationDatabaseUrl({ NODE_ENV: nodeEnv, DATABASE_URL: runtimeUrl }),
      ).toBe(runtimeUrl);
    },
  );

  it.each(['development', 'test'])(
    'rejects missing connection URLs in %s',
    (nodeEnv) => {
      expect(() => migrationDatabaseUrl({ NODE_ENV: nodeEnv })).toThrow(
        'DATABASE_MIGRATION_URL or DATABASE_URL is required',
      );
    },
  );
});
