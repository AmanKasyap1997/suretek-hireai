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

export function isWithinCallingWindow(
  policy: CallingPolicy,
  now = new Date(),
): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: policy.timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')!.value);
  const minute = Number(parts.find((part) => part.type === 'minute')!.value);
  const localMinute = hour * 60 + minute;
  return localMinute >= policy.startMinute && localMinute < policy.endMinute;
}
