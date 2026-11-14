import { createParamDecorator, ExecutionContext } from '@nestjs/common';
export const roles = [
  'SUPER_ADMIN',
  'HR_ADMIN',
  'RECRUITER',
  'HIRING_MANAGER',
  'INTERVIEWER',
  'CANDIDATE',
  'EMPLOYEE',
  'REPORTING_MANAGER',
  'PAYROLL_FINANCE',
  'IT_ASSET_ADMIN',
] as const;
export type Role = (typeof roles)[number];
export interface Actor {
  userId: string;
  tenantId: string;
  role: Role;
}
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor =>
    ctx.switchToHttp().getRequest().actor,
);
