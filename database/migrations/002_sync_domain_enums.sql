-- Generated from src/common/enums.ts by npm run enums:generate.
-- Commit this migration and database/enums.snapshot.json together.
-- Renamed/removed values require an explicit preceding data migration.
-- Never edit migrations that have already been applied.

ALTER TABLE "applications" DROP CONSTRAINT IF EXISTS "applications_stage_check";
ALTER TABLE "applications" ADD CONSTRAINT "applications_stage_check" CHECK ("stage" IN (E'APPLIED', E'HIRED', E'INTERVIEW', E'OFFER', E'REJECTED', E'SHORTLISTED'));
ALTER TABLE "applications" ALTER COLUMN "stage" SET DEFAULT E'APPLIED';

ALTER TABLE "call_requests" DROP CONSTRAINT IF EXISTS "call_requests_language_check";
ALTER TABLE "call_requests" ADD CONSTRAINT "call_requests_language_check" CHECK ("language" IN (E'EN', E'HI'));
ALTER TABLE "call_requests" ALTER COLUMN "language" DROP DEFAULT;

ALTER TABLE "call_requests" DROP CONSTRAINT IF EXISTS "call_requests_status_check";
ALTER TABLE "call_requests" ADD CONSTRAINT "call_requests_status_check" CHECK ("status" IN (E'CANCELLED', E'PLANNED'));
ALTER TABLE "call_requests" ALTER COLUMN "status" SET DEFAULT E'PLANNED';

ALTER TABLE "consents" DROP CONSTRAINT IF EXISTS "consents_scope_check";
ALTER TABLE "consents" ADD CONSTRAINT "consents_scope_check" CHECK ("scope" IN (E'CALL', E'RECORDING', E'TRANSCRIPTION'));
ALTER TABLE "consents" ALTER COLUMN "scope" DROP DEFAULT;

ALTER TABLE "employees" DROP CONSTRAINT IF EXISTS "employees_status_check";
ALTER TABLE "employees" ADD CONSTRAINT "employees_status_check" CHECK ("status" IN (E'ACTIVE', E'EXITED'));
ALTER TABLE "employees" ALTER COLUMN "status" SET DEFAULT E'ACTIVE';

ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_status_check";
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_status_check" CHECK ("status" IN (E'APPROVED', E'CLOSED', E'DRAFT', E'PUBLISHED'));
ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT E'DRAFT';

ALTER TABLE "leave_requests" DROP CONSTRAINT IF EXISTS "leave_requests_status_check";
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_status_check" CHECK ("status" IN (E'APPROVED', E'PENDING', E'REJECTED'));
ALTER TABLE "leave_requests" ALTER COLUMN "status" SET DEFAULT E'PENDING';

ALTER TABLE "leave_requests" DROP CONSTRAINT IF EXISTS "leave_requests_type_check";
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_type_check" CHECK ("type" IN (E'ANNUAL', E'SICK', E'UNPAID'));
ALTER TABLE "leave_requests" ALTER COLUMN "type" DROP DEFAULT;

ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_status_check";
ALTER TABLE "offers" ADD CONSTRAINT "offers_status_check" CHECK ("status" IN (E'ACCEPTED', E'APPROVED', E'DRAFT'));
ALTER TABLE "offers" ALTER COLUMN "status" SET DEFAULT E'DRAFT';

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_role_check";
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN (E'CANDIDATE', E'EMPLOYEE', E'HIRING_MANAGER', E'HR_ADMIN', E'INTERVIEWER', E'IT_ASSET_ADMIN', E'PAYROLL_FINANCE', E'RECRUITER', E'REPORTING_MANAGER', E'SUPER_ADMIN'));
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_check";
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_acceptance_evidence_check";
ALTER TABLE "offers" ADD CONSTRAINT "offers_acceptance_evidence_check" CHECK ("status" <> E'ACCEPTED' OR ("acceptance_reference" IS NOT NULL AND "accepted_at" IS NOT NULL));
