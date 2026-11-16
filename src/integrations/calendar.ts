export interface CalendarInterview {
  tenantId: string;
  interviewId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  panelistIds: string[];
}

export interface CalendarResult {
  status: 'disabled';
}

/** Adapter boundary only. Interview scheduling currently persists local records. */
export abstract class CalendarPort {
  abstract schedule(interview: CalendarInterview): Promise<CalendarResult>;
  abstract cancel(
    tenantId: string,
    interviewId: string,
  ): Promise<CalendarResult>;
}

/** Explicitly disabled: no calendar provider is contacted or event created. */
export class DisabledCalendar extends CalendarPort {
  async schedule(interview: CalendarInterview): Promise<CalendarResult> {
    void interview;
    return { status: 'disabled' };
  }

  async cancel(tenantId: string, interviewId: string): Promise<CalendarResult> {
    void tenantId;
    void interviewId;
    return { status: 'disabled' };
  }
}
