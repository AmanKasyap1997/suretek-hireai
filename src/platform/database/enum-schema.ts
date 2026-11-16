import {
  ApplicationStage,
  CallLanguage,
  CallRequestStatus,
  ConsentScope,
  EmployeeStatus,
  JobStatus,
  LeaveStatus,
  LeaveType,
  OfferStatus,
  Role,
} from '../common/enums';

/** Enum-to-column mappings; persisted values belong only in common/enums.ts. */
export interface EnumColumnDefinition {
  enumName: string;
  table: string;
  column: string;
  constraintName: string;
  values: readonly string[];
  defaultValue?: string;
}

/** A conditional evidence rule whose triggering status comes from an enum. */
export interface EnumInvariantDefinition {
  table: string;
  constraintName: string;
  legacyConstraintNames: readonly string[];
  conditionColumn: string;
  conditionValue: string;
  requiredNonNullColumns: readonly string[];
}

export interface EnumSchema {
  columns: readonly EnumColumnDefinition[];
  invariants: readonly EnumInvariantDefinition[];
}

export interface EnumSnapshot {
  version: 1;
  columns: Array<Omit<EnumColumnDefinition, 'values'> & { values: string[] }>;
  invariants: Array<
    Omit<
      EnumInvariantDefinition,
      'legacyConstraintNames' | 'requiredNonNullColumns'
    > & {
      legacyConstraintNames: string[];
      requiredNonNullColumns: string[];
    }
  >;
}

export const enumSchema: EnumSchema = {
  columns: [
    {
      enumName: 'Role',
      table: 'users',
      column: 'role',
      constraintName: 'users_role_check',
      values: Object.values(Role),
    },
    {
      enumName: 'JobStatus',
      table: 'jobs',
      column: 'status',
      constraintName: 'jobs_status_check',
      values: Object.values(JobStatus),
      defaultValue: JobStatus.DRAFT,
    },
    {
      enumName: 'ApplicationStage',
      table: 'applications',
      column: 'stage',
      constraintName: 'applications_stage_check',
      values: Object.values(ApplicationStage),
      defaultValue: ApplicationStage.APPLIED,
    },
    {
      enumName: 'OfferStatus',
      table: 'offers',
      column: 'status',
      constraintName: 'offers_status_check',
      values: Object.values(OfferStatus),
      defaultValue: OfferStatus.DRAFT,
    },
    {
      enumName: 'EmployeeStatus',
      table: 'employees',
      column: 'status',
      constraintName: 'employees_status_check',
      values: Object.values(EmployeeStatus),
      defaultValue: EmployeeStatus.ACTIVE,
    },
    {
      enumName: 'ConsentScope',
      table: 'consents',
      column: 'scope',
      constraintName: 'consents_scope_check',
      values: Object.values(ConsentScope),
    },
    {
      enumName: 'CallLanguage',
      table: 'call_requests',
      column: 'language',
      constraintName: 'call_requests_language_check',
      values: Object.values(CallLanguage),
    },
    {
      enumName: 'CallRequestStatus',
      table: 'call_requests',
      column: 'status',
      constraintName: 'call_requests_status_check',
      values: Object.values(CallRequestStatus),
      defaultValue: CallRequestStatus.PLANNED,
    },
    {
      enumName: 'LeaveType',
      table: 'leave_requests',
      column: 'type',
      constraintName: 'leave_requests_type_check',
      values: Object.values(LeaveType),
    },
    {
      enumName: 'LeaveStatus',
      table: 'leave_requests',
      column: 'status',
      constraintName: 'leave_requests_status_check',
      values: Object.values(LeaveStatus),
      defaultValue: LeaveStatus.PENDING,
    },
  ],
  invariants: [
    {
      table: 'offers',
      constraintName: 'offers_acceptance_evidence_check',
      legacyConstraintNames: ['offers_check'],
      conditionColumn: 'status',
      conditionValue: OfferStatus.ACCEPTED,
      requiredNonNullColumns: ['accepted_at', 'acceptance_reference'],
    },
  ],
};
