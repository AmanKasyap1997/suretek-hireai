/** Canonical persisted values. Generate a migration after changing these enums. */
export enum Role {
  SUPER_ADMIN = 'SUPER_ADMIN',
  HR_ADMIN = 'HR_ADMIN',
  RECRUITER = 'RECRUITER',
  HIRING_MANAGER = 'HIRING_MANAGER',
  INTERVIEWER = 'INTERVIEWER',
  CANDIDATE = 'CANDIDATE',
  EMPLOYEE = 'EMPLOYEE',
  REPORTING_MANAGER = 'REPORTING_MANAGER',
  PAYROLL_FINANCE = 'PAYROLL_FINANCE',
  IT_ASSET_ADMIN = 'IT_ASSET_ADMIN',
}

export enum JobStatus {
  DRAFT = 'DRAFT',
  APPROVED = 'APPROVED',
  PUBLISHED = 'PUBLISHED',
  CLOSED = 'CLOSED',
}

export enum ApplicationStage {
  APPLIED = 'APPLIED',
  SHORTLISTED = 'SHORTLISTED',
  INTERVIEW = 'INTERVIEW',
  OFFER = 'OFFER',
  HIRED = 'HIRED',
  REJECTED = 'REJECTED',
}

export enum OfferStatus {
  DRAFT = 'DRAFT',
  APPROVED = 'APPROVED',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  WITHDRAWN = 'WITHDRAWN',
  EXPIRED = 'EXPIRED',
}

export enum EmployeeStatus {
  ACTIVE = 'ACTIVE',
  EXITED = 'EXITED',
}

export enum ConsentScope {
  CALL = 'CALL',
  RECORDING = 'RECORDING',
  TRANSCRIPTION = 'TRANSCRIPTION',
}

export enum CallLanguage {
  EN = 'EN',
  HI = 'HI',
}

export enum CallRequestStatus {
  PLANNED = 'PLANNED',
  CANCELLED = 'CANCELLED',
}

export enum LeaveType {
  ANNUAL = 'ANNUAL',
  SICK = 'SICK',
  UNPAID = 'UNPAID',
}

export enum LeaveStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum AssignmentRole {
  HIRING_MANAGER = 'HIRING_MANAGER',
  INTERVIEWER = 'INTERVIEWER',
  RECRUITER_OWNER = 'RECRUITER_OWNER',
}
export enum RejectionReason {
  QUALIFICATIONS = 'QUALIFICATIONS',
  EXPERIENCE = 'EXPERIENCE',
  COMPENSATION = 'COMPENSATION',
  OTHER = 'OTHER',
}
export enum EmploymentType {
  FULL_TIME = 'FULL_TIME',
  PART_TIME = 'PART_TIME',
  CONTRACT = 'CONTRACT',
  INTERN = 'INTERN',
}
