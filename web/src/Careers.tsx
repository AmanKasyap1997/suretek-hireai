import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowLeft,
  faBriefcase,
  faCircleCheck,
  faLocationDot,
} from '@fortawesome/free-solid-svg-icons';
import { ApiError } from './api';

// Public pages: no session, no cookies. Everything goes to /api/v1/public.

type PublicJob = {
  id: string;
  title: string;
  description: string;
  department: string;
  location: string;
  employment_type: string;
  openings: number;
  created_at: string;
};
type PageInfo = {
  organization: { name: string };
  noticeVersion: string;
  resumeMaxBytes: number;
  captcha: {
    provider: 'turnstile';
    siteKey: string;
    action: string | null;
  } | null;
};
type FieldErrors = Record<string, string>;
const DEFAULT_RESUME_BYTES = 5 * 1024 * 1024;
/** Fills in anything an older API version doesn't send, so the page can't crash. */
function withPageInfo<T extends Partial<PageInfo>>(value: T): T & PageInfo {
  return {
    ...value,
    organization: { name: value.organization?.name ?? '' },
    noticeVersion: value.noticeVersion ?? '',
    resumeMaxBytes: value.resumeMaxBytes ?? DEFAULT_RESUME_BYTES,
    captcha: value.captcha ?? null,
  };
}

/**
 * Public pages keep their own query cache. The console clears its shared cache
 * whenever it checks the sign-in session, which would cancel these requests
 * and leave the page loading forever.
 */
function PublicQueries({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const withoutError = (errors: FieldErrors, key: string) =>
  Object.fromEntries(Object.entries(errors).filter(([name]) => name !== key));

async function publicApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/public${path}`, {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(
      0,
      'We couldn’t reach the server. Check your connection and try again.',
    );
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new ApiError(
      response.status,
      typeof payload?.message === 'string' ? payload.message : undefined,
    ) as ApiError & { errors?: { path: string; message: string }[] };
    if (Array.isArray(payload?.errors)) error.errors = payload.errors;
    throw error;
  }
  return response.json();
}

export const noticePeriodLabels = {
  IMMEDIATE: 'Can join immediately',
  DAYS_15: '15 days or less',
  DAYS_30: '1 month',
  DAYS_45: '45 days',
  DAYS_60: '2 months',
  DAYS_90: '3 months',
  OVER_90_DAYS: 'More than 3 months',
  SERVING_NOTICE: 'Serving notice period',
} as const;
type NoticePeriod = keyof typeof noticePeriodLabels;

export const sourceLabels = {
  LINKEDIN: 'LinkedIn',
  CAREERS_SITE: 'Company website',
  REFERRAL: 'Employee referral',
  JOB_PORTAL: 'Job portal (Naukri, Indeed…)',
  SOCIAL: 'Social media',
  OTHER: 'Other',
  DIRECT: 'Not stated',
} as const;
type Source = keyof typeof sourceLabels;

/** `?source=` on a shared link, so candidates don't have to say where they came from. */
const sourceFromLink: Record<string, Source> = {
  linkedin: 'LINKEDIN',
  careers: 'CAREERS_SITE',
  website: 'CAREERS_SITE',
  referral: 'REFERRAL',
  portal: 'JOB_PORTAL',
  naukri: 'JOB_PORTAL',
  indeed: 'JOB_PORTAL',
  social: 'SOCIAL',
};
const currencies = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD'];
const employment: Record<string, string> = {
  FULL_TIME: 'Full time',
  PART_TIME: 'Part time',
  CONTRACT: 'Contract',
  INTERN: 'Internship',
};

export function formatPay(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}
export function formatExperience(months: number | null | undefined) {
  if (months === null || months === undefined) return '—';
  if (months === 0) return 'Fresher';
  const years = Math.floor(months / 12),
    rest = months % 12;
  return [
    years ? `${years} yr${years === 1 ? '' : 's'}` : '',
    rest ? `${rest} mo` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
const megabytes = (bytes: number) =>
  `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

/** "+91 98765-43210" → "+919876543210"; null when there's no country code. */
export function normalizePhone(value: string) {
  const compact = value.replace(/[\s().-]/g, '').replace(/^00/, '+');
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}
const amount = (value: string) => {
  const cleaned = value.replace(/[,\s]/g, '');
  return cleaned && /^\d+(\.\d{1,2})?$/.test(cleaned) ? Number(cleaned) : null;
};
function isWebAddress(value: string, host?: RegExp) {
  try {
    const url = new URL(value);
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      (!host || host.test(url.hostname))
    );
  } catch {
    return false;
  }
}

function CareersShell({
  organization,
  children,
}: {
  organization?: string;
  children: ReactNode;
}) {
  return (
    <div className="careers-shell">
      <header className="careers-header">
        <div className="careers-header-inner">
          <strong>{organization || 'Careers'}</strong>
          {organization && <span>Careers</span>}
        </div>
      </header>
      <main className="careers-main">{children}</main>
      <footer className="careers-footer">Powered by Suretek HireAI</footer>
    </div>
  );
}

export function CareersJobsPage() {
  return (
    <PublicQueries>
      <JobsList />
    </PublicQueries>
  );
}

function JobsList() {
  const { slug = '' } = useParams();
  const [searchParams] = useSearchParams();
  const source = searchParams.get('source');
  const jobs = useQuery({
    queryKey: ['public-jobs', slug],
    queryFn: async () =>
      withPageInfo(
        await publicApi<
          Partial<PageInfo> & { data: PublicJob[]; total: number }
        >(`/${encodeURIComponent(slug)}/jobs?limit=100`),
      ),
  });
  useEffect(() => {
    document.title = jobs.data?.organization.name
      ? `Careers at ${jobs.data.organization.name}`
      : 'Careers';
  }, [jobs.data]);
  const organization = jobs.data?.organization.name;
  return (
    <CareersShell organization={organization}>
      {jobs.isPending ? (
        <p role="status" className="careers-state">
          Loading open jobs…
        </p>
      ) : jobs.isError ? (
        <section className="careers-state" role="alert">
          <h1>Careers page not found</h1>
          <p>Check the link you were given.</p>
        </section>
      ) : (
        <>
          <section className="careers-intro">
            <h1>
              {organization ? `Open jobs at ${organization}` : 'Open jobs'}
            </h1>
            <p>
              {jobs.data.total === 1
                ? '1 open job'
                : `${jobs.data.total} open jobs`}
            </p>
          </section>
          {jobs.data.data.length ? (
            <ul className="careers-job-list">
              {jobs.data.data.map((job) => (
                <li key={job.id}>
                  <div>
                    <h2>{job.title}</h2>
                    <p>
                      {[
                        job.department,
                        job.location,
                        employment[job.employment_type] ?? job.employment_type,
                      ].join(' · ')}
                    </p>
                  </div>
                  <Link
                    className="button-primary"
                    to={`/careers/${slug}/jobs/${job.id}${source ? `?source=${encodeURIComponent(source)}` : ''}`}
                    aria-label={`View and apply: ${job.title}`}
                  >
                    View and apply
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="careers-state">
              There are no open jobs right now. Please check back later.
            </p>
          )}
        </>
      )}
    </CareersShell>
  );
}

declare global {
  interface Window {
    turnstile?: {
      render(element: HTMLElement, options: Record<string, unknown>): string;
      remove(id: string): void;
    };
  }
}
let turnstileScript: Promise<void> | null = null;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  turnstileScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src =
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      turnstileScript = null;
      reject(new Error('Turnstile unavailable'));
    };
    document.head.appendChild(script);
  });
  return turnstileScript;
}
function Turnstile({
  siteKey,
  action,
  round,
  onToken,
}: {
  siteKey: string;
  action: string | null;
  round: number;
  onToken: (token: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  callback.current = onToken;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let id: string | undefined;
    let cancelled = false;
    callback.current('');
    loadTurnstile()
      .then(() => {
        if (cancelled || !box.current || !window.turnstile) return;
        id = window.turnstile.render(box.current, {
          sitekey: siteKey,
          ...(action ? { action } : {}),
          callback: (token: string) => callback.current(token),
          'expired-callback': () => callback.current(''),
          'error-callback': () => callback.current(''),
        });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (id) window.turnstile?.remove(id);
    };
  }, [siteKey, action, round]);
  return failed ? (
    <p className="form-error" role="alert">
      The security check couldn’t load. Check your connection, then reload the
      page.
    </p>
  ) : (
    <div ref={box} className="careers-captcha" />
  );
}

type Form = {
  fullName: string;
  email: string;
  phone: string;
  currentLocation: string;
  willingToRelocate: '' | 'yes' | 'no';
  years: string;
  months: string;
  currentTitle: string;
  currentCompany: string;
  noticePeriod: '' | NoticePeriod;
  lastWorkingDay: string;
  ctcCurrency: string;
  currentCtc: string;
  expectedCtc: string;
  linkedinUrl: string;
  portfolioUrl: string;
  coverLetter: string;
  source: '' | Source;
  referrer: string;
  privacyAccepted: boolean;
  website: string;
};
const blank = (source: '' | Source): Form => ({
  fullName: '',
  email: '',
  phone: '',
  currentLocation: '',
  willingToRelocate: '',
  years: '',
  months: '0',
  currentTitle: '',
  currentCompany: '',
  noticePeriod: '',
  lastWorkingDay: '',
  ctcCurrency: 'INR',
  currentCtc: '',
  expectedCtc: '',
  linkedinUrl: '',
  portfolioUrl: '',
  coverLetter: '',
  source,
  referrer: '',
  privacyAccepted: false,
  website: '',
});
/** Field order for the error summary; matches the form. */
const fieldOrder = [
  'fullName',
  'email',
  'phone',
  'currentLocation',
  'years',
  'noticePeriod',
  'lastWorkingDay',
  'currentTitle',
  'currentCompany',
  'currentCtc',
  'expectedCtc',
  'resume',
  'linkedinUrl',
  'portfolioUrl',
  'coverLetter',
  'referrer',
  'privacyAccepted',
  'captcha',
];
/** Server field names that differ from the form's. */
const serverField: Record<string, string> = {
  totalExperienceMonths: 'years',
  ctcCurrency: 'currentCtc',
};

export function validateApplication(
  form: Form,
  resume: File | null,
  maxBytes: number,
  needsCaptcha: boolean,
  token: string,
) {
  const errors: FieldErrors = {};
  if (form.fullName.trim().length < 2)
    errors.fullName = 'Enter your full name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
    errors.email = 'Enter a valid email address, like name@example.com.';
  if (!form.phone.trim()) errors.phone = 'Enter your phone number.';
  else if (!normalizePhone(form.phone))
    errors.phone = 'Include your country code, for example +91 98765 43210.';
  if (form.currentLocation.trim().length < 2)
    errors.currentLocation = 'Enter the city you live in.';
  if (form.years === '') errors.years = 'Choose your total work experience.';
  if (!form.noticePeriod) errors.noticePeriod = 'Choose your notice period.';
  if (form.currentCtc.trim() && amount(form.currentCtc) === null)
    errors.currentCtc = 'Enter a number, like 850000.';
  const expected = amount(form.expectedCtc);
  if (!form.expectedCtc.trim())
    errors.expectedCtc = 'Enter the annual pay you expect.';
  else if (expected === null || expected <= 0)
    errors.expectedCtc = 'Enter a number, like 1200000.';
  if (!resume) errors.resume = 'Attach your resume.';
  else if (!/\.(pdf|docx)$/i.test(resume.name))
    errors.resume = 'Upload a PDF or Word (.docx) file.';
  else if (resume.size > maxBytes)
    errors.resume = `Your resume must be ${megabytes(maxBytes)} or smaller.`;
  else if (resume.size === 0) errors.resume = 'This file is empty.';
  if (
    form.linkedinUrl.trim() &&
    !isWebAddress(form.linkedinUrl.trim(), /(^|\.)linkedin\.com$/i)
  )
    errors.linkedinUrl =
      'Enter your LinkedIn profile address, like https://www.linkedin.com/in/your-name.';
  if (form.portfolioUrl.trim() && !isWebAddress(form.portfolioUrl.trim()))
    errors.portfolioUrl = 'Enter a full web address, starting with https://.';
  if (!form.privacyAccepted)
    errors.privacyAccepted = 'Agree to the privacy notice to apply.';
  if (needsCaptcha && !token) errors.captcha = 'Complete the security check.';
  return errors;
}

export function applicationPayload(form: Form, page: PageInfo, token: string) {
  const serving = form.noticePeriod === 'SERVING_NOTICE';
  return {
    fullName: form.fullName.trim(),
    email: form.email.trim(),
    phone: normalizePhone(form.phone) ?? form.phone,
    currentLocation: form.currentLocation.trim(),
    ...(form.willingToRelocate
      ? { willingToRelocate: form.willingToRelocate === 'yes' }
      : {}),
    totalExperienceMonths: Number(form.years) * 12 + Number(form.months || 0),
    currentTitle: form.currentTitle.trim(),
    currentCompany: form.currentCompany.trim(),
    noticePeriod: form.noticePeriod,
    ...(serving && form.lastWorkingDay
      ? { lastWorkingDay: form.lastWorkingDay }
      : {}),
    ...(amount(form.currentCtc) !== null
      ? { currentCtc: amount(form.currentCtc) }
      : {}),
    expectedCtc: amount(form.expectedCtc),
    ctcCurrency: form.ctcCurrency,
    linkedinUrl: form.linkedinUrl.trim(),
    portfolioUrl: form.portfolioUrl.trim(),
    coverLetter: form.coverLetter.trim(),
    source: form.source || 'DIRECT',
    ...(form.source === 'REFERRAL' && form.referrer.trim()
      ? { referrer: form.referrer.trim() }
      : {}),
    website: form.website,
    ...(token ? { captchaToken: token } : {}),
    noticeVersion: page.noticeVersion,
    // No separate contact choices: the privacy notice covers screening calls.
    privacyAccepted: true,
  };
}

function Field({
  id,
  label,
  required,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className={`careers-field${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>
        {label}
        {required ? (
          <span className="careers-required" aria-hidden="true">
            {' '}
            *
          </span>
        ) : (
          <span className="careers-optional"> (optional)</span>
        )}
      </label>
      {hint && (
        <small id={`${id}-hint`} className="careers-hint">
          {hint}
        </small>
      )}
      {children}
      {error && (
        <p id={`${id}-error`} className="careers-field-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function ApplyPage() {
  return (
    <PublicQueries>
      <ApplyForm />
    </PublicQueries>
  );
}

/**
 * This browser remembers the jobs it applied to, so it can say so instead of
 * showing the form again. A convenience only: the server is what refuses a
 * second application from the same email.
 */
const appliedKey = (slug: string, id: string) => `hireai-applied:${slug}:${id}`;
function appliedOn(slug: string, id: string) {
  try {
    const value = localStorage.getItem(appliedKey(slug, id));
    return value && !Number.isNaN(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}
function rememberApplied(slug: string, id: string) {
  try {
    localStorage.setItem(appliedKey(slug, id), new Date().toISOString());
  } catch {
    // Storage can be blocked (private mode); the server still refuses repeats.
  }
}

function ApplyForm() {
  const { slug = '', id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const linkSource =
    sourceFromLink[(searchParams.get('source') ?? '').toLowerCase()] ?? '';
  const uid = useId();
  const fieldId = (name: string) => `${uid}-${name}`;
  const job = useQuery({
    queryKey: ['public-job', slug, id],
    queryFn: async () =>
      withPageInfo(
        await publicApi<PublicJob & Partial<PageInfo>>(
          `/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(id)}`,
        ),
      ),
  });
  const [form, setForm] = useState<Form>(() => blank(linkSource));
  const [resume, setResume] = useState<File | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [previous] = useState(() => appliedOn(slug, id));
  const [applyAgain, setApplyAgain] = useState(false);
  const [token, setToken] = useState('');
  const [captchaRound, setCaptchaRound] = useState(0);
  const [showFullDescription, setShowFullDescription] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  const doneHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (job.data)
      document.title = [job.data.title, job.data.organization.name, 'careers']
        .filter(Boolean)
        .join(' – ');
  }, [job.data]);
  useEffect(() => {
    if (done) doneHeading.current?.focus();
  }, [done]);

  function update<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    // Fix-as-you-go: clear a field's error once it changes.
    const errorKey = key === 'months' ? 'years' : key;
    if (errors[errorKey])
      setErrors((current) => withoutError(current, errorKey));
  }
  const describedBy = (name: string, hint = false) =>
    [
      hint ? `${fieldId(name)}-hint` : '',
      errors[name] ? `${fieldId(name)}-error` : '',
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  const invalid = (name: string) => (errors[name] ? true : undefined);

  if (job.isPending)
    return (
      <CareersShell>
        <p role="status" className="careers-state">
          Loading the job…
        </p>
      </CareersShell>
    );
  if (job.isError)
    return (
      <CareersShell>
        <section className="careers-state" role="alert">
          <h1>
            {job.error instanceof ApiError && job.error.status === 404
              ? 'This job isn’t taking applications'
              : 'The job couldn’t be loaded'}
          </h1>
          <p>
            {job.error instanceof ApiError && job.error.status === 404
              ? 'It may have been filled or closed.'
              : 'Check your connection, then reload the page.'}
          </p>
          <Link to={`/careers/${slug}`}>See all open jobs</Link>
        </section>
      </CareersShell>
    );
  const page = job.data;
  const organization = page.organization.name;
  // For sentences, in case the server didn't name the organization.
  const Company = organization || 'The company';
  const company = organization || 'the company';
  const longDescription = page.description.length > 900;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError('');
    const found = validateApplication(
      form,
      resume,
      page.resumeMaxBytes,
      !!page.captcha,
      token,
    );
    setErrors(found);
    if (Object.keys(found).length) {
      requestAnimationFrame(() => summary.current?.focus());
      return;
    }
    setBusy(true);
    const data = new FormData();
    data.append(
      'application',
      JSON.stringify(applicationPayload(form, page, token)),
    );
    data.append('resume', resume!);
    try {
      await publicApi(
        `/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(id)}/applications`,
        { method: 'POST', body: data },
      );
      rememberApplied(slug, id);
      setDone(true);
    } catch (reason) {
      const status = reason instanceof ApiError ? reason.status : 0;
      const serverErrors =
        (reason as { errors?: { path: string; message: string }[] }).errors ??
        [];
      if (status === 400 && serverErrors.length) {
        const mapped: FieldErrors = {};
        for (const item of serverErrors) {
          const key = serverField[item.path] ?? item.path.split('.')[0];
          if (fieldOrder.includes(key)) mapped[key] ??= item.message;
          else
            setFormError(
              'Some details couldn’t be accepted. Check the form and try again.',
            );
        }
        setErrors(mapped);
        requestAnimationFrame(() => summary.current?.focus());
      } else
        setFormError(
          status === 413
            ? `Your resume is too large. Upload a file of ${megabytes(page.resumeMaxBytes)} or less.`
            : status === 429
              ? 'Too many applications were sent from this network or email address. Please try again in an hour.'
              : status === 403
                ? 'The security check didn’t pass. Complete it again, then resubmit.'
                : status === 404
                  ? 'This job has stopped taking applications.'
                  : status === 400
                    ? reason instanceof Error &&
                      /notice version/i.test(reason.message)
                      ? 'This page is out of date. Reload it, then submit again.'
                      : 'Your resume couldn’t be read. Upload a valid PDF or Word (.docx) file.'
                    : reason instanceof ApiError && status === 0
                      ? reason.message
                      : 'Your application couldn’t be sent. Please try again.',
        );
      if (page.captcha) setCaptchaRound((round) => round + 1);
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <CareersShell organization={organization}>
        <section className="careers-done">
          <FontAwesomeIcon icon={faCircleCheck} aria-hidden="true" />
          <h1 ref={doneHeading} tabIndex={-1}>
            Application sent
          </h1>
          <p>
            Thank you, {form.fullName.trim().split(/\s+/)[0]}. {Company} has
            received your application for <strong>{page.title}</strong>.
          </p>
          <p>
            You may get an email at <strong>{form.email.trim()}</strong> asking
            you to confirm your contact preferences.
          </p>
          <p>
            Already applied for this job with this email? Then we’ve kept your
            first application and haven’t saved this one.
          </p>
          <Link to={`/careers/${slug}`}>See other open jobs</Link>
        </section>
      </CareersShell>
    );

  if (previous && !applyAgain)
    return (
      <CareersShell organization={organization}>
        <section className="careers-done">
          <FontAwesomeIcon icon={faCircleCheck} aria-hidden="true" />
          <h1>You’ve already applied for this job</h1>
          <p>
            You applied for <strong>{page.title}</strong> from this browser on{' '}
            {new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(
              new Date(previous),
            )}
            . {Company} has your application, so there’s no need to apply again.
          </p>
          <Link to={`/careers/${slug}`}>See other open jobs</Link>
          <p className="careers-already-other">
            Applying for someone else on this device?{' '}
            <button
              type="button"
              className="careers-link-button"
              onClick={() => setApplyAgain(true)}
            >
              Apply with a different email
            </button>
          </p>
        </section>
      </CareersShell>
    );

  const errorList = fieldOrder.filter((name) => errors[name]);
  const serving = form.noticePeriod === 'SERVING_NOTICE';
  const expected = amount(form.expectedCtc);
  const current = amount(form.currentCtc);
  return (
    <CareersShell organization={organization}>
      <Link className="careers-back" to={`/careers/${slug}`}>
        <FontAwesomeIcon icon={faArrowLeft} aria-hidden="true" /> All open jobs
      </Link>
      <article className="careers-job">
        <h1>{page.title}</h1>
        <ul className="careers-job-meta">
          <li>
            <FontAwesomeIcon icon={faBriefcase} aria-hidden="true" />
            {page.department} ·{' '}
            {employment[page.employment_type] ?? page.employment_type}
          </li>
          <li>
            <FontAwesomeIcon icon={faLocationDot} aria-hidden="true" />
            {page.location}
          </li>
        </ul>
        <div
          id={fieldId('description')}
          className={`careers-description${longDescription && !showFullDescription ? ' is-clipped' : ''}`}
        >
          {page.description}
        </div>
        {longDescription && (
          <button
            type="button"
            className="careers-link-button"
            aria-expanded={showFullDescription}
            aria-controls={fieldId('description')}
            onClick={() => setShowFullDescription((shown) => !shown)}
          >
            {showFullDescription
              ? 'Show less'
              : 'Show the full job description'}
          </button>
        )}
      </article>

      <form className="careers-form" noValidate onSubmit={submit}>
        <h2>Apply for this job</h2>
        <p className="careers-form-note">
          Fields marked <span aria-hidden="true">*</span>
          <span className="sr-only">with an asterisk</span> are required.
        </p>
        {errorList.length > 0 && (
          <div
            ref={summary}
            tabIndex={-1}
            className="careers-error-summary"
            role="alert"
          >
            <h3>
              {errorList.length === 1
                ? 'Fix 1 thing to send your application'
                : `Fix ${errorList.length} things to send your application`}
            </h3>
            <ul>
              {errorList.map((name) => (
                <li key={name}>
                  <a href={`#${fieldId(name)}`}>{errors[name]}</a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <fieldset>
          <legend>Your details</legend>
          <div className="careers-grid">
            <Field
              id={fieldId('fullName')}
              label="Full name"
              required
              error={errors.fullName}
            >
              <input
                id={fieldId('fullName')}
                autoComplete="name"
                maxLength={200}
                value={form.fullName}
                aria-invalid={invalid('fullName')}
                aria-describedby={describedBy('fullName')}
                onChange={(event) => update('fullName', event.target.value)}
              />
            </Field>
            <Field
              id={fieldId('email')}
              label="Email"
              required
              error={errors.email}
            >
              <input
                id={fieldId('email')}
                type="email"
                autoComplete="email"
                maxLength={254}
                value={form.email}
                aria-invalid={invalid('email')}
                aria-describedby={describedBy('email')}
                onChange={(event) => update('email', event.target.value)}
              />
            </Field>
            <Field
              id={fieldId('phone')}
              label="Phone"
              required
              hint="With country code, like +91 98765 43210."
              error={errors.phone}
            >
              <input
                id={fieldId('phone')}
                type="tel"
                autoComplete="tel"
                maxLength={24}
                value={form.phone}
                aria-invalid={invalid('phone')}
                aria-describedby={describedBy('phone', true)}
                onChange={(event) => update('phone', event.target.value)}
              />
            </Field>
            <Field
              id={fieldId('currentLocation')}
              label="Current city"
              required
              error={errors.currentLocation}
            >
              <input
                id={fieldId('currentLocation')}
                autoComplete="address-level2"
                maxLength={120}
                value={form.currentLocation}
                aria-invalid={invalid('currentLocation')}
                aria-describedby={describedBy('currentLocation')}
                onChange={(event) =>
                  update('currentLocation', event.target.value)
                }
              />
            </Field>
          </div>
          <fieldset className="careers-choice">
            <legend>
              Are you willing to relocate to {page.location}?
              <span className="careers-optional"> (optional)</span>
            </legend>
            <div className="careers-choice-row">
              {(
                [
                  ['yes', 'Yes'],
                  ['no', 'No'],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={fieldId('relocate')}
                    checked={form.willingToRelocate === value}
                    onChange={() => update('willingToRelocate', value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        </fieldset>

        <fieldset>
          <legend>Experience</legend>
          <div className="careers-grid">
            <div
              className={`careers-field${errors.years ? ' has-error' : ''}`}
              role="group"
              aria-labelledby={`${fieldId('years')}-label`}
            >
              <span id={`${fieldId('years')}-label`} className="careers-label">
                Total work experience
                <span className="careers-required" aria-hidden="true">
                  {' '}
                  *
                </span>
              </span>
              <div className="careers-pair">
                <select
                  id={fieldId('years')}
                  aria-label="Years"
                  value={form.years}
                  aria-invalid={invalid('years')}
                  aria-describedby={describedBy('years')}
                  onChange={(event) => update('years', event.target.value)}
                >
                  <option value="">Years</option>
                  {Array.from({ length: 41 }, (_, years) => (
                    <option key={years} value={years}>
                      {years === 0
                        ? '0 years'
                        : years === 40
                          ? '40+ years'
                          : `${years} year${years === 1 ? '' : 's'}`}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Months"
                  value={form.months}
                  onChange={(event) => update('months', event.target.value)}
                >
                  {Array.from({ length: 12 }, (_, months) => (
                    <option key={months} value={months}>
                      {months} month{months === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>
              </div>
              {errors.years && (
                <p
                  id={`${fieldId('years')}-error`}
                  className="careers-field-error"
                >
                  {errors.years}
                </p>
              )}
            </div>
            <Field
              id={fieldId('noticePeriod')}
              label="Notice period"
              required
              error={errors.noticePeriod}
            >
              <select
                id={fieldId('noticePeriod')}
                value={form.noticePeriod}
                aria-invalid={invalid('noticePeriod')}
                aria-describedby={describedBy('noticePeriod')}
                onChange={(event) =>
                  update('noticePeriod', event.target.value as NoticePeriod)
                }
              >
                <option value="">Choose…</option>
                {Object.entries(noticePeriodLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            {serving && (
              <Field
                id={fieldId('lastWorkingDay')}
                label="Last working day"
                error={errors.lastWorkingDay}
              >
                <input
                  id={fieldId('lastWorkingDay')}
                  type="date"
                  value={form.lastWorkingDay}
                  aria-invalid={invalid('lastWorkingDay')}
                  aria-describedby={describedBy('lastWorkingDay')}
                  onChange={(event) =>
                    update('lastWorkingDay', event.target.value)
                  }
                />
              </Field>
            )}
            <Field
              id={fieldId('currentTitle')}
              label="Current or last job title"
              error={errors.currentTitle}
            >
              <input
                id={fieldId('currentTitle')}
                autoComplete="organization-title"
                maxLength={200}
                value={form.currentTitle}
                aria-describedby={describedBy('currentTitle')}
                onChange={(event) => update('currentTitle', event.target.value)}
              />
            </Field>
            <Field
              id={fieldId('currentCompany')}
              label="Current or last company"
              error={errors.currentCompany}
            >
              <input
                id={fieldId('currentCompany')}
                autoComplete="organization"
                maxLength={200}
                value={form.currentCompany}
                aria-describedby={describedBy('currentCompany')}
                onChange={(event) =>
                  update('currentCompany', event.target.value)
                }
              />
            </Field>
          </div>
        </fieldset>

        <fieldset>
          <legend>Pay</legend>
          <p className="careers-fieldset-note">
            Annual CTC: your total yearly pay before tax.
          </p>
          <div className="careers-grid careers-pay">
            <Field id={fieldId('ctcCurrency')} label="Currency" required>
              <select
                id={fieldId('ctcCurrency')}
                value={form.ctcCurrency}
                onChange={(event) => update('ctcCurrency', event.target.value)}
              >
                {currencies.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id={fieldId('currentCtc')}
              label="Current annual CTC"
              hint={
                current !== null
                  ? `${formatPay(current, form.ctcCurrency)} a year`
                  : 'Leave empty if you aren’t working now.'
              }
              error={errors.currentCtc}
            >
              <input
                id={fieldId('currentCtc')}
                inputMode="decimal"
                maxLength={20}
                value={form.currentCtc}
                aria-invalid={invalid('currentCtc')}
                aria-describedby={describedBy('currentCtc', true)}
                onChange={(event) => update('currentCtc', event.target.value)}
              />
            </Field>
            <Field
              id={fieldId('expectedCtc')}
              label="Expected annual CTC"
              required
              hint={
                expected !== null
                  ? `${formatPay(expected, form.ctcCurrency)} a year`
                  : 'For example 1200000.'
              }
              error={errors.expectedCtc}
            >
              <input
                id={fieldId('expectedCtc')}
                inputMode="decimal"
                maxLength={20}
                value={form.expectedCtc}
                aria-invalid={invalid('expectedCtc')}
                aria-describedby={describedBy('expectedCtc', true)}
                onChange={(event) => update('expectedCtc', event.target.value)}
              />
            </Field>
          </div>
        </fieldset>

        <fieldset>
          <legend>Resume and profile</legend>
          <Field
            id={fieldId('resume')}
            label="Resume"
            required
            hint={`PDF or Word (.docx), up to ${megabytes(page.resumeMaxBytes)}.`}
            error={errors.resume}
          >
            <input
              id={fieldId('resume')}
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              aria-invalid={invalid('resume')}
              aria-describedby={describedBy('resume', true)}
              onChange={(event) => {
                setResume(event.target.files?.[0] ?? null);
                if (errors.resume)
                  setErrors((current) => withoutError(current, 'resume'));
              }}
            />
          </Field>
          <div className="careers-grid">
            <Field
              id={fieldId('linkedinUrl')}
              label="LinkedIn profile"
              error={errors.linkedinUrl}
            >
              <input
                id={fieldId('linkedinUrl')}
                type="url"
                inputMode="url"
                maxLength={300}
                placeholder="https://www.linkedin.com/in/…"
                value={form.linkedinUrl}
                aria-invalid={invalid('linkedinUrl')}
                aria-describedby={describedBy('linkedinUrl')}
                onChange={(event) => update('linkedinUrl', event.target.value)}
              />
            </Field>
            <Field
              id={fieldId('portfolioUrl')}
              label="Portfolio, GitHub or website"
              error={errors.portfolioUrl}
            >
              <input
                id={fieldId('portfolioUrl')}
                type="url"
                inputMode="url"
                maxLength={300}
                placeholder="https://"
                value={form.portfolioUrl}
                aria-invalid={invalid('portfolioUrl')}
                aria-describedby={describedBy('portfolioUrl')}
                onChange={(event) => update('portfolioUrl', event.target.value)}
              />
            </Field>
          </div>
          <Field
            id={fieldId('coverLetter')}
            label="Why are you interested in this job?"
            hint={`${form.coverLetter.length} / 4,000 characters`}
            error={errors.coverLetter}
          >
            <textarea
              id={fieldId('coverLetter')}
              rows={5}
              maxLength={4000}
              value={form.coverLetter}
              aria-describedby={describedBy('coverLetter', true)}
              onChange={(event) => update('coverLetter', event.target.value)}
            />
          </Field>
        </fieldset>

        <fieldset>
          <legend>About your application</legend>
          <div className="careers-grid">
            <Field
              id={fieldId('source')}
              label="How did you hear about this job?"
            >
              <select
                id={fieldId('source')}
                value={form.source}
                onChange={(event) =>
                  update('source', event.target.value as Source | '')
                }
              >
                <option value="">Choose…</option>
                {Object.entries(sourceLabels)
                  .filter(([value]) => value !== 'DIRECT')
                  .map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
              </select>
            </Field>
            {form.source === 'REFERRAL' && (
              <Field
                id={fieldId('referrer')}
                label="Who referred you?"
                hint="Their name or work email."
                error={errors.referrer}
              >
                <input
                  id={fieldId('referrer')}
                  maxLength={200}
                  value={form.referrer}
                  aria-describedby={describedBy('referrer', true)}
                  onChange={(event) => update('referrer', event.target.value)}
                />
              </Field>
            )}
          </div>
        </fieldset>

        <section
          className="careers-privacy"
          aria-labelledby={fieldId('privacy-heading')}
        >
          <h3 id={fieldId('privacy-heading')}>Privacy</h3>
          <p>
            Your details and resume are stored in HireAI so {company}’s hiring
            team can review your application and contact you about it.
          </p>
          <p>
            {Company} may use an AI service to compare your resume with this
            job’s requirements. People on the hiring team review the results and
            make every decision.
          </p>
          <p>
            {Company} may call you about this application, including a short
            screening call with an AI assistant. The assistant says it’s an AI
            at the start, and the call may be recorded and transcribed so the
            hiring team can review your answers. You can decline the call, or
            ask {company} not to call you, at any time.
          </p>
          <label
            className={`careers-check${errors.privacyAccepted ? ' has-error' : ''}`}
          >
            <input
              id={fieldId('privacyAccepted')}
              type="checkbox"
              checked={form.privacyAccepted}
              aria-invalid={invalid('privacyAccepted')}
              aria-describedby={describedBy('privacyAccepted')}
              onChange={(event) =>
                update('privacyAccepted', event.target.checked)
              }
            />
            <span>
              I agree to {company} storing and using my details for this
              application, including contacting me about it as described above.
              <span className="careers-required" aria-hidden="true">
                {' '}
                *
              </span>
            </span>
          </label>
          {errors.privacyAccepted && (
            <p
              id={`${fieldId('privacyAccepted')}-error`}
              className="careers-field-error"
            >
              {errors.privacyAccepted}
            </p>
          )}
        </section>

        {/* Left empty by people; bots that fill every field are ignored. */}
        <div className="careers-trap" aria-hidden="true">
          <label>
            Website
            <input
              tabIndex={-1}
              autoComplete="off"
              value={form.website}
              onChange={(event) => update('website', event.target.value)}
            />
          </label>
        </div>

        {page.captcha && (
          <div id={fieldId('captcha')} tabIndex={-1}>
            <Turnstile
              siteKey={page.captcha.siteKey}
              action={page.captcha.action}
              round={captchaRound}
              onToken={(value) => {
                setToken(value);
                if (value && errors.captcha)
                  setErrors((current) => withoutError(current, 'captcha'));
              }}
            />
            {errors.captcha && (
              <p className="careers-field-error">{errors.captcha}</p>
            )}
          </div>
        )}

        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}
        <button
          type="submit"
          className="button-primary careers-submit"
          disabled={busy}
        >
          {busy ? 'Sending application…' : 'Submit application'}
        </button>
      </form>
    </CareersShell>
  );
}
