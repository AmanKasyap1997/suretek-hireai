import { ApplicationsService } from '../src/modules/talent-acquisition';
import { DbService } from '../src/platform/database/db.service';
import { AccessPolicy } from '../src/shared/ta-policy';
import { Role } from '../src/shared/enums';

describe('application details', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const id = '44444444-4444-4444-8444-444444444444';
  const row = {
    id,
    stage: 'APPLIED',
    created_at: new Date('2026-11-24T09:00:00Z'),
    job_id: 'job-1',
    job_title: 'Full Stack Developer',
    candidate_id: 'cand-1',
    full_name: 'Asha Verma',
    email: 'asha@example.test',
    candidate_phone: '+911111111111',
    erased_at: null,
    has_details: true,
    phone: '+919876543210',
    current_location: 'Noida',
    willing_to_relocate: true,
    total_experience_months: 54,
    current_company: 'Acme Software',
    current_title: 'Software Engineer',
    notice_period: 'DAYS_30',
    last_working_day: null,
    current_ctc: '900000.00',
    expected_ctc: '1300000.00',
    ctc_currency: 'INR',
    linkedin_url: 'https://www.linkedin.com/in/asha-verma',
    portfolio_url: null,
    cover_letter: 'I build hiring tools.',
    source: 'LINKEDIN',
    referrer: null,
  };
  let audited: unknown[][];
  let resumeQuery: { sql: string; params: unknown[] } | undefined;
  const setup = () => {
    audited = [];
    resumeQuery = undefined;
    const tx = {
      one: jest.fn(async () => row),
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('audit_events')) audited.push(params);
        if (sql.includes('FROM candidate_documents')) {
          resumeQuery = { sql, params };
          // Ordered by the database: this application's resume first.
          return [
            { id: 'doc-1', original_name: 'cv.pdf', application_id: id },
            {
              id: 'doc-0',
              original_name: 'cv-for-another-job.pdf',
              application_id: 'other-application',
            },
          ];
        }
        return [];
      }),
    };
    const db = {
      one: jest.fn(async () => ({ id, job_id: 'job-1' })),
      transaction: jest.fn(async (fn: (client: typeof tx) => unknown) =>
        fn(tx),
      ),
    } as unknown as DbService;
    const policy = {
      assertJob: jest.fn(async () => undefined),
    } as unknown as AccessPolicy;
    return new ApplicationsService(db, policy);
  };
  const actor = (role: Role) => ({ tenantId, userId: 'user-1', role });

  it('shows recruiters everything the candidate submitted, with the resume', async () => {
    const result = await setup().details(actor(Role.RECRUITER), id);
    expect(result.candidate).toMatchObject({
      email: 'asha@example.test',
      phone: '+919876543210',
    });
    expect(result.details).toMatchObject({
      total_experience_months: 54,
      current_ctc: 900000,
      expected_ctc: 1300000,
      ctc_currency: 'INR',
      source: 'LINKEDIN',
    });
    // One resume: the one sent with this application.
    expect(result.documents).toEqual([
      {
        id: 'doc-1',
        original_name: 'cv.pdf',
        application_id: id,
        sent_with: 'this_application',
      },
    ]);
    expect(result.other_resumes).toBe(1);
    expect(resumeQuery?.params).toEqual([tenantId, 'cand-1', id]);
    expect(resumeQuery?.sql).toContain(
      'CASE WHEN d.application_id=$3::uuid THEN 0',
    );
    expect(result.pay_and_contact_hidden).toBe(false);
    expect(audited).toHaveLength(1);
  });

  it('hides pay, contact details and the resume from interviewers', async () => {
    const result = await setup().details(actor(Role.INTERVIEWER), id);
    expect(result.candidate).toMatchObject({ email: null, phone: null });
    expect(result.details).toMatchObject({
      current_ctc: null,
      expected_ctc: null,
      ctc_currency: null,
      total_experience_months: 54,
      notice_period: 'DAYS_30',
    });
    expect(result.documents).toEqual([]);
    expect(result.pay_and_contact_hidden).toBe(true);
  });

  it('lets hiring managers see pay and contact details, without the resume list', async () => {
    const result = await setup().details(actor(Role.HIRING_MANAGER), id);
    expect(result.details?.expected_ctc).toBe(1300000);
    expect(result.candidate.email).toBe('asha@example.test');
    expect(result.documents).toEqual([]);
  });
});
