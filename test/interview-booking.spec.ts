import {
  CallSetup,
  callInstructions,
  callToolsFor,
  openSlots,
} from '../src/modules/talent-acquisition';

const setup = {
  minutes: 45 as const,
  days: [1, 2, 3, 4, 5],
  startMinute: 10 * 60,
  endMinute: 17 * 60,
};
// Tuesday 1 December 2026, 10:00 in India.
const now = new Date('2026-12-01T04:30:00Z');
const ist = (local: string) => new Date(`${local}+05:30`);

describe('interview times offered on a booking call', () => {
  it('offers the earliest free time on each of the next days', () => {
    const slots = openSlots({
      setup,
      timezone: 'Asia/Kolkata',
      now,
      busy: [],
    });
    expect(slots.map((s) => s.startsAt)).toEqual([
      ist('2026-12-02T10:00:00').toISOString(),
      ist('2026-12-03T10:00:00').toISOString(),
      ist('2026-12-04T10:00:00').toISOString(),
    ]);
    expect(slots[0]).toMatchObject({
      id: 's1',
      label: 'Wednesday 2 December at 10:00 AM',
      endsAt: ist('2026-12-02T10:45:00').toISOString(),
    });
  });

  it('skips times the panel is busy, weekends, and days without a free time', () => {
    const slots = openSlots({
      setup,
      timezone: 'Asia/Kolkata',
      // Friday 4 December, 10:00 in India.
      now: ist('2026-12-04T10:00:00'),
      busy: [
        // Monday morning is taken until noon.
        {
          start: ist('2026-12-07T09:00:00'),
          end: ist('2026-12-07T12:00:00'),
        },
        // All of Tuesday.
        {
          start: ist('2026-12-08T00:00:00'),
          end: ist('2026-12-09T00:00:00'),
        },
      ],
    });
    expect(slots.map((s) => s.label)).toEqual([
      'Monday 7 December at 12:00 PM',
      'Wednesday 9 December at 10:00 AM',
      'Thursday 10 December at 10:00 AM',
    ]);
  });

  it('fills up from fewer days, at least two hours apart, and offers nothing when the panel is full', () => {
    const wednesdays = openSlots({
      setup: { ...setup, days: [3] },
      timezone: 'Asia/Kolkata',
      now,
      busy: [],
    });
    expect(wednesdays.map((s) => s.label)).toEqual([
      'Wednesday 2 December at 10:00 AM',
      'Wednesday 2 December at 12:00 PM',
      'Wednesday 9 December at 10:00 AM',
    ]);
    expect(
      openSlots({
        setup,
        timezone: 'Asia/Kolkata',
        now,
        busy: [{ start: now, end: new Date(now.getTime() + 30 * 86_400_000) }],
      }),
    ).toEqual([]);
  });
});

describe('the booking call', () => {
  const booking: CallSetup = {
    organization: 'Acme',
    assistantName: 'Meera',
    job: {
      title: 'Backend Developer',
      department: 'Engineering',
      location: 'Noida',
      description: 'Build APIs.',
    },
    candidateFirstName: 'Priya',
    language: 'EN',
    questions: [],
    recording: true,
    transcription: true,
    maxSeconds: 600,
    test: false,
    callingHours: null,
    booking: {
      round: 'Final round',
      minutes: 45,
      mode: 'VIDEO',
      location: null,
      slots: [
        { id: 's1', label: 'Wednesday 2 December at 10:00 AM' },
        { id: 's2', label: 'Thursday 3 December at 10:00 AM' },
      ],
    },
  };

  it('shares the news and offers only the free times, booking the one chosen', () => {
    const text = callInstructions(booking);
    expect(text).toContain(
      'they’ve been shortlisted for the Final round interview, a 45-minute video call',
    );
    expect(text).toContain('call book_interview with its id');
    expect(text).toContain('calendar invitation by email with the video link');
    expect(text).toContain('offer only these; never make one up');
    expect(text).toContain('- [id: s1] Wednesday 2 December at 10:00 AM');
    // Still checks who answered, and says it's an AI.
    expect(text).toContain('Am I speaking with Priya?');
    expect(text).toContain('you’re an AI assistant');
    expect(text).not.toContain('Questions:');
    expect(callToolsFor(booking).map((t) => t.name)).toEqual([
      'book_interview',
      'end_call',
    ]);
    expect(
      callToolsFor({ ...booking, booking: undefined }).map((t) => t.name),
    ).toEqual(['record_answer', 'end_call']);
  });
});
