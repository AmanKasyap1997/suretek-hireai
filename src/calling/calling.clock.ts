import { Injectable } from '@nestjs/common';

/** A replaceable clock makes calling-window checks deterministic in tests. */
@Injectable()
export class CallingClock {
  now(): Date {
    return new Date();
  }
}
