import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  unlink,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  EnumSchema,
  EnumSnapshot,
  enumSchema,
} from '../src/database/enum-schema';

export type { EnumSchema, EnumSnapshot } from '../src/database/enum-schema';

function sortedUnique(values: readonly string[]): string[] {
  if (
    !values.length ||
    values.some((value) => typeof value !== 'string' || !value)
  ) {
    throw new Error(
      'Persisted enums require at least one nonempty string value',
    );
  }
  return [...new Set(values)].sort();
}

/** Stable, offline representation of every enum CHECK, default and dependent rule. */
export function buildEnumSnapshot(
  schema: EnumSchema = enumSchema,
): EnumSnapshot {
  const columns = schema.columns.map((definition) => {
    const values = sortedUnique(definition.values);
    if (
      definition.defaultValue !== undefined &&
      !values.includes(definition.defaultValue)
    ) {
      throw new Error(
        `Default for ${definition.table}.${definition.column} is not an enum value`,
      );
    }
    return {
      enumName: definition.enumName,
      table: definition.table,
      column: definition.column,
      constraintName: definition.constraintName,
      values,
      ...(definition.defaultValue === undefined
        ? {}
        : { defaultValue: definition.defaultValue }),
    };
  });
  columns.sort((left, right) =>
    `${left.table}.${left.column}`.localeCompare(
      `${right.table}.${right.column}`,
      'en',
    ),
  );
  const invariants = schema.invariants.map((definition) => ({
    table: definition.table,
    constraintName: definition.constraintName,
    legacyConstraintNames: [
      ...new Set(definition.legacyConstraintNames),
    ].sort(),
    conditionColumn: definition.conditionColumn,
    conditionValue: definition.conditionValue,
    requiredNonNullColumns: sortedUnique(definition.requiredNonNullColumns),
  }));
  invariants.sort((left, right) =>
    `${left.table}.${left.constraintName}`.localeCompare(
      `${right.table}.${right.constraintName}`,
      'en',
    ),
  );
  return { version: 1, columns, invariants };
}

function canonicalSnapshot(snapshot: EnumSnapshot): EnumSnapshot {
  if (snapshot.version !== 1)
    throw new Error('Unsupported enum snapshot version');
  return buildEnumSnapshot(snapshot);
}

function quoteIdentifier(value: string): string {
  if (!value || value.includes('\0')) throw new Error('Invalid SQL identifier');
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  if (value.includes('\0'))
    throw new Error('Enum values may not contain null bytes');
  // Escape-string syntax makes backslashes independent of server settings.
  return `E'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** SQL is append-only history: existing migrations are never regenerated in place. */
export function renderEnumMigration(
  snapshot: EnumSnapshot = buildEnumSnapshot(),
): string {
  const canonical = canonicalSnapshot(snapshot);
  const statements = [
    '-- Generated from src/common/enums.ts by npm run enums:generate.',
    '-- Commit this migration and database/enums.snapshot.json together.',
    '-- Renamed/removed values require an explicit preceding data migration.',
    '-- Never edit migrations that have already been applied.',
    '',
  ];
  for (const definition of canonical.columns) {
    const table = quoteIdentifier(definition.table);
    const column = quoteIdentifier(definition.column);
    const constraint = quoteIdentifier(definition.constraintName);
    statements.push(
      `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint};`,
      `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${column} IN (${definition.values.map(quoteLiteral).join(', ')}));`,
      definition.defaultValue === undefined
        ? `ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT;`
        : `ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${quoteLiteral(definition.defaultValue)};`,
      '',
    );
  }
  for (const invariant of canonical.invariants) {
    const table = quoteIdentifier(invariant.table);
    for (const name of [
      ...new Set([
        ...invariant.legacyConstraintNames,
        invariant.constraintName,
      ]),
    ]) {
      statements.push(
        `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(name)};`,
      );
    }
    const requiredEvidence = invariant.requiredNonNullColumns
      .map((column) => `${quoteIdentifier(column)} IS NOT NULL`)
      .join(' AND ');
    statements.push(
      `ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdentifier(invariant.constraintName)} CHECK (${quoteIdentifier(invariant.conditionColumn)} <> ${quoteLiteral(invariant.conditionValue)} OR (${requiredEvidence}));`,
      '',
    );
  }
  return statements.join('\n');
}

function snapshotText(snapshot: EnumSnapshot): string {
  return `${JSON.stringify(canonicalSnapshot(snapshot), null, 2)}\n`;
}

async function readSnapshot(
  snapshotPath: string,
): Promise<EnumSnapshot | undefined> {
  let contents: string;
  try {
    contents = await readFile(snapshotPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return canonicalSnapshot(JSON.parse(contents) as EnumSnapshot);
  } catch {
    throw new Error(
      `Invalid enum snapshot: ${snapshotPath}. Restore it from Git before generating another migration.`,
    );
  }
}

export async function assertEnumSnapshotCurrent(
  rootDirectory: string = process.cwd(),
  expectedSnapshot: EnumSnapshot = buildEnumSnapshot(),
): Promise<void> {
  const snapshotPath = resolve(rootDirectory, 'database/enums.snapshot.json');
  const existing = await readSnapshot(snapshotPath);
  if (!existing || snapshotText(existing) !== snapshotText(expectedSnapshot)) {
    throw new Error(
      'Enum schema changed without a generated migration. Run npm run enums:generate and commit the new migration plus database/enums.snapshot.json.',
    );
  }
}

export interface EnumMigrationResult {
  changed: boolean;
  migrationPath?: string;
  snapshotPath: string;
}

export async function generateEnumMigration(
  rootDirectory: string = process.cwd(),
  expectedSnapshot: EnumSnapshot = buildEnumSnapshot(),
): Promise<EnumMigrationResult> {
  const snapshotPath = resolve(rootDirectory, 'database/enums.snapshot.json');
  const snapshot = canonicalSnapshot(expectedSnapshot);
  const existing = await readSnapshot(snapshotPath);
  if (existing && snapshotText(existing) === snapshotText(snapshot)) {
    return { changed: false, snapshotPath };
  }
  const directory = resolve(rootDirectory, 'database/migrations');
  await mkdir(directory, { recursive: true });
  const names = await readdir(directory);
  const versions = names.flatMap((name) => {
    const match = /^(\d+)_[a-z0-9_-]+\.sql$/.exec(name);
    return match ? [Number(match[1])] : [];
  });
  const nextVersion = Math.max(0, ...versions) + 1;
  if (!Number.isSafeInteger(nextVersion))
    throw new Error('Migration version exceeds supported range');
  const filename = `${String(nextVersion).padStart(3, '0')}_sync_domain_enums.sql`;
  const migrationPath = resolve(directory, filename);
  await writeFile(migrationPath, renderEnumMigration(snapshot), { flag: 'wx' });
  const temporarySnapshotPath = `${snapshotPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporarySnapshotPath, snapshotText(snapshot), {
      flag: 'wx',
    });
    await rename(temporarySnapshotPath, snapshotPath);
  } catch (error) {
    await unlink(temporarySnapshotPath).catch(() => undefined);
    await unlink(migrationPath).catch(() => undefined);
    throw error;
  }
  return { changed: true, migrationPath, snapshotPath };
}
