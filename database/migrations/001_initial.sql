-- Tenant-safe keys deliberately repeat tenant_id on every business relationship.
-- Application queries must still filter by the authenticated tenant; these foreign
-- keys additionally stop accidental cross-tenant writes.
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  password_hash text NOT NULL,
  full_name text NOT NULL CHECK (length(trim(full_name)) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER', 'HIRING_MANAGER', 'INTERVIEWER', 'CANDIDATE', 'EMPLOYEE', 'REPORTING_MANAGER', 'PAYROLL_FINANCE', 'IT_ASSET_ADMIN')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX users_tenant_email_unique ON users (tenant_id, lower(email));

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description text NOT NULL,
  department text NOT NULL,
  location text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'PUBLISHED', 'CLOSED')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX jobs_tenant_status_idx ON jobs(tenant_id, status, created_at DESC);

CREATE TABLE candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  full_name text NOT NULL CHECK (length(trim(full_name)) BETWEEN 1 AND 200),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX candidates_tenant_email_unique ON candidates(tenant_id, lower(email));
CREATE INDEX candidates_tenant_created_idx ON candidates(tenant_id, created_at DESC);

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  job_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  stage text NOT NULL DEFAULT 'APPLIED' CHECK (stage IN ('APPLIED', 'SHORTLISTED', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, job_id, candidate_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates(tenant_id, id)
);
CREATE INDEX applications_tenant_stage_idx ON applications(tenant_id, stage, created_at DESC);
CREATE INDEX applications_tenant_candidate_idx ON applications(tenant_id, candidate_id);

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  application_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'ACCEPTED')),
  annual_ctc numeric(14,2) NOT NULL CHECK (annual_ctc > 0),
  currency varchar(3) NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  joining_date date NOT NULL,
  created_by uuid NOT NULL,
  approved_by uuid,
  accepted_at timestamptz,
  acceptance_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, application_id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id),
  CHECK (status <> 'ACCEPTED' OR (accepted_at IS NOT NULL AND acceptance_reference IS NOT NULL))
);

CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  candidate_id uuid NOT NULL,
  source_offer_id uuid NOT NULL,
  employee_code text NOT NULL,
  full_name text NOT NULL,
  email text NOT NULL,
  joining_date date NOT NULL,
  annual_ctc numeric(14,2) NOT NULL CHECK (annual_ctc > 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXITED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, candidate_id),
  UNIQUE (tenant_id, source_offer_id),
  UNIQUE (tenant_id, employee_code),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates(tenant_id, id),
  FOREIGN KEY (tenant_id, source_offer_id) REFERENCES offers(tenant_id, id)
);
CREATE INDEX employees_tenant_status_idx ON employees(tenant_id, status, created_at DESC);

CREATE TABLE onboarding_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  employee_id uuid NOT NULL,
  title text NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX onboarding_tasks_employee_idx ON onboarding_tasks(tenant_id, employee_id);

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  candidate_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('CALL', 'RECORDING', 'TRANSCRIPTION')),
  granted boolean NOT NULL,
  source text NOT NULL CHECK (length(trim(source)) BETWEEN 1 AND 1000),
  captured_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates(tenant_id, id),
  FOREIGN KEY (tenant_id, captured_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX consents_current_idx ON consents(tenant_id, candidate_id, scope, sequence_id DESC);

CREATE TABLE call_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  application_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  language text NOT NULL CHECK (language IN ('EN', 'HI')),
  recording boolean NOT NULL DEFAULT false,
  transcription boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'CANCELLED')),
  idempotency_key varchar(100) NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX call_requests_tenant_status_idx ON call_requests(tenant_id, status, created_at DESC);

CREATE TABLE leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  employee_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('ANNUAL', 'SICK', 'UNPAID')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  requested_by uuid NOT NULL,
  reviewed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by) REFERENCES users(tenant_id, id),
  CHECK (end_date >= start_date)
);
CREATE INDEX leave_requests_tenant_status_idx ON leave_requests(tenant_id, status, created_at DESC);

CREATE TABLE attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  employee_id uuid NOT NULL,
  work_date date NOT NULL,
  check_in timestamptz NOT NULL,
  check_out timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  CHECK (check_out IS NULL OR check_out >= check_in)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX audit_events_tenant_created_idx ON audit_events(tenant_id, created_at DESC);
