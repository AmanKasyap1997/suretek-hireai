import {
  assertEnumSnapshotCurrent,
  generateEnumMigration,
} from './enum-migrations';

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== '--check')) {
    throw new Error('Usage: npm run enums:generate [-- --check]');
  }
  if (arguments_.includes('--check')) {
    await assertEnumSnapshotCurrent();
    console.log('Enum snapshot matches the canonical TypeScript enums.');
    return;
  }
  const result = await generateEnumMigration();
  console.log(
    result.changed
      ? `Generated: ${result.migrationPath}`
      : 'Enum schema is unchanged; no migration generated.',
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Enum migration generation failed',
  );
  process.exitCode = 1;
});
