import { BadRequestException } from '@nestjs/common';
import {
  applicationFieldsSchema,
  CareersService,
  intakeSchema,
  readSubmission,
} from '../src/modules/talent-acquisition';
import { CaptchaPort, EmailPort } from '../src/integrations';
import { DbService } from '../src/platform/database/db.service';

type DocumentsService = ConstructorParameters<typeof CareersService>[2];
type ContactVerificationService = ConstructorParameters<
  typeof CareersService
>[3];
type ScreeningService = NonNullable<
  ConstructorParameters<typeof CareersService>[5]
>;

const pdf = Buffer.from('%PDF-1.7\nSample resume\n%%EOF');
const form = {
  fullName: 'Asha Verma',
  email: 'Asha@Example.test',
  phone: '+919876543210',
  currentLocation: 'Noida',
  totalExperienceMonths: 54,
  noticePeriod: 'SERVING_NOTICE',
  lastWorkingDay: '2026-12-31',
  currentCtc: 900000,
  expectedCtc: 1300000,
  currentCompany: 'Acme Software',
  currentTitle: 'Software Engineer',
  linkedinUrl: 'https://www.linkedin.com/in/asha-verma',
  portfolioUrl: '',
  coverLetter: '',
  source: 'REFERRAL',
  referrer: 'Rahul Sharma',
  willingToRelocate: true,
  privacyAccepted: true,
  noticeVersion: '2026-11-v1',
};

describe('apply form fields', () => {
  it('accepts a complete application and treats blank optional answers as none', () => {
    const parsed = applicationFieldsSchema.parse(form);
    expect(parsed).toMatchObject({
      email: 'asha@example.test',
      ctcCurrency: 'INR',
      source: 'REFERRAL',
      consents: { CALL: false, RECORDING: false, TRANSCRIPTION: false },
    });
    expect(parsed.portfolioUrl).toBeUndefined();
    expect(parsed.coverLetter).toBeUndefined();
  });

  it.each([
    ['phone', { phone: '9876543210' }],
    ['currentLocation', { currentLocation: '' }],
    ['totalExperienceMonths', { totalExperienceMonths: 2.5 }],
    ['noticePeriod', { noticePeriod: 'SOON' }],
    ['expectedCtc', { expectedCtc: 0 }],
    ['privacyAccepted', { privacyAccepted: false }],
    ['linkedinUrl', { linkedinUrl: 'https://example.com/in/asha' }],
    ['portfolioUrl', { portfolioUrl: 'javascript:alert(1)' }],
    ['lastWorkingDay', { noticePeriod: 'DAYS_30' }],
    ['referrer', { source: 'LINKEDIN' }],
    ['coverLetter', { coverLetter: 'x'.repeat(4001) }],
  ])('rejects an invalid %s', (path, change) => {
    const result = applicationFieldsSchema.safeParse({ ...form, ...change });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      path,
    );
  });

  it.each([
    'fullName',
    'email',
    'phone',
    'currentLocation',
    'totalExperienceMonths',
    'noticePeriod',
    'expectedCtc',
    'privacyAccepted',
  ])('requires %s', (field) => {
    const rest = Object.fromEntries(
      Object.entries(form).filter(([name]) => name !== field),
    );
    expect(applicationFieldsSchema.safeParse(rest).success).toBe(false);
  });

  it('requires a resume in the JSON form of the request', () => {
    expect(intakeSchema.safeParse(form).success).toBe(false);
    expect(
      intakeSchema.safeParse({
        ...form,
        resume: { filename: 'cv.pdf', base64: pdf.toString('base64') },
      }).success,
    ).toBe(true);
  });
});

describe('reading a submission', () => {
  const multipart = { is: (type: string) => type === 'multipart/form-data' };
  const json = { is: () => false };

  it('reads form fields from the multipart application part and the resume file', () => {
    const { fields, resume } = readSubmission(
      multipart as never,
      { application: JSON.stringify(form) },
      { originalname: 'cv.pdf', buffer: pdf },
    );
    expect(fields.fullName).toBe('Asha Verma');
    expect(resume).toEqual({ originalname: 'cv.pdf', buffer: pdf });
  });

  it('refuses a multipart request without JSON form fields', () => {
    for (const body of [{}, { application: '{not json' }])
      expect(() => readSubmission(multipart as never, body, undefined)).toThrow(
        BadRequestException,
      );
  });

  it('decodes the base64 resume of a JSON request', () => {
    const { fields, resume } = readSubmission(
      json as never,
      {
        ...form,
        resume: { filename: 'cv.pdf', base64: pdf.toString('base64') },
      },
      undefined,
    );
    expect(fields).not.toHaveProperty('resume');
    expect(resume).toEqual({ originalname: 'cv.pdf', buffer: pdf });
  });
});

describe('public careers service', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = {
      DATABASE_URL: 'postgresql://runtime:password@localhost:5432/hireai',
      JWT_SECRET: 'a-test-only-secret-with-at-least-thirty-two-characters',
      INTAKE_NOTICE_VERSION: '2026-11-v1',
    };
  });
  afterEach(() => {
    process.env = originalEnv;
  });
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const jobId = '33333333-3333-4333-8333-333333333333';
  let details: unknown[] | null;
  let written: number;
  let resumeFor: unknown;
  let email: { sendRepeatApplication: jest.Mock };
  let screening: { automatic: jest.Mock };
  const appliedAt = new Date('2026-11-20T10:00:00Z');

  /** `repeat`: this email already applied; `due`: no notice in the last day. */
  const setup = ({ repeat = false, due = true } = {}) => {
    details = null;
    written = 0;
    const tx = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.startsWith('INSERT INTO application_details')) details = params;
        return [];
      }),
      one: jest.fn(async (sql: string) => {
        if (sql.includes('FROM applications a'))
          return {
            id: 'app-1',
            created_at: appliedAt,
            title: 'Full Stack Developer',
            email: 'asha@example.test',
            organization: 'Suretek Infosoft',
          };
        if (sql.startsWith('INSERT INTO application_repeat_notices'))
          return due ? { application_id: 'app-1' } : null;
        if (sql.includes('FROM jobs')) return { id: jobId };
        if (sql.startsWith('INSERT INTO candidates'))
          return repeat ? null : { id: 'cand-1' };
        if (sql.startsWith('SELECT id FROM candidates'))
          return { id: 'cand-1' };
        if (sql.startsWith('INSERT INTO applications'))
          return repeat ? null : { id: 'app-1' };
        if (sql.startsWith('INSERT INTO consents')) return { id: 'consent' };
        if (sql.startsWith('INSERT INTO public_intake_limits'))
          return { id: 'hit' };
        return null;
      }),
    };
    const db = {
      one: jest.fn(async (sql: string) => {
        if (sql.includes('resolve_public_tenant')) return { id: tenantId };
        if (sql.includes('FROM tenants')) return { name: 'Suretek Infosoft' };
        if (sql.includes('FROM jobs')) return { id: jobId, title: 'QA' };
        return null;
      }),
      query: jest.fn(async () => []),
      transaction: jest.fn(async (fn: (client: typeof tx) => unknown) =>
        fn(tx),
      ),
    } as unknown as DbService;
    const captcha = { verify: jest.fn(async () => true) } as CaptchaPort;
    const documents = {
      write: jest.fn(async (...args: unknown[]) => {
        written++;
        resumeFor = args[5];
      }),
      cleanup: jest.fn(async () => undefined),
    } as unknown as DocumentsService;
    const verification = {
      issue: jest.fn(async () => undefined),
      dispatch: jest.fn(async () => undefined),
    } as unknown as ContactVerificationService;
    email = { sendRepeatApplication: jest.fn(async () => true) };
    screening = { automatic: jest.fn() };
    return new CareersService(
      db,
      captcha,
      documents,
      verification,
      email as unknown as EmailPort,
      screening as unknown as ScreeningService,
    );
  };
  const fields = () => applicationFieldsSchema.parse(form);

  it('stores what the candidate entered with the new application', async () => {
    const careers = setup();
    await expect(
      careers.apply(
        'suretek',
        jobId,
        fields(),
        { originalname: 'cv.pdf', buffer: pdf },
        '192.0.2.1',
        'test',
      ),
    ).resolves.toEqual({
      message: 'Your application submission has been received.',
    });
    expect(details).toEqual([
      tenantId,
      'app-1',
      '+919876543210',
      'Noida',
      true,
      54,
      'Acme Software',
      'Software Engineer',
      'SERVING_NOTICE',
      '2026-12-31',
      900000,
      1300000,
      'INR',
      'https://www.linkedin.com/in/asha-verma',
      null,
      null,
      'REFERRAL',
      'Rahul Sharma',
    ]);
    expect(written).toBe(1);
    // The resume belongs to this application.
    expect(resumeFor).toBe('app-1');
    // Queued after the application is saved, without delaying the reply.
    expect(screening.automatic).toHaveBeenCalledWith(tenantId, 'app-1');
  });

  it('answers a repeat like a new application, saves nothing and tells the address on file', async () => {
    const careers = setup({ repeat: true });
    await expect(
      careers.apply(
        'suretek',
        jobId,
        fields(),
        { originalname: 'cv.pdf', buffer: pdf },
        '192.0.2.1',
        'test',
      ),
    ).resolves.toEqual({
      message: 'Your application submission has been received.',
    });
    expect(details).toBeNull();
    expect(written).toBe(0);
    expect(screening.automatic).not.toHaveBeenCalled();
    expect(email.sendRepeatApplication).toHaveBeenCalledWith({
      to: 'asha@example.test',
      organizationName: 'Suretek Infosoft',
      jobTitle: 'Full Stack Developer',
      appliedAt,
    });
  });

  it('emails about repeats at most once a day', async () => {
    const careers = setup({ repeat: true, due: false });
    await careers.apply(
      'suretek',
      jobId,
      fields(),
      { originalname: 'cv.pdf', buffer: pdf },
      '192.0.2.1',
      'test',
    );
    expect(email.sendRepeatApplication).not.toHaveBeenCalled();
  });

  it('asks for a resume, but quietly drops honeypot submissions', async () => {
    const careers = setup();
    await expect(
      careers.apply('suretek', jobId, fields(), undefined, '192.0.2.1', 'test'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      careers.apply(
        'suretek',
        jobId,
        { ...fields(), website: 'bot.example' },
        undefined,
        '192.0.2.1',
        'test',
      ),
    ).resolves.toHaveProperty('message');
    expect(details).toBeNull();
  });

  it('tells the apply page the organization name and whether to show a CAPTCHA', async () => {
    const careers = setup();
    await expect(careers.get('suretek', jobId)).resolves.toMatchObject({
      title: 'QA',
      organization: { name: 'Suretek Infosoft' },
      resumeMaxBytes: 5 * 1024 * 1024,
      captcha: null,
    });
  });
});
