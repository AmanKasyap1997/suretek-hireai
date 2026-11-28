export interface CallingPolicy {
  enabled: boolean;
  timezone: string;
  startMinute: number;
  endMinute: number;
}

function minuteOfDay(value: string, name: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${name} must be a 24-hour HH:mm value`);
  }
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function callPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CallingPolicy {
  const enabled = env.CALL_PLANNING_ENABLED ?? 'false';
  if (enabled !== 'true' && enabled !== 'false') {
    throw new Error('CALL_PLANNING_ENABLED must be true or false');
  }
  const timezone = env.CALL_TIMEZONE ?? 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format();
  } catch {
    throw new Error('CALL_TIMEZONE must be a valid IANA timezone');
  }
  const startMinute = minuteOfDay(
    env.CALL_WINDOW_START ?? '09:00',
    'CALL_WINDOW_START',
  );
  const endMinute = minuteOfDay(
    env.CALL_WINDOW_END ?? '18:00',
    'CALL_WINDOW_END',
  );
  if (startMinute >= endMinute) {
    throw new Error(
      'CALL_WINDOW_START must precede CALL_WINDOW_END on the same local day',
    );
  }
  return { enabled: enabled === 'true', timezone, startMinute, endMinute };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function localMinute(timezone: string, now: Date) {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timezone, format);
  }
  const parts = format.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')!.value);
  const minute = Number(parts.find((part) => part.type === 'minute')!.value);
  return hour * 60 + minute;
}

export function isWithinCallingWindow(
  policy: CallingPolicy,
  now = new Date(),
): boolean {
  const minute = localMinute(policy.timezone, now);
  return minute >= policy.startMinute && minute < policy.endMinute;
}

/**
 * The earliest time from `from` that is inside every calling window: `from`
 * itself, or the start of the next window. Null if the windows never overlap.
 */
export function nextCallingTime(
  policies: CallingPolicy[],
  from: Date,
): Date | null {
  const inside = (time: Date) =>
    policies.every((policy) => isWithinCallingWindow(policy, time));
  if (inside(from)) return from;
  let time = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (inside(time)) return time;
    time = new Date(time.getTime() + 60_000);
  }
  return null;
}
