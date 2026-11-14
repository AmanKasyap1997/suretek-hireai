# Shared enum values

[`src/common/enums.ts`](../src/common/enums.ts) is the canonical declaration for `Role`, `JobStatus`, `ApplicationStage`, `OfferStatus`, `EmployeeStatus`, `ConsentScope`, `CallLanguage`, `CallRequestStatus`, `LeaveType` and `LeaveStatus`.

Import enums instead of repeating string literals. Their string values remain the HTTP API and PostgreSQL values, such as `HR_ADMIN` and `SHORTLISTED`.

```ts
import { z } from 'zod';
import { Role } from '../common/enums';

const userSchema = z.object({ role: z.enum(Role) });
const administratorRole: Role = Role.HR_ADMIN;
```

Keep permissions explicit through [`src/auth/role-groups.ts`](../src/auth/role-groups.ts):

```ts
import { Controller } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { ADMIN_ROLES } from '../auth/role-groups';

@Controller('offers')
@Roles(...ADMIN_ROLES)
export class OffersController {}
```

Adding a role makes it a valid stored role, without granting business access. `ADMIN_ROLES` and `RECRUITMENT_ROLES` are deliberate grants; update a group only when the role should receive those permissions. `ALL_ROLES` allows active users to read their own authenticated profile.

## Change values

1. Edit the relevant enum in `src/common/enums.ts`.
2. Run `npm run enums:generate`. This runs offline and writes a new SQL migration plus `database/enums.snapshot.json`.
3. Review and commit the enum source, generated migration and snapshot. Do not edit an already applied migration.
4. Run `npm run enums:check` to detect enum changes that have not been generated, then `npm run db:migrate` to apply the migration.

PostgreSQL uses generated `CHECK` constraints, not native SQL `ENUM` types. The migration runner checks source/snapshot consistency before applying checksummed SQL migrations. The snapshot is generated history; do not maintain another handwritten value list there.

Renaming or removing a persisted value also requires a deliberate data migration and a compatible application rollout. The generator does not replace or delete existing row values. If rows still contain a removed value, the generated constraint migration fails and rolls back.

For a rename, first add the replacement value and migrate while keeping the old value allowed. Then write and apply a data migration to move existing rows, and finally remove the old enum value and generate/apply the narrower constraint. Additions do not change existing HTTP string values.

## Upgrade an existing database

After replacing the starter code with the latest version, keep the existing `.env` and run these commands from the project folder, including in Windows PowerShell:

```powershell
npm ci
npm run db:migrate
```

The new migration updates enum constraints while preserving existing records. Keep the original `001_initial.sql` unchanged. There is no need to reset the database or run bootstrap again.
