import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from './enums';
export { Role } from './enums';
export interface Actor {
  userId: string;
  tenantId: string;
  role: Role;
}
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor =>
    ctx.switchToHttp().getRequest().actor,
);
