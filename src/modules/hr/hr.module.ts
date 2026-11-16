import { Module } from '@nestjs/common';
import { AttendanceModule } from './attendance';
import { EmployeesModule } from './employees';
import { HrProvisioningService } from './hr-provisioning.service';
import { LeaveModule } from './leave';
import { OnboardingModule } from './onboarding';

@Module({
  imports: [EmployeesModule, OnboardingModule, LeaveModule, AttendanceModule],
  providers: [HrProvisioningService],
  exports: [HrProvisioningService],
})
export class HrModule {}
