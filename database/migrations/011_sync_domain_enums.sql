-- Generated from src/shared/enums.ts by npm run enums:generate.
-- Commit this migration and database/enums.snapshot.json together.
-- Renamed/removed values require an explicit preceding data migration.
-- Never edit migrations that have already been applied.

ALTER TABLE "application_stage_events" DROP CONSTRAINT IF EXISTS "application_stage_events_from_stage_check";
ALTER TABLE "application_stage_events" ADD CONSTRAINT "application_stage_events_from_stage_check" CHECK ("from_stage" IN (E'APPLIED', E'HIRED', E'INTERVIEW', E'OFFER', E'REJECTED', E'SHORTLISTED'));
ALTER TABLE "application_stage_events" ALTER COLUMN "from_stage" DROP DEFAULT;

ALTER TABLE "application_stage_events" DROP CONSTRAINT IF EXISTS "application_stage_events_reason_code_check";
ALTER TABLE "application_stage_events" ADD CONSTRAINT "application_stage_events_reason_code_check" CHECK ("reason_code" IN (E'COMPENSATION', E'EXPERIENCE', E'OTHER', E'QUALIFICATIONS'));
ALTER TABLE "application_stage_events" ALTER COLUMN "reason_code" DROP DEFAULT;

ALTER TABLE "application_stage_events" DROP CONSTRAINT IF EXISTS "application_stage_events_to_stage_check";
ALTER TABLE "application_stage_events" ADD CONSTRAINT "application_stage_events_to_stage_check" CHECK ("to_stage" IN (E'APPLIED', E'HIRED', E'INTERVIEW', E'OFFER', E'REJECTED', E'SHORTLISTED'));
ALTER TABLE "application_stage_events" ALTER COLUMN "to_stage" DROP DEFAULT;

ALTER TABLE "applications" DROP CONSTRAINT IF EXISTS "applications_stage_check";
ALTER TABLE "applications" ADD CONSTRAINT "applications_stage_check" CHECK ("stage" IN (E'APPLIED', E'HIRED', E'INTERVIEW', E'OFFER', E'REJECTED', E'SHORTLISTED'));
ALTER TABLE "applications" ALTER COLUMN "stage" SET DEFAULT E'APPLIED';

ALTER TABLE "call_requests" DROP CONSTRAINT IF EXISTS "call_requests_language_check";
ALTER TABLE "call_requests" ADD CONSTRAINT "call_requests_language_check" CHECK ("language" IN (E'EN', E'HI'));
ALTER TABLE "call_requests" ALTER COLUMN "language" DROP DEFAULT;

ALTER TABLE "call_requests" DROP CONSTRAINT IF EXISTS "call_requests_status_check";
ALTER TABLE "call_requests" ADD CONSTRAINT "call_requests_status_check" CHECK ("status" IN (E'CANCELLED', E'PLANNED'));
ALTER TABLE "call_requests" ALTER COLUMN "status" SET DEFAULT E'PLANNED';

ALTER TABLE "candidate_documents" DROP CONSTRAINT IF EXISTS "candidate_documents_scan_status_check";
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_scan_status_check" CHECK ("scan_status" IN (E'CLEAN', E'ERROR', E'FAILED', E'INFECTED', E'PENDING'));
ALTER TABLE "candidate_documents" ALTER COLUMN "scan_status" SET DEFAULT E'PENDING';

ALTER TABLE "consents" DROP CONSTRAINT IF EXISTS "consents_scope_check";
ALTER TABLE "consents" ADD CONSTRAINT "consents_scope_check" CHECK ("scope" IN (E'CALL', E'RECORDING', E'TRANSCRIPTION'));
ALTER TABLE "consents" ALTER COLUMN "scope" DROP DEFAULT;

ALTER TABLE "consents" DROP CONSTRAINT IF EXISTS "consents_verification_method_check";
ALTER TABLE "consents" ADD CONSTRAINT "consents_verification_method_check" CHECK ("verification_method" IN (E'EMAIL_TOKEN'));
ALTER TABLE "consents" ALTER COLUMN "verification_method" DROP DEFAULT;

ALTER TABLE "employees" DROP CONSTRAINT IF EXISTS "employees_status_check";
ALTER TABLE "employees" ADD CONSTRAINT "employees_status_check" CHECK ("status" IN (E'ACTIVE', E'EXITED'));
ALTER TABLE "employees" ALTER COLUMN "status" SET DEFAULT E'ACTIVE';

ALTER TABLE "interview_panelists" DROP CONSTRAINT IF EXISTS "interview_panelists_status_check";
ALTER TABLE "interview_panelists" ADD CONSTRAINT "interview_panelists_status_check" CHECK ("status" IN (E'CANCELLED', E'SCHEDULED'));
ALTER TABLE "interview_panelists" ALTER COLUMN "status" SET DEFAULT E'SCHEDULED';

ALTER TABLE "interview_scorecards" DROP CONSTRAINT IF EXISTS "interview_scorecards_recommendation_check";
ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_recommendation_check" CHECK ("recommendation" IN (E'HIRE', E'HOLD', E'NO_HIRE', E'STRONG_HIRE', E'STRONG_NO_HIRE'));
ALTER TABLE "interview_scorecards" ALTER COLUMN "recommendation" DROP DEFAULT;

ALTER TABLE "interviews" DROP CONSTRAINT IF EXISTS "interviews_mode_check";
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_mode_check" CHECK ("mode" IN (E'ONSITE', E'PHONE', E'VIDEO'));
ALTER TABLE "interviews" ALTER COLUMN "mode" DROP DEFAULT;

ALTER TABLE "interviews" DROP CONSTRAINT IF EXISTS "interviews_status_check";
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_status_check" CHECK ("status" IN (E'CANCELLED', E'SCHEDULED'));
ALTER TABLE "interviews" ALTER COLUMN "status" SET DEFAULT E'SCHEDULED';

ALTER TABLE "job_assignments" DROP CONSTRAINT IF EXISTS "job_assignments_role_check";
ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_role_check" CHECK ("role" IN (E'HIRING_MANAGER', E'INTERVIEWER', E'RECRUITER_OWNER'));
ALTER TABLE "job_assignments" ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_employment_type_check";
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_employment_type_check" CHECK ("employment_type" IN (E'CONTRACT', E'FULL_TIME', E'INTERN', E'PART_TIME'));
ALTER TABLE "jobs" ALTER COLUMN "employment_type" SET DEFAULT E'FULL_TIME';

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
ALTER TABLE "offers" ADD CONSTRAINT "offers_status_check" CHECK ("status" IN (E'ACCEPTED', E'APPROVED', E'DECLINED', E'DRAFT', E'EXPIRED', E'WITHDRAWN'));
ALTER TABLE "offers" ALTER COLUMN "status" SET DEFAULT E'DRAFT';

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_role_check";
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN (E'CANDIDATE', E'EMPLOYEE', E'HIRING_MANAGER', E'HR_ADMIN', E'INTERVIEWER', E'IT_ASSET_ADMIN', E'PAYROLL_FINANCE', E'RECRUITER', E'REPORTING_MANAGER', E'SUPER_ADMIN'));
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_check";
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_acceptance_evidence_check";
ALTER TABLE "offers" ADD CONSTRAINT "offers_acceptance_evidence_check" CHECK ("status" <> E'ACCEPTED' OR ("acceptance_reference" IS NOT NULL AND "accepted_at" IS NOT NULL));
