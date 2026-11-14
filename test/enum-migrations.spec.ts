import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  assertEnumSnapshotCurrent,
  buildEnumSnapshot,
  generateEnumMigration,
} from '../scripts/enum-migrations';

const projectRoot = resolve(__dirname, '..');

async function migrationContents(root: string) {
  const directory = join(root, 'database', 'migrations');
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        await readFile(join(directory, name), 'utf8'),
      ]),
    ),
  );
}

describe('versioned enum migration generation', () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'hireai-enum-migrations-'));
    await cp(join(projectRoot, 'database'), join(fixtureRoot, 'database'), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('accepts the committed snapshot for the current canonical schema', async () => {
    await expect(
      assertEnumSnapshotCurrent(projectRoot),
    ).resolves.toBeUndefined();
  });

  it('leaves the snapshot and versioned SQL unchanged when generation is repeated', async () => {
    const previousSql = await migrationContents(fixtureRoot);
    const snapshotPath = join(fixtureRoot, 'database', 'enums.snapshot.json');
    const previousSnapshot = await readFile(snapshotPath, 'utf8');
    const first = await generateEnumMigration(fixtureRoot);
    const second = await generateEnumMigration(fixtureRoot);
    expect(first.changed).toBe(false);
    expect(second.changed).toBe(false);
    expect(first.migrationPath).toBeUndefined();
    expect(second.migrationPath).toBeUndefined();
    expect(await migrationContents(fixtureRoot)).toEqual(previousSql);
    expect(await readFile(snapshotPath, 'utf8')).toBe(previousSnapshot);
  });

  it('appends a migration for a proposed role without rewriting previous migrations', async () => {
    const previousSql = await migrationContents(fixtureRoot);
    const proposedSchema = buildEnumSnapshot();
    const roles = proposedSchema.columns.find(
      (column) => column.enumName === 'Role',
    );
    if (!roles) throw new Error('Role persistence mapping is missing');
    roles.values.push('FUTURE_AUDITOR');
    const result = await generateEnumMigration(fixtureRoot, proposedSchema);
    expect(result.changed).toBe(true);
    if (!result.migrationPath) throw new Error('Expected a new migration file');
    const currentSql = await migrationContents(fixtureRoot);
    expect(Object.keys(currentSql)).toHaveLength(
      Object.keys(previousSql).length + 1,
    );
    for (const [name, sql] of Object.entries(previousSql)) {
      expect(currentSql[name]).toBe(sql);
    }
    const migration = currentSql[basename(result.migrationPath)];
    expect(migration).toContain("'FUTURE_AUDITOR'");
    expect(migration).toMatch(/ALTER TABLE\s+"?users"?/i);
    await expect(
      assertEnumSnapshotCurrent(fixtureRoot, proposedSchema),
    ).resolves.toBeUndefined();
    const retry = await generateEnumMigration(fixtureRoot, proposedSchema);
    expect(retry.changed).toBe(false);
    expect(await migrationContents(fixtureRoot)).toEqual(currentSql);
  });

  it('makes the --check command fail when a committed snapshot drifts', async () => {
    const staleSnapshot = buildEnumSnapshot();
    const roles = staleSnapshot.columns.find(
      (column) => column.enumName === 'Role',
    );
    if (!roles) throw new Error('Role persistence mapping is missing');
    roles.values.pop();
    await writeFile(
      join(fixtureRoot, 'database', 'enums.snapshot.json'),
      `${JSON.stringify(staleSnapshot, null, 2)}\n`,
    );
    await expect(assertEnumSnapshotCurrent(fixtureRoot)).rejects.toThrow();
    const result = spawnSync(
      process.execPath,
      [
        require.resolve('tsx/cli'),
        join(projectRoot, 'scripts', 'generate-enum-migration.ts'),
        '--check',
      ],
      { cwd: fixtureRoot, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('enums:generate');
  });
});
