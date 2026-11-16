/** Runtime credentials must never be required by the production migration path. */
export function migrationDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const migrationUrl = environment.DATABASE_MIGRATION_URL?.trim();
  if (migrationUrl) return migrationUrl;
  if (environment.NODE_ENV === 'production') {
    throw new Error('DATABASE_MIGRATION_URL is required in production');
  }
  const developmentUrl = environment.DATABASE_URL?.trim();
  if (!developmentUrl) {
    throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL is required');
  }
  return developmentUrl;
}
