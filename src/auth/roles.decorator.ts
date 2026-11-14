import { SetMetadata } from '@nestjs/common';
import { Role } from '../common/actor';
export const ROLES_KEY = 'allowedRoles';
export const PUBLIC_KEY = 'publicRoute';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const Public = () => SetMetadata(PUBLIC_KEY, true);
