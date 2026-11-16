import { useApiFixture } from '../helpers/api-fixtures';
import { randomUUID } from 'node:crypto';
import {
  Role,
  JobStatus,
  ApplicationStage,
  OfferStatus,
  EmployeeStatus,
  ConsentScope,
  CallLanguage,
  CallRequestStatus,
  LeaveType,
  LeaveStatus,
} from '../../src/shared/enums';

describe('PostgreSQL-backed API invariants', () => {
  const fixture = useApiFixture();

  it('keeps every persisted enum constraint and default aligned with the canonical values', async () => {
    const { pool } = fixture;
    const columns: Array<{
      table: string;
      column: string;
      values: string[];
      defaultValue?: string;
    }> = [
      { table: 'users', column: 'role', values: Object.values(Role) },
      {
        table: 'jobs',
        column: 'status',
        values: Object.values(JobStatus),
        defaultValue: JobStatus.DRAFT,
      },
      {
        table: 'applications',
        column: 'stage',
        values: Object.values(ApplicationStage),
        defaultValue: ApplicationStage.APPLIED,
      },
      {
        table: 'offers',
        column: 'status',
        values: Object.values(OfferStatus),
        defaultValue: OfferStatus.DRAFT,
      },
      {
        table: 'employees',
        column: 'status',
        values: Object.values(EmployeeStatus),
        defaultValue: EmployeeStatus.ACTIVE,
      },
      {
        table: 'consents',
        column: 'scope',
        values: Object.values(ConsentScope),
      },
      {
        table: 'call_requests',
        column: 'language',
        values: Object.values(CallLanguage),
      },
      {
        table: 'call_requests',
        column: 'status',
        values: Object.values(CallRequestStatus),
        defaultValue: CallRequestStatus.PLANNED,
      },
      {
        table: 'leave_requests',
        column: 'type',
        values: Object.values(LeaveType),
      },
      {
        table: 'leave_requests',
        column: 'status',
        values: Object.values(LeaveStatus),
        defaultValue: LeaveStatus.PENDING,
      },
    ];
    for (const column of columns) {
      const constraint = await pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid=$1::regclass AND conname=$2 AND contype='c'`,
        [column.table, `${column.table}_${column.column}_check`],
      );
      expect(constraint.rows).toHaveLength(1);
      const persistedValues = Array.from(
        constraint.rows[0].definition.matchAll(/'([^']*)'/g),
        (match) => match[1],
      );
      expect(persistedValues.sort()).toEqual([...column.values].sort());
      const defaults = await pool.query<{ expression: string }>(
        `SELECT pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attrdef d
         JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
         WHERE d.adrelid=$1::regclass AND a.attname=$2`,
        [column.table, column.column],
      );
      expect(defaults.rows[0]?.expression.match(/'([^']*)'/)?.[1]).toBe(
        column.defaultValue,
      );
    }
  });

  it('accepts every canonical role in PostgreSQL and rejects an undeclared role', async () => {
    const { pool, tenantA, adminA } = fixture;
    const hash = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE tenant_id=$1 AND id=$2',
      [tenantA, adminA.id],
    );
    const accepted = await pool.query<{ role: string }>(
      `INSERT INTO users(tenant_id,email,password_hash,full_name,role,active)
       SELECT $1,gen_random_uuid()::text || '@example.test',$2,'Canonical role fixture',role,false
       FROM unnest($3::text[]) AS canonical(role) RETURNING role`,
      [tenantA, hash.rows[0].password_hash, Object.values(Role)],
    );
    expect(accepted.rows.map((row) => row.role).sort()).toEqual(
      Object.values(Role).sort(),
    );
    await expect(
      pool.query(
        `INSERT INTO users(tenant_id,email,password_hash,full_name,role,active)
       VALUES($1,$2,$3,'Invalid role fixture',$4,false)`,
        [
          tenantA,
          `${randomUUID()}@example.test`,
          hash.rows[0].password_hash,
          'NOT_A_PLATFORM_ROLE',
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
