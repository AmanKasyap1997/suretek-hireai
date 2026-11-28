import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowLeft,
  faArrowRight,
  faBriefcase,
  faBuilding,
  faBullseye,
  faCalendarCheck,
  faChevronDown,
  faCoins,
  faFileCircleCheck,
  faFileLines,
  faFilePen,
  faFloppyDisk,
  faLocationDot,
  faMicrochip,
  faPaperPlane,
  faPhone,
  faMicrophone,
  faPhoneVolume,
  faPlus,
  faTags,
  faWandMagicSparkles,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { api } from './api';
import { useAuth } from './auth';
import { TestCallDialog } from './TestCall';
import { HiringTeamDialog } from './HiringTeam';
import {
  InterviewBookingDialog,
  type InterviewSetup,
} from './HiringAutomation';
import {
  ChannelPicker,
  ChannelResults,
  CloseJobDialog,
  emptySelection,
  localDevLink,
  PublishDialog,
  selectionError,
  sendToChannels,
  useJobChannels,
  type ChannelSelection,
  type PublishOutcome,
} from './JobChannels';

type JobStatus = 'DRAFT' | 'APPROVED' | 'PUBLISHED' | 'CLOSED';
type Criterion = {
  id: string;
  label: string;
  weight: number;
  must_have: boolean;
};
type Job = {
  id: string;
  title: string;
  description: string;
  department: string;
  location: string;
  status: JobStatus;
  openings: number;
  employment_type: string;
  salary_min: number | null;
  salary_max: number | null;
  screening_criteria: Criterion[] | null;
  auto_screen?: boolean;
  call_questions?: CallQuestion[];
  /** How the AI books this job's interviews (null: recruiters book them). */
  interview_setup?: InterviewSetup | null;
  /** Submitted for an HR Admin's approval (a draft awaiting approval). */
  requested_at?: string | null;
  /** Why an HR Admin sent it back. */
  review_note?: string | null;
  /** Who created it: for a hiring manager's request, who asked. */
  created_by_name?: string | null;
  created_at: string;
  updated_at: string;
};
/** Who is working on the job: approves and publishes, publishes, or asks. */
export type JobRole = 'HR_ADMIN' | 'RECRUITER' | 'HIRING_MANAGER';
type CallQuestion = {
  id: string;
  text: string;
  answer_type: 'yes_no' | 'number' | 'text';
  /** For a yes/no deal-breaker: a different answer is flagged. */
  expected_answer: 'yes' | 'no' | null;
  criterion_id: string | null;
  /** Open questions: what a good answer covers (assessed after the call). */
  key_points?: string[];
};
type DraftedQuestions = {
  questions: CallQuestion[];
  label: string;
  environment: 'production' | 'sandbox';
};
const answerTypeLabels: Record<CallQuestion['answer_type'], string> = {
  text: 'Spoken answer (open or technical)',
  yes_no: 'Yes or no',
  number: 'A number',
};

/** Key points as saved: trimmed, non-empty, at most five. */
const keyPoints = (item: CallQuestion) =>
  item.answer_type === 'text'
    ? (item.key_points ?? [])
        .map((point) => point.trim())
        .filter((point) => point.length >= 2)
        .map((point) => point.slice(0, 200))
        .slice(0, 5)
    : [];
type Page<T> = {
  data: T[];
  total: number;
  pagination: { limit: number; offset: number };
};
type Draft = {
  title: string;
  department: string;
  location: string;
  employmentType: string;
  openings: string;
  salaryMin: string;
  salaryMax: string;
  description: string;
};
type AiProvider = {
  provider: 'openai' | 'anthropic' | 'google_ai';
  label: string;
  environment: 'production' | 'sandbox';
};
const aiChoiceKey = 'hireai.jobDescriptionProvider';
// A per-browser convenience only; storage may be unavailable.
function storedAiChoice() {
  try {
    return localStorage.getItem(aiChoiceKey) ?? '';
  } catch {
    return '';
  }
}
function storeAiChoice(provider: string) {
  try {
    localStorage.setItem(aiChoiceKey, provider);
  } catch {
    /* Remembering the choice is optional. */
  }
}
type GeneratedDescription = AiProvider & {
  description: string;
  model: string;
};
const providerName = (provider: AiProvider) =>
  provider.environment === 'sandbox'
    ? `${provider.label} (sandbox)`
    : provider.label;
const emptyDraft: Draft = {
  title: '',
  department: '',
  location: '',
  employmentType: 'FULL_TIME',
  openings: '1',
  salaryMin: '',
  salaryMax: '',
  description: '',
};
const statuses: JobStatus[] = ['DRAFT', 'APPROVED', 'PUBLISHED', 'CLOSED'];
const steps = [
  'Job Details',
  'AI Job Description',
  'Screening Questions',
  'Publish Job',
];
const formatMoney = (value: number | null) =>
  value === null
    ? 'Not specified'
    : new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
      }).format(value);

function jobDraft(job: Job): Draft {
  return {
    title: job.title,
    department: job.department,
    location: job.location,
    employmentType: job.employment_type,
    openings: String(job.openings),
    salaryMin: job.salary_min === null ? '' : String(job.salary_min),
    salaryMax: job.salary_max === null ? '' : String(job.salary_max),
    description: job.description,
  };
}

export function JobBuilder({
  initialJob,
  role,
  onCancel,
  onSaved,
  applyPageFor,
}: {
  initialJob: Job | null;
  role: JobRole;
  /** HireAI's apply page for a job, which LinkedIn posts link to. */
  applyPageFor?: (jobId: string) => string | undefined;
  onCancel: () => void;
  onSaved: (job: Job, published: boolean, outcome?: PublishOutcome) => void;
}) {
  const [form, setForm] = useState(
    initialJob ? jobDraft(initialJob) : emptyDraft,
  );
  const [criteria, setCriteria] = useState<Criterion[]>(
    initialJob?.screening_criteria ?? [],
  );
  const [autoScreen, setAutoScreen] = useState(initialJob?.auto_screen ?? true);
  const [callQuestions, setCallQuestions] = useState<CallQuestion[]>(
    initialJob?.call_questions ?? [],
  );
  const [previousQuestions, setPreviousQuestions] = useState<
    CallQuestion[] | null
  >(null);
  const [questionsBusy, setQuestionsBusy] = useState(false);
  const [questionsError, setQuestionsError] = useState('');
  const [questionsNotice, setQuestionsNotice] = useState('');
  const [testingCall, setTestingCall] = useState(false);
  const autoDrafted = useRef(false);
  const nextQuestionId = useRef(1);
  const isAdmin = role === 'HR_ADMIN';
  const isManager = role === 'HIRING_MANAGER';
  const callingQuery = useQuery({
    queryKey: ['call-questions-settings'],
    queryFn: () =>
      api<{ enabled: boolean; ai_available: boolean }>(
        '/jobs/call-questions/settings',
      ),
  });
  // Call questions only exist while an HR Admin has AI calling turned on.
  const calling = callingQuery.data?.enabled === true;
  const namedCriteria = criteria.filter((item) => item.label.trim());
  const usableQuestions = callQuestions.filter((item) => item.text.trim());
  const [skill, setSkill] = useState('');
  const skillInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(0);
  const [currentJob, setCurrentJob] = useState<Job | null>(initialJob);
  // Approved or published: still editable until it closes.
  const live = !!initialJob && initialJob.status !== 'DRAFT';
  const published = currentJob?.status === 'PUBLISHED';
  // What candidates see changes only with an HR Admin once approved.
  const lockedDetails = live && !isAdmin;
  const status = currentJob?.status ?? 'DRAFT';
  // Published from here: by an HR Admin (approving it too), or by a
  // recruiter once it's approved. Otherwise a draft goes for approval.
  const canPublish =
    !published && (isAdmin || (role === 'RECRUITER' && status === 'APPROVED'));
  const canSubmit = isManager && status === 'DRAFT';
  const awaiting = status === 'DRAFT' && !!currentJob?.requested_at;
  const sentBack =
    status === 'DRAFT' && !awaiting ? (currentJob?.review_note ?? null) : null;
  const stepLabels = published
    ? [...steps.slice(0, -1), 'Review Changes']
    : canSubmit
      ? [...steps.slice(0, -1), 'Submit for Approval']
      : steps;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nextCriterionId = useRef(1);
  const channelsQuery = useJobChannels(canPublish);
  const [selection, setSelection] = useState<ChannelSelection>(emptySelection);
  const aiQuery = useQuery({
    queryKey: ['job-ai-providers'],
    queryFn: () => api<AiProvider[]>('/jobs/ai-description/providers'),
  });
  const aiProviders = Array.isArray(aiQuery.data) ? aiQuery.data : [];
  const [aiChoice, setAiChoice] = useState(storedAiChoice);
  const aiProvider =
    aiProviders.find((item) => item.provider === aiChoice) ?? aiProviders[0];
  const [aiGuidance, setAiGuidance] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiNotice, setAiNotice] = useState('');
  const [lastGenerated, setLastGenerated] = useState('');
  const [previousDescription, setPreviousDescription] = useState<string | null>(
    null,
  );
  const aiUnavailableReason = aiQuery.isPending
    ? 'Checking AI providers…'
    : aiProvider
      ? ''
      : 'AI drafting is not enabled for your organization. Ask an HR Admin to connect, test and enable OpenAI, Anthropic or Google AI Studio under Integrations.';
  const draftIsUserText =
    form.description.trim() !== '' &&
    form.description.trim() !== lastGenerated.trim();

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function validateStep() {
    if (step === 0) {
      if (form.title.trim().length < 2) return 'Enter a job title.';
      if (!form.department.trim()) return 'Enter a department.';
      if (!form.location.trim()) return 'Enter a location.';
      if (!Number.isInteger(Number(form.openings)) || Number(form.openings) < 1)
        return 'Openings must be a whole number greater than zero.';
    }
    if (step === 1 && form.description.trim().length < 10)
      return 'Add a job description with at least 10 characters.';
    return '';
  }

  function nextStep() {
    const message = validateStep();
    if (message) {
      setError(message);
      return;
    }
    setError('');
    setStep((current) => Math.min(current + 1, steps.length - 1));
  }

  function payload() {
    return {
      title: form.title.trim(),
      department: form.department.trim(),
      location: form.location.trim(),
      employmentType: form.employmentType,
      openings: Number(form.openings),
      salaryMin: form.salaryMin === '' ? null : Number(form.salaryMin),
      salaryMax: form.salaryMax === '' ? null : Number(form.salaryMax),
      description: form.description.trim(),
      screeningCriteria: criteria
        .filter((item) => item.label.trim())
        .map((item) => ({ ...item, label: item.label.trim() })),
      autoScreen,
      // Only sent while calling is on, so turning it off keeps saved questions.
      ...(calling
        ? {
            callQuestions: usableQuestions.map((item) => ({
              ...item,
              text: item.text.trim(),
              key_points: keyPoints(item),
              criterion_id: namedCriteria.some(
                (criterion) => criterion.id === item.criterion_id,
              )
                ? item.criterion_id
                : null,
            })),
          }
        : {}),
    };
  }

  /** Job Details rules shared by saving and AI drafting. */
  function validateDetails() {
    if (form.title.trim().length < 2)
      return { message: 'Enter a job title.', step: 0 };
    if (!form.department.trim())
      return { message: 'Enter a department.', step: 0 };
    if (!form.location.trim()) return { message: 'Enter a location.', step: 0 };
    if (
      !Number.isInteger(Number(form.openings)) ||
      Number(form.openings) < 1 ||
      Number(form.openings) > 100000
    )
      return {
        message: 'Openings must be a whole number between 1 and 100,000.',
        step: 0,
      };
    const salaryMin = form.salaryMin === '' ? null : Number(form.salaryMin);
    const salaryMax = form.salaryMax === '' ? null : Number(form.salaryMax);
    if (
      (salaryMin !== null &&
        (!Number.isFinite(salaryMin) ||
          salaryMin < 0 ||
          salaryMin > 999999999999.99)) ||
      (salaryMax !== null &&
        (!Number.isFinite(salaryMax) ||
          salaryMax < 0 ||
          salaryMax > 999999999999.99))
    )
      return {
        message: 'Enter valid salary amounts within the allowed range.',
        step: 0,
      };
    if (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax)
      return {
        message: 'The salary minimum cannot exceed the maximum.',
        step: 0,
      };
    return null;
  }

  function validateDraft() {
    const details = validateDetails();
    if (details) return details;
    if (form.description.trim().length < 10)
      return {
        message: 'Add a job description with at least 10 characters.',
        step: 1,
      };
    if (
      criteria.some(
        (item) =>
          item.label.trim() &&
          (!Number.isFinite(item.weight) ||
            item.weight <= 0 ||
            item.weight > 100),
      )
    )
      return {
        message: 'Criterion weights must be greater than 0 and at most 100.',
        step: 2,
      };
    if (calling && usableQuestions.some((item) => item.text.trim().length < 5))
      return {
        message: 'Each call question needs at least 5 characters.',
        step: 2,
      };
    return null;
  }

  /** The update: without the details candidates see when they're locked. */
  function changes() {
    const body = payload();
    return lockedDetails
      ? {
          screeningCriteria: body.screeningCriteria,
          autoScreen: body.autoScreen,
          ...('callQuestions' in body
            ? { callQuestions: body.callQuestions }
            : {}),
        }
      : body;
  }

  /** Saves; then publishes, or submits it for approval. */
  async function save(action: 'save' | 'publish' | 'submit') {
    const validation = validateDraft();
    if (validation) {
      setError(validation.message);
      setStep(validation.step);
      return;
    }
    const publish = action === 'publish';
    const channelProblem =
      publish &&
      canPublish &&
      selectionError(
        selection,
        'publish',
        !!applyPageFor?.(currentJob?.id ?? 'new'),
      );
    if (channelProblem) {
      setError(channelProblem);
      setStep(3);
      return;
    }
    setBusy(true);
    setError('');
    try {
      let job = currentJob;
      if (!job) {
        job = await api<Job>('/jobs', {
          method: 'POST',
          body: JSON.stringify(payload()),
        });
        setCurrentJob(job);
      } else if (job.status !== 'CLOSED') {
        // Drafts, and approved or published jobs too.
        job = await api<Job>(`/jobs/${job.id}`, {
          method: 'PATCH',
          body: JSON.stringify(changes()),
        });
        setCurrentJob(job);
      }

      if (action === 'submit' && job.status === 'DRAFT') {
        job = await api<Job>(`/jobs/${job.id}/submit`, { method: 'POST' });
        setCurrentJob(job);
        onSaved(job, false);
        return;
      }

      if (publish && canPublish) {
        if (job.status === 'DRAFT' && isAdmin) {
          job = await api<Job>(`/jobs/${job.id}/approve`, {
            method: 'POST',
          });
          setCurrentJob(job);
        }
        if (job.status === 'APPROVED') {
          job = await api<Job>(`/jobs/${job.id}/publish`, {
            method: 'POST',
          });
          setCurrentJob(job);
        }
        if (job.status !== 'PUBLISHED')
          throw new Error(
            'The job was saved, but it could not be published. Use the job actions to continue.',
          );
        onSaved(
          job,
          true,
          await sendToChannels(job.id, selection, applyPageFor?.(job.id)),
        );
        return;
      }

      onSaved(job, false);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Unable to save this job.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function generateDescription() {
    if (!aiProvider || aiBusy) return;
    const validation = validateDetails();
    if (validation) {
      setError(validation.message);
      setStep(validation.step);
      return;
    }
    setError('');
    setStep(1);
    setAiBusy(true);
    setAiError('');
    setAiNotice('');
    // The description is read-only while generating, so this is current.
    const before = form.description;
    const skills = [
      ...new Set(
        criteria.map((item) => item.label.trim()).filter((label) => label),
      ),
    ].slice(0, 50);
    try {
      const result = await api<GeneratedDescription>('/jobs/ai-description', {
        method: 'POST',
        body: JSON.stringify({
          provider: aiProvider.provider,
          title: form.title.trim(),
          department: form.department.trim(),
          location: form.location.trim(),
          employmentType: form.employmentType,
          openings: Number(form.openings),
          salaryMin: form.salaryMin === '' ? null : Number(form.salaryMin),
          salaryMax: form.salaryMax === '' ? null : Number(form.salaryMax),
          skills: skills.map((label) => label.slice(0, 200)),
          ...(aiGuidance.trim() ? { guidance: aiGuidance.trim() } : {}),
          ...(draftIsUserText
            ? { currentDescription: before.trim().slice(0, 30000) }
            : {}),
        }),
      });
      setPreviousDescription(before);
      setLastGenerated(result.description);
      update('description', result.description);
      setAiNotice(
        `Draft generated with ${providerName(result)}. Review and edit it before saving or publishing.`,
      );
    } catch (reason) {
      setAiError(
        reason instanceof Error
          ? reason.message
          : 'Unable to generate a description. Try again.',
      );
    } finally {
      setAiBusy(false);
    }
  }

  /** Drafts the call questions from the job details, for review. */
  async function generateQuestions(auto = false) {
    if (questionsBusy) return;
    if (validateDetails() || form.description.trim().length < 10) {
      setQuestionsError(
        'Add the job details and a description first, then generate questions.',
      );
      return;
    }
    setQuestionsBusy(true);
    setQuestionsError('');
    setQuestionsNotice('');
    const before = callQuestions;
    try {
      const result = await api<DraftedQuestions>('/jobs/call-questions', {
        method: 'POST',
        body: JSON.stringify({
          // The provider picked for AI drafting on this job, if any.
          ...(aiProvider ? { provider: aiProvider.provider } : {}),
          title: form.title.trim(),
          department: form.department.trim(),
          location: form.location.trim(),
          employmentType: form.employmentType,
          description: form.description.trim().slice(0, 30000),
          screeningCriteria: namedCriteria.slice(0, 100).map((item) => ({
            id: item.id,
            label: item.label.trim().slice(0, 500),
            must_have: item.must_have,
          })),
        }),
      });
      setCallQuestions(result.questions);
      setPreviousQuestions(
        before.some((item) => item.text.trim()) ? before : null,
      );
      setQuestionsNotice(
        `${auto ? 'Questions drafted' : 'New questions drafted'} with ${result.label}. Review and edit them before publishing.`,
      );
    } catch (reason) {
      setQuestionsError(
        (reason instanceof Error
          ? reason.message
          : 'The questions couldn’t be drafted.') +
          (aiProviders.length > 1
            ? ' Choose another provider in “Draft with” and try again, or add the questions yourself.'
            : ' Try again, or add the questions yourself.'),
      );
    } finally {
      setQuestionsBusy(false);
    }
  }

  // Draft once, the first time the recruiter reaches the step with none yet.
  useEffect(() => {
    if (
      step !== 2 ||
      !calling ||
      !callingQuery.data?.ai_available ||
      // Wait for the provider list, so the draft uses the picked provider.
      aiQuery.isPending ||
      autoDrafted.current ||
      callQuestions.length
    )
      return;
    autoDrafted.current = true;
    void generateQuestions(true);
  });

  function updateQuestion(id: string, patch: Partial<CallQuestion>) {
    setCallQuestions((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  function restoreDescription() {
    if (previousDescription === null) return;
    update('description', previousDescription);
    setPreviousDescription(null);
    setAiNotice('Previous description restored.');
  }

  function addSkill() {
    const label = skill.trim();
    if (!label) {
      skillInput.current?.focus();
      return;
    }
    if (
      !criteria.some(
        (item) => item.label.trim().toLowerCase() === label.toLowerCase(),
      )
    ) {
      setCriteria((current) => [
        ...current,
        { id: crypto.randomUUID(), label, weight: 20, must_have: true },
      ]);
    }
    setSkill('');
    skillInput.current?.focus();
  }

  function addCriterion() {
    const id = `criterion-${nextCriterionId.current++}`;
    setCriteria((current) => [
      ...current,
      { id, label: '', weight: 20, must_have: false },
    ]);
  }

  function updateCriterion(id: string, patch: Partial<Criterion>) {
    setCriteria((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  return (
    <section className="job-builder" aria-labelledby="job-builder-title">
      <header className="job-editor-heading">
        <button
          type="button"
          className="job-back-button"
          aria-label="Back to jobs"
          onClick={onCancel}
          disabled={busy}
        >
          <FontAwesomeIcon icon={faArrowLeft} aria-hidden="true" />
        </button>
        <div>
          <h1 id="job-builder-title">
            {initialJob
              ? isManager
                ? 'Edit Job Request'
                : 'Edit Job'
              : isAdmin
                ? 'Create and Publish Job'
                : isManager
                  ? 'Request a Job'
                  : 'Create Job'}
          </h1>
          <p>
            {published
              ? 'This job is published: your changes show on the careers page as soon as you save them.'
              : live
                ? role === 'HIRING_MANAGER'
                  ? 'This job is approved: a recruiter publishes it.'
                  : 'This job is approved. Save your changes, or publish it.'
                : awaiting
                  ? `Submitted for approval on ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(currentJob!.requested_at!))}. You can still change it while it waits.`
                  : isAdmin
                    ? 'Add job details, define screening criteria, and publish your opening.'
                    : isManager
                      ? 'Describe the role you need. An HR Admin approves it, then a recruiter publishes it.'
                      : 'Add the job details and screening criteria, then submit it for an HR Admin’s approval.'}
          </p>
          {sentBack && (
            <p className="job-live-note" role="note">
              <strong>Sent back by an HR Admin:</strong> {sentBack} Make the
              changes, then submit it again.
            </p>
          )}
        </div>
      </header>

      <ol className="job-stepper" aria-label="Job creation steps">
        {stepLabels.map((label, index) => (
          <li
            key={label}
            className={
              index === step
                ? 'step-current'
                : index < step
                  ? 'step-complete'
                  : ''
            }
            aria-current={index === step ? 'step' : undefined}
          >
            <span>{index + 1}</span>
            <strong>{label}</strong>
          </li>
        ))}
      </ol>

      <div className="job-builder-layout">
        <form className="job-form" onSubmit={(event) => event.preventDefault()}>
          {step === 0 && (
            <section className="job-form-section">
              <div className="job-details-layout">
                <div className="job-details-main">
                  <div className="job-form-section-heading">
                    <FontAwesomeIcon icon={faBriefcase} aria-hidden="true" />
                    <div>
                      <h3>Job Details</h3>
                      <p>Define the basic information for this job opening.</p>
                    </div>
                  </div>
                  {lockedDetails && (
                    <p className="job-live-note" role="note">
                      Only an HR Admin can change these details now the job is
                      approved: they&apos;re what candidates see. You can still
                      change the skills, screening criteria and call questions.
                    </p>
                  )}
                  <div className="job-fields">
                    <label className="form-field">
                      <span className="form-field-label">
                        <FontAwesomeIcon
                          icon={faBriefcase}
                          aria-hidden="true"
                        />
                        Job title <span aria-hidden="true">*</span>
                      </span>
                      <input
                        required
                        minLength={2}
                        maxLength={200}
                        disabled={lockedDetails}
                        value={form.title}
                        onChange={(event) =>
                          update('title', event.target.value)
                        }
                        autoComplete="off"
                      />
                    </label>
                    <label className="form-field">
                      <span className="form-field-label">
                        <FontAwesomeIcon icon={faBuilding} aria-hidden="true" />
                        Department <span aria-hidden="true">*</span>
                      </span>
                      <input
                        required
                        maxLength={150}
                        list="job-departments"
                        disabled={lockedDetails}
                        value={form.department}
                        onChange={(event) =>
                          update('department', event.target.value)
                        }
                      />
                      <datalist id="job-departments">
                        <option value="Engineering" />
                        <option value="Human Resources" />
                        <option value="Finance" />
                        <option value="Sales" />
                        <option value="Operations" />
                      </datalist>
                    </label>
                    <label className="form-field">
                      <span className="form-field-label">
                        <FontAwesomeIcon
                          icon={faLocationDot}
                          aria-hidden="true"
                        />
                        Location <span aria-hidden="true">*</span>
                      </span>
                      <input
                        required
                        maxLength={200}
                        disabled={lockedDetails}
                        value={form.location}
                        onChange={(event) =>
                          update('location', event.target.value)
                        }
                        placeholder="City, country or remote"
                      />
                    </label>
                    <label className="form-field">
                      <span className="form-field-label">
                        <FontAwesomeIcon
                          icon={faBriefcase}
                          aria-hidden="true"
                        />
                        Employment type
                      </span>
                      <span className="select-control">
                        <select
                          disabled={lockedDetails}
                          value={form.employmentType}
                          onChange={(event) =>
                            update('employmentType', event.target.value)
                          }
                        >
                          <option value="FULL_TIME">Full time</option>
                          <option value="PART_TIME">Part time</option>
                          <option value="CONTRACT">Contract</option>
                          <option value="INTERN">Intern</option>
                        </select>
                        <FontAwesomeIcon
                          className="select-chevron"
                          icon={faChevronDown}
                          aria-hidden="true"
                        />
                      </span>
                    </label>
                    <label className="form-field">
                      <span className="form-field-label">Open positions</span>
                      <input
                        type="number"
                        min="1"
                        max="100000"
                        step="1"
                        disabled={lockedDetails}
                        value={form.openings}
                        onChange={(event) =>
                          update('openings', event.target.value)
                        }
                      />
                    </label>
                    <div className="form-field salary-range-field">
                      <span className="form-field-label salary-range-label">
                        <FontAwesomeIcon icon={faCoins} aria-hidden="true" />
                        Annual salary range (INR)
                      </span>
                      <div className="salary-range-inputs">
                        <input
                          aria-label="Annual salary minimum (INR)"
                          type="number"
                          min="0"
                          max="999999999999.99"
                          step="1000"
                          disabled={lockedDetails}
                          value={form.salaryMin}
                          onChange={(event) =>
                            update('salaryMin', event.target.value)
                          }
                          placeholder="Minimum"
                        />
                        <span aria-hidden="true">–</span>
                        <input
                          aria-label="Annual salary maximum (INR)"
                          type="number"
                          min="0"
                          max="999999999999.99"
                          step="1000"
                          disabled={lockedDetails}
                          value={form.salaryMax}
                          onChange={(event) =>
                            update('salaryMax', event.target.value)
                          }
                          placeholder="Maximum"
                        />
                      </div>
                    </div>
                  </div>
                  <label className="form-field description-field">
                    <span className="form-field-label">
                      <FontAwesomeIcon icon={faFileLines} aria-hidden="true" />
                      Job description <span aria-hidden="true">*</span>
                    </span>
                    <textarea
                      required
                      minLength={10}
                      maxLength={30000}
                      rows={8}
                      disabled={lockedDetails}
                      value={form.description}
                      readOnly={aiBusy}
                      onChange={(event) =>
                        update('description', event.target.value)
                      }
                      placeholder="Describe the responsibilities, qualifications, and experience for this role."
                    />
                  </label>
                </div>
                <div className="job-details-aside">
                  <section className="job-settings-panel">
                    <div className="job-settings-heading">
                      <FontAwesomeIcon icon={faTags} aria-hidden="true" />
                      <h3>Required skills</h3>
                      <span className="required-mark" aria-hidden="true">
                        *
                      </span>
                    </div>
                    <div className="skill-chips">
                      {criteria
                        .filter((item) => item.label.trim())
                        .map((item) => (
                          <span className="skill-chip" key={item.id}>
                            {item.label}
                            <button
                              type="button"
                              aria-label={`Remove ${item.label}`}
                              onClick={() =>
                                setCriteria((current) =>
                                  current.filter(
                                    (criterion) => criterion.id !== item.id,
                                  ),
                                )
                              }
                            >
                              <FontAwesomeIcon
                                icon={faXmark}
                                aria-hidden="true"
                              />
                            </button>
                          </span>
                        ))}
                      {!criteria.some((item) => item.label.trim()) && (
                        <span className="empty-skills">
                          Add screening requirements for this job.
                        </span>
                      )}
                    </div>
                    <div className="skill-entry">
                      <input
                        ref={skillInput}
                        aria-label="Add skill"
                        placeholder="Type a skill, e.g. PHP"
                        value={skill}
                        maxLength={200}
                        disabled={busy}
                        onChange={(event) => setSkill(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addSkill();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="add-skill-button"
                        disabled={busy}
                        onClick={addSkill}
                      >
                        <FontAwesomeIcon icon={faPlus} aria-hidden="true" /> Add
                        Skill
                      </button>
                    </div>
                  </section>

                  <section className="job-settings-panel calling-settings">
                    <div className="job-settings-heading">
                      <FontAwesomeIcon
                        icon={faPhoneVolume}
                        aria-hidden="true"
                      />
                      <div>
                        <h3>AI Calling</h3>
                        <p>Screening calls to shortlisted candidates.</p>
                      </div>
                      {callingQuery.isSuccess && (
                        <span
                          className={`status-pill ${calling ? 'status-live' : 'status-muted'}`}
                        >
                          {calling ? 'On' : 'Off'}
                        </span>
                      )}
                    </div>
                    {callingQuery.isPending ? (
                      <p className="calling-note">Checking AI calling…</p>
                    ) : calling ? (
                      <>
                        <p className="calling-note">
                          The AI phones shortlisted candidates who agreed to be
                          called, and asks this job’s call questions.
                        </p>
                        <p className="calling-label">Call questions</p>
                        <div className="calling-flow">
                          {usableQuestions.length
                            ? `${usableQuestions.length} question${usableQuestions.length === 1 ? '' : 's'} ready`
                            : 'None yet'}
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              const problem = validateStep();
                              if (problem) {
                                setError(problem);
                                return;
                              }
                              setError('');
                              setStep(2);
                            }}
                          >
                            {usableQuestions.length
                              ? 'Review questions'
                              : 'Add questions'}
                          </button>
                        </div>
                        <p className="calling-label">Language</p>
                        <p className="calling-note">
                          English or Hindi, chosen when a recruiter starts a
                          call. Automatic calls are in English.
                        </p>
                      </>
                    ) : (
                      <p className="calling-unavailable">
                        AI calling is off for your organization, so this job has
                        no call questions.{' '}
                        {isAdmin ? (
                          <Link to="/integrations">
                            Turn it on in Integrations → AI calling.
                          </Link>
                        ) : (
                          'An HR Admin can turn it on in Integrations.'
                        )}
                      </p>
                    )}
                  </section>
                </div>
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="job-form-section">
              {lockedDetails && (
                <p className="job-live-note" role="note">
                  Only an HR Admin can change the description now the job is
                  approved.
                </p>
              )}
              <div className="job-form-section-heading">
                <FontAwesomeIcon icon={faFileLines} aria-hidden="true" />
                <div>
                  <h3>Job description</h3>
                  <p>
                    Generate a draft from the job details, then review and edit
                    it before publishing.
                  </p>
                </div>
              </div>
              <section
                className="ai-generate-panel"
                aria-labelledby="ai-generate-title"
              >
                <div className="ai-generate-heading">
                  <FontAwesomeIcon
                    icon={faWandMagicSparkles}
                    aria-hidden="true"
                  />
                  <h4 id="ai-generate-title">Generate with AI</h4>
                </div>
                {aiUnavailableReason ? (
                  <p
                    className="ai-generate-unavailable"
                    role={aiQuery.isPending ? 'status' : undefined}
                  >
                    {aiUnavailableReason}
                  </p>
                ) : (
                  <>
                    {aiProviders.length > 1 ? (
                      <label className="form-field">
                        AI provider
                        <span className="select-control">
                          <select
                            value={aiProvider!.provider}
                            disabled={aiBusy}
                            onChange={(event) => {
                              setAiChoice(event.target.value);
                              storeAiChoice(event.target.value);
                            }}
                          >
                            {aiProviders.map((item) => (
                              <option key={item.provider} value={item.provider}>
                                {providerName(item)}
                              </option>
                            ))}
                          </select>
                          <FontAwesomeIcon
                            className="select-chevron"
                            icon={faChevronDown}
                            aria-hidden="true"
                          />
                        </span>
                      </label>
                    ) : (
                      <p className="ai-generate-provider">
                        Uses your organization&apos;s{' '}
                        <strong>{providerName(aiProvider!)}</strong> connection.
                      </p>
                    )}
                    <label className="form-field">
                      Guidance for AI (optional)
                      <textarea
                        rows={2}
                        maxLength={2000}
                        value={aiGuidance}
                        disabled={aiBusy}
                        onChange={(event) => setAiGuidance(event.target.value)}
                        placeholder="e.g. 4–6 years of experience, hybrid in Noida, mentoring junior developers"
                      />
                    </label>
                    <div className="ai-generate-actions">
                      <button
                        type="button"
                        className="button-primary"
                        disabled={aiBusy || busy || lockedDetails}
                        aria-busy={aiBusy}
                        onClick={() => void generateDescription()}
                      >
                        <FontAwesomeIcon
                          icon={faWandMagicSparkles}
                          aria-hidden="true"
                        />{' '}
                        {aiBusy
                          ? 'Generating…'
                          : lastGenerated
                            ? 'Regenerate description'
                            : 'Generate description'}
                      </button>
                      {previousDescription !== null && !aiBusy && (
                        <button type="button" onClick={restoreDescription}>
                          Restore previous description
                        </button>
                      )}
                    </div>
                    <p className="ai-generate-hint">
                      {draftIsUserText
                        ? 'Your current description will be used as a starting point.'
                        : 'Uses the title, department, location, employment type, salary and required skills.'}{' '}
                      Job details are sent to the provider; nothing is saved
                      until you save the job.
                    </p>
                  </>
                )}
                {aiError && (
                  <p className="form-error" role="alert">
                    {aiError}
                  </p>
                )}
                {aiNotice && (
                  <p className="form-success" role="status">
                    {aiNotice}
                  </p>
                )}
              </section>
              <label className="form-field description-field">
                Description <span aria-hidden="true">*</span>
                <textarea
                  required
                  minLength={10}
                  maxLength={30000}
                  rows={14}
                  disabled={lockedDetails}
                  value={form.description}
                  readOnly={aiBusy}
                  aria-busy={aiBusy}
                  onChange={(event) =>
                    update('description', event.target.value)
                  }
                  placeholder="Describe the role, responsibilities, and experience you are looking for."
                />
              </label>
            </section>
          )}

          {step === 2 && (
            <section className="job-form-section">
              <div className="job-form-section-heading">
                <FontAwesomeIcon icon={faTags} aria-hidden="true" />
                <div>
                  <h3>Screening criteria</h3>
                  <p>
                    Add requirements used as the job&apos;s screening criteria.
                  </p>
                </div>
              </div>
              {live && (
                <p className="job-live-note" role="note">
                  Changes here apply to new screenings and new AI calls.
                  Applicants already screened keep their score until you screen
                  them again, and calls already planned ask the questions they
                  were planned with.
                </p>
              )}
              <div className="criteria-list">
                {criteria.map((criterion) => (
                  <fieldset className="criterion-row" key={criterion.id}>
                    <legend>Criterion</legend>
                    <label className="form-field">
                      Requirement
                      <input
                        maxLength={500}
                        value={criterion.label}
                        onChange={(event) =>
                          updateCriterion(criterion.id, {
                            label: event.target.value,
                          })
                        }
                        placeholder="e.g. 3+ years of React experience"
                      />
                    </label>
                    <label className="form-field">
                      Weight
                      <input
                        type="number"
                        min="1"
                        max="100"
                        value={criterion.weight}
                        onChange={(event) =>
                          updateCriterion(criterion.id, {
                            weight: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label className="criterion-required">
                      <input
                        type="checkbox"
                        checked={criterion.must_have}
                        onChange={(event) =>
                          updateCriterion(criterion.id, {
                            must_have: event.target.checked,
                          })
                        }
                      />
                      Must have
                    </label>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        setCriteria((current) =>
                          current.filter((item) => item.id !== criterion.id),
                        )
                      }
                    >
                      Remove
                    </button>
                  </fieldset>
                ))}
              </div>
              <button type="button" onClick={addCriterion}>
                <FontAwesomeIcon icon={faPlus} aria-hidden="true" /> Add
                screening criterion
              </button>
              <label className="job-auto-screen">
                <input
                  type="checkbox"
                  checked={autoScreen}
                  onChange={(event) => setAutoScreen(event.target.checked)}
                />
                <span>
                  <strong>Screen new applications with AI</strong>
                  <small>
                    {aiProviders[0]
                      ? `${providerName(aiProviders[0])} rates each resume against these criteria and HireAI scores it using the weights. Recruiters make every decision.`
                      : 'Starts once an HR Admin enables OpenAI, Anthropic or Google AI Studio in Integrations. Recruiters make every decision.'}{' '}
                    {criteria.some((item) => item.label.trim())
                      ? ''
                      : 'Without criteria, the AI picks the key requirements from the description.'}
                  </small>
                </span>
              </label>
              {calling && (
                <div
                  className="call-questions"
                  aria-labelledby="call-questions-title"
                  role="group"
                >
                  <div className="call-questions-heading">
                    <div>
                      <h4 id="call-questions-title">
                        <FontAwesomeIcon
                          icon={faPhoneVolume}
                          aria-hidden="true"
                        />{' '}
                        AI call questions
                      </h4>
                      <p>
                        The AI asks these on a short call with each candidate
                        who agreed to be called, and the recruiter gets the
                        answers. Nobody is rejected automatically. Ask only
                        about the job, never about age, marriage, family,
                        religion, caste or health.
                      </p>
                    </div>
                    <div className="call-questions-actions">
                      {aiProviders.length > 1 && aiProvider && (
                        <label className="form-field">
                          Draft with
                          <span className="select-control">
                            <select
                              value={aiProvider.provider}
                              disabled={questionsBusy}
                              onChange={(event) => {
                                // Shared with the job description's choice.
                                setAiChoice(event.target.value);
                                storeAiChoice(event.target.value);
                              }}
                            >
                              {aiProviders.map((item) => (
                                <option
                                  key={item.provider}
                                  value={item.provider}
                                >
                                  {providerName(item)}
                                </option>
                              ))}
                            </select>
                            <FontAwesomeIcon
                              className="select-chevron"
                              icon={faChevronDown}
                              aria-hidden="true"
                            />
                          </span>
                        </label>
                      )}
                      <button
                        type="button"
                        className="button-ai"
                        disabled={
                          questionsBusy || !callingQuery.data?.ai_available
                        }
                        title={
                          callingQuery.data?.ai_available
                            ? undefined
                            : 'An HR Admin must enable an AI provider in Integrations.'
                        }
                        onClick={() => void generateQuestions()}
                      >
                        <FontAwesomeIcon
                          icon={faWandMagicSparkles}
                          aria-hidden="true"
                        />{' '}
                        {questionsBusy
                          ? 'Drafting…'
                          : callQuestions.length
                            ? 'Regenerate with AI'
                            : 'Generate with AI'}
                      </button>
                    </div>
                  </div>
                  {questionsBusy && (
                    <p role="status" className="call-questions-status">
                      Drafting questions from the job details…
                    </p>
                  )}
                  {questionsNotice && (
                    <p role="status" className="call-questions-status">
                      {questionsNotice}{' '}
                      {previousQuestions && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            setCallQuestions(previousQuestions);
                            setPreviousQuestions(null);
                            setQuestionsNotice('Previous questions restored.');
                          }}
                        >
                          Restore previous questions
                        </button>
                      )}
                    </p>
                  )}
                  {questionsError && (
                    <p role="alert" className="form-error">
                      {questionsError}
                    </p>
                  )}
                  <ol className="call-question-list">
                    {callQuestions.map((item, index) => (
                      <li key={item.id}>
                        <fieldset className="call-question-row">
                          <legend className="sr-only">
                            Call question {index + 1}
                          </legend>
                          <label className="form-field call-question-text">
                            Question {index + 1}
                            <input
                              maxLength={300}
                              value={item.text}
                              onChange={(event) =>
                                updateQuestion(item.id, {
                                  text: event.target.value,
                                })
                              }
                              placeholder="e.g. What does a service provider do in Laravel?"
                            />
                          </label>
                          <label className="form-field">
                            Answer
                            <span className="select-control">
                              <select
                                value={item.answer_type}
                                onChange={(event) => {
                                  const answer = event.target
                                    .value as CallQuestion['answer_type'];
                                  updateQuestion(item.id, {
                                    answer_type: answer,
                                    expected_answer:
                                      answer === 'yes_no'
                                        ? item.expected_answer
                                        : null,
                                    key_points:
                                      answer === 'text' ? item.key_points : [],
                                  });
                                }}
                              >
                                {Object.entries(answerTypeLabels).map(
                                  ([value, text]) => (
                                    <option key={value} value={value}>
                                      {text}
                                    </option>
                                  ),
                                )}
                              </select>
                              <FontAwesomeIcon
                                className="select-chevron"
                                icon={faChevronDown}
                                aria-hidden="true"
                              />
                            </span>
                          </label>
                          {item.answer_type === 'yes_no' && (
                            <label className="form-field">
                              Flag if the answer isn’t
                              <span className="select-control">
                                <select
                                  value={item.expected_answer ?? ''}
                                  onChange={(event) =>
                                    updateQuestion(item.id, {
                                      expected_answer:
                                        (event.target.value as 'yes' | 'no') ||
                                        null,
                                    })
                                  }
                                >
                                  <option value="">Don’t flag</option>
                                  <option value="yes">Yes</option>
                                  <option value="no">No</option>
                                </select>
                                <FontAwesomeIcon
                                  className="select-chevron"
                                  icon={faChevronDown}
                                  aria-hidden="true"
                                />
                              </span>
                            </label>
                          )}
                          <label className="form-field">
                            Checks criterion
                            <span className="select-control">
                              <select
                                value={
                                  namedCriteria.some(
                                    (criterion) =>
                                      criterion.id === item.criterion_id,
                                  )
                                    ? (item.criterion_id ?? '')
                                    : ''
                                }
                                onChange={(event) =>
                                  updateQuestion(item.id, {
                                    criterion_id: event.target.value || null,
                                  })
                                }
                              >
                                <option value="">None</option>
                                {namedCriteria.map((criterion) => (
                                  <option
                                    key={criterion.id}
                                    value={criterion.id}
                                  >
                                    {criterion.label}
                                  </option>
                                ))}
                              </select>
                              <FontAwesomeIcon
                                className="select-chevron"
                                icon={faChevronDown}
                                aria-hidden="true"
                              />
                            </span>
                          </label>
                          {item.answer_type === 'text' && (
                            <label className="form-field call-question-points">
                              What a good answer covers
                              <textarea
                                rows={3}
                                maxLength={1000}
                                value={(item.key_points ?? []).join('\n')}
                                onChange={(event) =>
                                  updateQuestion(item.id, {
                                    key_points: event.target.value
                                      .split('\n')
                                      .slice(0, 5),
                                  })
                                }
                                placeholder={
                                  'One point per line, e.g.\nRegisters bindings in the service container\nboot() runs after every provider is registered'
                                }
                              />
                              <small>
                                Used to assess the answer after the call. The AI
                                never reads these out.
                              </small>
                            </label>
                          )}
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`Remove call question ${index + 1}`}
                            onClick={() =>
                              setCallQuestions((current) =>
                                current.filter((other) => other.id !== item.id),
                              )
                            }
                          >
                            Remove
                          </button>
                        </fieldset>
                      </li>
                    ))}
                  </ol>
                  {callQuestions.length < 10 && (
                    <button
                      type="button"
                      onClick={() =>
                        setCallQuestions((current) => [
                          ...current,
                          {
                            id: `question-${nextQuestionId.current++}`,
                            text: '',
                            answer_type: 'text',
                            expected_answer: null,
                            criterion_id: null,
                            key_points: [],
                          },
                        ])
                      }
                    >
                      <FontAwesomeIcon icon={faPlus} aria-hidden="true" /> Add
                      call question
                    </button>
                  )}
                  <div className="call-questions-try">
                    {currentJob ? (
                      <button
                        type="button"
                        disabled={!usableQuestions.length}
                        onClick={() => setTestingCall(true)}
                      >
                        <FontAwesomeIcon
                          icon={faMicrophone}
                          aria-hidden="true"
                        />{' '}
                        Try a test call
                      </button>
                    ) : null}
                    <small>
                      {currentJob
                        ? 'Talk to the AI from your browser, as a candidate would, with these questions.'
                        : 'Save the job to try a call with these questions.'}
                    </small>
                  </div>
                  {testingCall && currentJob && (
                    <TestCallDialog
                      jobId={currentJob.id}
                      questions={usableQuestions.map((item) => ({
                        ...item,
                        text: item.text.trim(),
                        key_points: keyPoints(item),
                      }))}
                      onClose={() => setTestingCall(false)}
                    />
                  )}
                </div>
              )}
            </section>
          )}

          {step === 3 && (
            <section className="job-form-section">
              <div className="job-form-section-heading">
                <FontAwesomeIcon icon={faFileCircleCheck} aria-hidden="true" />
                <div>
                  <h3>
                    {published
                      ? 'Review changes'
                      : canSubmit
                        ? 'Review and submit'
                        : 'Review and publish'}
                  </h3>
                  <p>
                    {published
                      ? 'Check the job before saving your changes.'
                      : canSubmit
                        ? 'Check the details before submitting this job for approval.'
                        : 'Check the details before saving or publishing this job.'}
                  </p>
                </div>
              </div>
              <dl className="job-review">
                <div>
                  <dt>Job title</dt>
                  <dd>{form.title || 'Not provided'}</dd>
                </div>
                <div>
                  <dt>Department</dt>
                  <dd>{form.department || 'Not provided'}</dd>
                </div>
                <div>
                  <dt>Location</dt>
                  <dd>{form.location || 'Not provided'}</dd>
                </div>
                <div>
                  <dt>Employment</dt>
                  <dd>{form.employmentType.replaceAll('_', ' ')}</dd>
                </div>
                <div>
                  <dt>Openings</dt>
                  <dd>{form.openings}</dd>
                </div>
                <div>
                  <dt>Salary range</dt>
                  <dd>
                    {form.salaryMin
                      ? formatMoney(Number(form.salaryMin))
                      : 'Not specified'}{' '}
                    –{' '}
                    {form.salaryMax
                      ? formatMoney(Number(form.salaryMax))
                      : 'Not specified'}
                  </dd>
                </div>
                <div className="job-review-description">
                  <dt>Description</dt>
                  <dd>{form.description || 'Not provided'}</dd>
                </div>
                <div>
                  <dt>Screening criteria</dt>
                  <dd>{criteria.filter((item) => item.label.trim()).length}</dd>
                </div>
                <div>
                  <dt>AI screening</dt>
                  <dd>{autoScreen ? 'New applications' : 'Off'}</dd>
                </div>
                {calling && (
                  <div className="job-review-questions">
                    <dt>AI call questions</dt>
                    <dd>
                      {usableQuestions.length ? (
                        <ol>
                          {usableQuestions.map((item) => (
                            <li key={item.id}>
                              {item.text.trim()}{' '}
                              <small>
                                {answerTypeLabels[item.answer_type]}
                                {item.expected_answer
                                  ? ` · flagged unless “${item.expected_answer === 'yes' ? 'Yes' : 'No'}”`
                                  : ''}
                                {keyPoints(item).length
                                  ? ` · ${keyPoints(item).length} key ${keyPoints(item).length === 1 ? 'point' : 'points'}`
                                  : ''}
                              </small>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        'None yet. Add them in the Screening Questions step.'
                      )}
                    </dd>
                  </div>
                )}
              </dl>
              {published ? (
                <div className="feature-notice">
                  <strong>Your careers page shows the changes at once.</strong>
                  <span>
                    Posts already shared to LinkedIn or other channels
                    aren&apos;t changed. Use Post to channels on the Jobs list
                    to share the job again.
                  </span>
                </div>
              ) : canPublish ? (
                <ChannelPicker
                  query={channelsQuery}
                  selection={selection}
                  onChange={(next) => {
                    setSelection(next);
                    setError('');
                  }}
                  job={form}
                  disabled={busy}
                  applyUrl={
                    currentJob ? applyPageFor?.(currentJob.id) : undefined
                  }
                  applyPageLater={!currentJob && !!applyPageFor?.('new')}
                />
              ) : canSubmit ? (
                <div className="feature-notice">
                  <strong>
                    {awaiting
                      ? 'Waiting for an HR Admin to approve it.'
                      : 'Next: an HR Admin approves it.'}
                  </strong>
                  <span>
                    Once approved, a recruiter publishes it to your careers page
                    and the channels they choose, such as LinkedIn.
                  </span>
                </div>
              ) : (
                <div className="feature-notice">
                  <strong>Approved: a recruiter publishes it.</strong>
                  <span>
                    They choose where it&apos;s posted, such as your careers
                    website or LinkedIn.
                  </span>
                </div>
              )}
              {currentJob && (
                <p className="job-current-status">
                  Current status: <strong>{currentJob.status}</strong>
                </p>
              )}
            </section>
          )}

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <footer className="job-builder-actions">
            <div className="job-builder-nav">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError('');
                  if (step === 0) onCancel();
                  else setStep((current) => Math.max(current - 1, 0));
                }}
              >
                {step === 0 ? (
                  'Cancel'
                ) : (
                  <>
                    <FontAwesomeIcon icon={faArrowLeft} aria-hidden="true" />{' '}
                    Back
                  </>
                )}
              </button>
              {step < steps.length - 1 && (
                <button type="button" aria-label="Continue" onClick={nextStep}>
                  Continue{' '}
                  <FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />
                </button>
              )}
            </div>
            <div className="job-builder-operations">
              <button
                type="button"
                aria-label={live ? 'Save changes' : 'Save draft'}
                className={published ? 'button-primary' : undefined}
                disabled={busy || aiBusy}
                onClick={() => void save('save')}
              >
                {busy ? (
                  'Saving…'
                ) : (
                  <>
                    <FontAwesomeIcon icon={faFloppyDisk} aria-hidden="true" />{' '}
                    {live ? 'Save Changes' : 'Save Draft'}
                  </>
                )}
              </button>
              <button
                type="button"
                className="button-ai"
                disabled={busy || aiBusy || !aiProvider || lockedDetails}
                title={
                  aiUnavailableReason ||
                  'Draft the job description from these details.'
                }
                onClick={() => void generateDescription()}
              >
                <FontAwesomeIcon
                  icon={faWandMagicSparkles}
                  aria-hidden="true"
                />{' '}
                {aiBusy ? 'Generating…' : 'Generate with AI'}
              </button>
              {/* Publishing happens on the review step, where the
                  destinations are chosen. */}
              {canSubmit && !awaiting && step === steps.length - 1 && (
                <button
                  type="button"
                  className="button-primary"
                  disabled={busy || aiBusy}
                  aria-label="Submit for approval"
                  title="Saves the job and asks an HR Admin to approve it."
                  onClick={() => void save('submit')}
                >
                  {busy ? (
                    'Submitting…'
                  ) : (
                    <>
                      <FontAwesomeIcon icon={faPaperPlane} aria-hidden="true" />{' '}
                      Submit for Approval
                    </>
                  )}
                </button>
              )}
              {canPublish && step === steps.length - 1 && (
                <button
                  type="button"
                  className="button-primary"
                  disabled={busy || aiBusy}
                  aria-label="Publish Job"
                  title="Publishes the job in HireAI and posts it to the channels you selected."
                  onClick={() => void save('publish')}
                >
                  {busy ? (
                    'Publishing…'
                  ) : (
                    <>
                      <FontAwesomeIcon icon={faPaperPlane} aria-hidden="true" />{' '}
                      Publish Job{' '}
                      <FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />
                    </>
                  )}
                </button>
              )}
            </div>
          </footer>
        </form>

        <aside className="job-workflow-card">
          <div className="job-workflow-header">
            <h3>
              <FontAwesomeIcon icon={faBullseye} aria-hidden="true" /> Complete
              Hiring Flow
            </h3>
            <p>
              From job creation to interview scheduling. Available features are
              clearly identified below.
            </p>
          </div>
          <ul className="job-workflow-list">
            <li>
              <FontAwesomeIcon icon={faFilePen} aria-hidden="true" />
              <div>
                <strong>AI job description</strong>
                <p>
                  {aiProvider
                    ? `Draft from the job details with ${providerName(aiProvider)}.`
                    : aiQuery.isPending
                      ? 'Checking AI providers…'
                      : 'An HR Admin must enable an AI provider (OpenAI, Anthropic or Google AI Studio) in Integrations.'}
                </p>
              </div>
              {aiProvider ? (
                <span className="status-pill status-live">Available</span>
              ) : (
                <span className="status-pill status-muted">Unavailable</span>
              )}
            </li>
            <li>
              <FontAwesomeIcon icon={faFileCircleCheck} aria-hidden="true" />
              <div>
                <strong>Resume screening</strong>
                <p>
                  {!aiProviders[0]
                    ? aiQuery.isPending
                      ? 'Checking AI providers…'
                      : 'An HR Admin must enable an AI provider in Integrations.'
                    : autoScreen
                      ? `New applications are screened with ${providerName(aiProviders[0])}.`
                      : 'Off for this job. Recruiters can still screen applications themselves.'}
                </p>
              </div>
              {aiProviders[0] && autoScreen ? (
                <span className="status-pill status-live">Available</span>
              ) : (
                <span className="status-pill status-muted">
                  {aiProviders[0] ? 'Off' : 'Unavailable'}
                </span>
              )}
            </li>
            <li>
              <FontAwesomeIcon icon={faPhoneVolume} aria-hidden="true" />
              <div>
                <strong>Candidate calling</strong>
                <p>
                  {calling
                    ? usableQuestions.length
                      ? `The AI calls shortlisted candidates with ${usableQuestions.length} question${usableQuestions.length === 1 ? '' : 's'}.`
                      : 'Add the call questions in the Screening Questions step.'
                    : 'An HR Admin can turn on AI calling in Integrations.'}
                </p>
              </div>
              <span
                className={`status-pill ${calling && usableQuestions.length ? 'status-live' : 'status-muted'}`}
              >
                {calling
                  ? usableQuestions.length
                    ? 'Available'
                    : 'Needs questions'
                  : 'Off'}
              </span>
            </li>
            <li>
              <FontAwesomeIcon icon={faCalendarCheck} aria-hidden="true" />
              <div>
                <strong>Interview scheduling</strong>
                <p>Schedule interviews from an eligible application.</p>
              </div>
              <span className="status-pill status-live">Available</span>
            </li>
          </ul>
          <div className="job-workflow-steps" aria-label="Hiring workflow">
            <span>
              <FontAwesomeIcon icon={faBriefcase} aria-hidden="true" />
              Create Job
            </span>
            <FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />
            <span>
              <FontAwesomeIcon icon={faMicrochip} aria-hidden="true" />
              AI Screen
            </span>
            <FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />
            <span>
              <FontAwesomeIcon icon={faPhone} aria-hidden="true" />
              AI Call
            </span>
            <FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />
            <span>
              <FontAwesomeIcon icon={faCalendarCheck} aria-hidden="true" />
              Schedule
            </span>
          </div>
        </aside>
      </div>
    </section>
  );
}

/** A job's status, and where it is in request → approval → publishing. */
function JobStatusCell({
  job,
  canApprove,
  canManage,
}: {
  job: Job;
  canApprove: boolean;
  canManage: boolean;
}) {
  const awaiting = job.status === 'DRAFT' && !!job.requested_at;
  const sentBack = job.status === 'DRAFT' && !awaiting && !!job.review_note;
  const label = awaiting
    ? 'Awaiting approval'
    : sentBack
      ? 'Sent back'
      : job.status[0] + job.status.slice(1).toLowerCase();
  const hint = awaiting
    ? job.created_by_name
      ? `Requested by ${job.created_by_name}${
          canManage && !canApprove ? ' · waiting for HR Admin approval' : ''
        }`
      : null
    : sentBack
      ? `Note: ${job.review_note}`
      : job.status === 'DRAFT'
        ? canApprove
          ? job.created_by_name
            ? `Being drafted by ${job.created_by_name}`
            : null
          : canManage
            ? 'Not submitted for approval yet'
            : 'Submit it for approval when it’s ready'
        : job.status === 'APPROVED'
          ? canManage
            ? 'Ready to publish'
            : 'A recruiter publishes it next'
          : null;
  return (
    <>
      <span
        className={`status-pill status-${
          awaiting
            ? 'awaiting'
            : sentBack
              ? 'sent-back'
              : job.status.toLowerCase()
        }`}
      >
        {label}
      </span>
      {hint && <small className="job-status-hint">{hint}</small>}
    </>
  );
}

/** An HR Admin sends a request back to whoever asked, saying what to change. */
function SendBackDialog({
  job,
  onClose,
  onDone,
}: {
  job: Job;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => opener?.focus();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/jobs/${job.id}/send-back`, {
        method: 'POST',
        body: JSON.stringify({ note: note.trim() }),
      });
      onDone(
        `${job.title} was sent back${
          job.created_by_name ? ` to ${job.created_by_name}` : ''
        } with your note.`,
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Unable to send it back.',
      );
      setBusy(false);
    }
  }
  return (
    <div
      className="job-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onClose();
      }}
    >
      <div
        className="job-dialog cand-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="job-dialog-header">
          <div>
            <h2 id={titleId} ref={heading} tabIndex={-1}>
              Send back
            </h2>
            <p>
              {job.title}
              {job.created_by_name
                ? ` · requested by ${job.created_by_name}`
                : ''}
            </p>
          </div>
          <button
            type="button"
            className="channel-icon-button"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
          </button>
        </header>
        <form className="cand-form" onSubmit={(event) => void submit(event)}>
          <label className="form-field">
            What should change?
            <textarea
              value={note}
              required
              maxLength={1000}
              rows={4}
              placeholder="e.g. Add the salary range and the team size."
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <p className="channel-hint">
            They see your note on the job, change it, and submit it again.
          </p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="cand-form-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="button-primary"
              disabled={busy || !note.trim()}
            >
              {busy ? 'Sending…' : 'Send back'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function JobsPage() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  // ?awaiting=approval or ?status=APPROVED, e.g. from the dashboard.
  const [status, setStatus] = useState(() =>
    searchParams.get('awaiting') === 'approval'
      ? 'AWAITING'
      : (statuses.find((item) => item === searchParams.get('status')) ?? ''),
  );
  const [offset, setOffset] = useState(0);
  const [builderJob, setBuilderJob] = useState<Job | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionBusy, setActionBusy] = useState('');
  const [message, setMessage] = useState('');
  const [publishing, setPublishing] = useState<{
    job: Job;
    mode: 'publish' | 'share';
  } | null>(null);
  const [closing, setClosing] = useState<Job | null>(null);
  const [booking, setBooking] = useState<Job | null>(null);
  const [team, setTeam] = useState<Job | null>(null);
  const [outcome, setOutcome] = useState<{
    title: string;
    outcome: PublishOutcome;
  } | null>(null);
  const canManage = ['HR_ADMIN', 'RECRUITER'].includes(
    session?.user.role ?? '',
  );
  const canApprove = session?.user.role === 'HR_ADMIN';
  // Hiring managers request jobs; an HR Admin approves; recruiters publish.
  const isManager = session?.user.role === 'HIRING_MANAGER';
  // Hiring managers request jobs (HR Admins create them too); recruiters
  // work on a job once an HR Admin approves it.
  const canCreate = canApprove || isManager;
  const canWorkOn = (job: Job) =>
    job.status !== 'CLOSED' &&
    (canApprove || (canManage && job.status !== 'DRAFT'));
  const builderRole: JobRole = canApprove
    ? 'HR_ADMIN'
    : isManager
      ? 'HIRING_MANAGER'
      : 'RECRUITER';
  const [sendingBack, setSendingBack] = useState<Job | null>(null);
  const slug = session?.user.organization_slug;
  /** HireAI's public apply page; `source` records where candidates came from. */
  const applyLink = (job: Job, source?: string) =>
    slug
      ? `${window.location.origin}${import.meta.env.BASE_URL}careers/${slug}/jobs/${job.id}${source ? `?source=${source}` : ''}`
      : '';
  /**
   * HireAI's apply page for LinkedIn posts: on a public https address, or
   * while developing on localhost (for test posts).
   */
  const linkedinApply = (jobId: string) =>
    slug &&
    (window.location.protocol === 'https:' ||
      localDevLink(new URL(window.location.href)))
      ? `${window.location.origin}${import.meta.env.BASE_URL}careers/${slug}/jobs/${jobId}?source=linkedin`
      : undefined;
  async function copyApplyLink(job: Job) {
    const link = applyLink(job);
    setActionError('');
    setOutcome(null);
    try {
      await navigator.clipboard.writeText(link);
      setMessage(`Apply link for ${job.title} copied: ${link}`);
    } catch {
      setMessage(`Apply link for ${job.title}: ${link}`);
    }
  }
  const params = new URLSearchParams({
    limit: '25',
    offset: String(offset),
    sort: 'updated_at',
    direction: 'desc',
  });
  if (search) params.set('q', search);
  if (status === 'AWAITING') params.set('awaiting', 'approval');
  else if (status) params.set('status', status);
  const jobs = useQuery({
    queryKey: ['jobs', status, search, offset],
    queryFn: () => api<Page<Job>>(`/jobs?${params.toString()}`),
  });
  const channelsQuery = useJobChannels(canManage);
  const hasChannels =
    Array.isArray(channelsQuery.data) && channelsQuery.data.length > 0;

  useEffect(() => {
    if (searchParams.get('create') === '1' && canCreate) {
      setBuilderJob(null);
      setBuilderOpen(true);
    }
  }, [searchParams, canCreate]);

  function closeBuilder() {
    setBuilderOpen(false);
    setBuilderJob(null);
    if (searchParams.has('create')) setSearchParams({}, { replace: true });
  }

  function startCreate() {
    // Recruiters work on jobs once approved; they don't create them.
    if (!canCreate) return;
    setBuilderJob(null);
    setBuilderOpen(true);
    setMessage('');
    setOutcome(null);
  }

  function startEdit(job: Job) {
    setBuilderJob(job);
    setBuilderOpen(true);
    setMessage('');
    setOutcome(null);
  }

  function openPublishing(job: Job, mode: 'publish' | 'share') {
    setActionError('');
    setMessage('');
    setOutcome(null);
    setPublishing({ job, mode });
  }

  function openClosing(job: Job) {
    setActionError('');
    setMessage('');
    setOutcome(null);
    setClosing(job);
  }

  /** Asks an HR Admin to approve a draft. */
  async function submit(job: Job) {
    setActionError('');
    setMessage('');
    setOutcome(null);
    setActionBusy(`${job.id}:submit`);
    try {
      await api(`/jobs/${job.id}/submit`, { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      setMessage(
        `${job.title} was submitted for approval. An HR Admin reviews it next.`,
      );
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : 'Unable to submit this job.',
      );
    } finally {
      setActionBusy('');
    }
  }

  async function transition(job: Job, action: 'approve' | 'publish') {
    setActionError('');
    setMessage('');
    setOutcome(null);
    setActionBusy(`${job.id}:${action}`);
    try {
      const updated = await api<Job>(`/jobs/${job.id}/${action}`, {
        method: 'POST',
      });
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      setMessage(
        action === 'approve'
          ? `${job.title} approved.`
          : `${job.title} published in HireAI.`,
      );
      return updated;
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : `Unable to ${action} this job.`,
      );
      return null;
    } finally {
      setActionBusy('');
    }
  }

  const rows = jobs.data?.data ?? [];
  const total = jobs.data?.total ?? 0;

  if (builderOpen)
    return (
      <section className="jobs-page">
        <JobBuilder
          key={builderJob?.id ?? 'new'}
          initialJob={builderJob}
          role={builderRole}
          applyPageFor={linkedinApply}
          onCancel={closeBuilder}
          onSaved={(savedJob, published, result) => {
            setMessage(
              published
                ? `${savedJob.title} was published in HireAI.`
                : savedJob.status === 'DRAFT' && savedJob.requested_at
                  ? `${savedJob.title} was submitted for approval. An HR Admin reviews it next.`
                  : savedJob.status === 'PUBLISHED'
                    ? `${savedJob.title} was updated. The changes are live on your careers page.`
                    : savedJob.status === 'APPROVED'
                      ? `${savedJob.title} was updated.`
                      : `${savedJob.title} was saved as a draft.`,
            );
            setOutcome(
              result ? { title: savedJob.title, outcome: result } : null,
            );
            setBuilderOpen(false);
            setBuilderJob(null);
            if (searchParams.has('create'))
              setSearchParams({}, { replace: true });
            void queryClient.invalidateQueries({ queryKey: ['jobs'] });
          }}
        />
      </section>
    );

  return (
    <section className="jobs-page">
      <header className="jobs-heading">
        <div>
          <p className="eyebrow">TALENT ACQUISITION</p>
          <h1>Jobs</h1>
          <p className="intro">
            {isManager
              ? 'Request the jobs you need, and follow them from approval to hiring.'
              : 'Create requisitions, manage approvals, and publish openings.'}
          </p>
        </div>
        {canCreate && (
          <button className="button-primary" onClick={startCreate}>
            <FontAwesomeIcon icon={faPlus} aria-hidden="true" />{' '}
            {isManager ? 'Request a Job' : 'Create Job'}
          </button>
        )}
      </header>

      {message && (
        <p className="form-success" role="status">
          {message}
        </p>
      )}
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      {outcome && (
        <ChannelResults
          title={outcome.title}
          outcome={outcome.outcome}
          onDismiss={() => setOutcome(null)}
        />
      )}
      {publishing && (
        <PublishDialog
          job={publishing.job}
          mode={publishing.mode}
          query={channelsQuery}
          applyUrl={linkedinApply(publishing.job.id)}
          onClose={() => setPublishing(null)}
          onDone={(result) => {
            const { job, mode } = publishing;
            setPublishing(null);
            if (mode === 'publish')
              setMessage(`${job.title} was published in HireAI.`);
            setOutcome(result ? { title: job.title, outcome: result } : null);
            void queryClient.invalidateQueries({ queryKey: ['jobs'] });
            void queryClient.invalidateQueries({
              queryKey: ['job-channels', job.id],
            });
          }}
        />
      )}
      {sendingBack && (
        <SendBackDialog
          job={sendingBack}
          onClose={() => setSendingBack(null)}
          onDone={(text) => {
            setSendingBack(null);
            setActionError('');
            setOutcome(null);
            setMessage(text);
            void queryClient.invalidateQueries({ queryKey: ['jobs'] });
          }}
        />
      )}
      {team && (
        <HiringTeamDialog
          job={team}
          canEdit={canApprove}
          onClose={() => setTeam(null)}
        />
      )}
      {booking && (
        <InterviewBookingDialog
          job={booking}
          onClose={() => setBooking(null)}
          onSaved={(text) => {
            setBooking(null);
            setMessage(text);
            void queryClient.invalidateQueries({ queryKey: ['jobs'] });
          }}
        />
      )}
      {closing && (
        <CloseJobDialog
          job={closing}
          canRemove={canApprove}
          onClose={() => setClosing(null)}
          onDone={({ removed, failed }) => {
            const job = closing;
            setClosing(null);
            setMessage(
              `${job.title} closed.` +
                (removed.length
                  ? ` Removed its ${removed.join(' and ')}.`
                  : ''),
            );
            if (failed.length)
              setActionError(
                failed
                  .map(
                    (item) =>
                      `Its ${item.title} is still on LinkedIn: ${item.message}`,
                  )
                  .join(' '),
              );
            void queryClient.invalidateQueries({ queryKey: ['jobs'] });
          }}
        />
      )}

      <section className="jobs-panel" aria-label="Job listings">
        <div className="jobs-panel-heading">
          <div>
            <h2>All jobs</h2>
            <p>{total} requisitions</p>
          </div>
          <form
            className="jobs-filters"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setSearch(searchText.trim());
              setOffset(0);
            }}
          >
            <label>
              <span className="sr-only">Search jobs</span>
              <input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search title or description"
              />
            </label>
            <label>
              <span className="sr-only">Filter by status</span>
              <span className="select-control">
                <select
                  aria-label="Filter by status"
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">All statuses</option>
                  <option value="AWAITING">Awaiting approval</option>
                  {statuses.map((item) => (
                    <option value={item} key={item}>
                      {item[0] + item.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
                <FontAwesomeIcon
                  className="select-chevron"
                  icon={faChevronDown}
                  aria-hidden="true"
                />
              </span>
            </label>
            <button type="submit">Search</button>
          </form>
        </div>

        {jobs.isPending ? (
          <p role="status" className="empty-state">
            Loading jobs…
          </p>
        ) : jobs.isError ? (
          <div role="alert" className="empty-state">
            Jobs could not be loaded.{' '}
            <button onClick={() => void jobs.refetch()}>Retry</button>
          </div>
        ) : rows.length ? (
          <>
            <div className="table-scroll">
              <table className="jobs-table">
                <thead>
                  <tr>
                    <th>Job title</th>
                    <th>Department</th>
                    <th>Location</th>
                    <th>Openings</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <strong>{job.title}</strong>
                        <small>
                          {job.employment_type.replaceAll('_', ' ')}
                        </small>
                      </td>
                      <td>{job.department}</td>
                      <td>{job.location}</td>
                      <td>{job.openings}</td>
                      <td>
                        <JobStatusCell
                          job={job}
                          canApprove={canApprove}
                          canManage={canManage}
                        />
                      </td>
                      <td>
                        <time dateTime={job.updated_at}>
                          {new Intl.DateTimeFormat(undefined, {
                            dateStyle: 'medium',
                          }).format(new Date(job.updated_at))}
                        </time>
                      </td>
                      <td>
                        <div className="row-actions">
                          {(canWorkOn(job) ||
                            (job.status === 'DRAFT' && isManager)) && (
                            <button
                              type="button"
                              aria-label={`Edit ${job.title}`}
                              onClick={() => startEdit(job)}
                            >
                              Edit
                            </button>
                          )}
                          {job.status === 'DRAFT' &&
                            !job.requested_at &&
                            isManager && (
                              <button
                                type="button"
                                className="button-primary"
                                disabled={actionBusy !== ''}
                                aria-label={`Submit ${job.title} for approval`}
                                onClick={() => void submit(job)}
                              >
                                {actionBusy === `${job.id}:submit`
                                  ? 'Submitting…'
                                  : 'Submit for approval'}
                              </button>
                            )}
                          {job.status === 'DRAFT' && canApprove && (
                            <button
                              type="button"
                              className={
                                job.requested_at ? 'button-primary' : undefined
                              }
                              disabled={actionBusy !== ''}
                              onClick={() => void transition(job, 'approve')}
                            >
                              {actionBusy === `${job.id}:approve`
                                ? 'Approving…'
                                : 'Approve'}
                            </button>
                          )}
                          {job.status === 'DRAFT' &&
                            canApprove &&
                            job.requested_at && (
                              <button
                                type="button"
                                disabled={actionBusy !== ''}
                                onClick={() => setSendingBack(job)}
                              >
                                Send back
                              </button>
                            )}
                          {job.status === 'APPROVED' && canManage && (
                            <button
                              type="button"
                              disabled={actionBusy !== ''}
                              className="button-primary"
                              onClick={() => openPublishing(job, 'publish')}
                            >
                              {actionBusy === `${job.id}:publish`
                                ? 'Publishing…'
                                : 'Publish'}
                            </button>
                          )}
                          {job.status === 'PUBLISHED' &&
                            canManage &&
                            hasChannels && (
                              <button
                                type="button"
                                disabled={actionBusy !== ''}
                                onClick={() => openPublishing(job, 'share')}
                              >
                                Post to channels
                              </button>
                            )}
                          {job.status !== 'DRAFT' &&
                            job.status !== 'APPROVED' && (
                              <Link
                                className="button-link"
                                to={`/applications?job=${job.id}`}
                                aria-label={`Applications for ${job.title}`}
                              >
                                Applications
                              </Link>
                            )}
                          {canWorkOn(job) && (
                            <button
                              type="button"
                              aria-label={`Interview booking for ${job.title}`}
                              onClick={() => setBooking(job)}
                            >
                              Interview booking
                              {job.interview_setup ? ' · On' : ''}
                            </button>
                          )}
                          {job.status !== 'CLOSED' && canManage && (
                            <button
                              type="button"
                              aria-label={`Hiring team for ${job.title}`}
                              onClick={() => setTeam(job)}
                            >
                              Hiring team
                            </button>
                          )}
                          {job.status === 'PUBLISHED' && slug && (
                            <button
                              type="button"
                              aria-label={`Copy apply link for ${job.title}`}
                              onClick={() => void copyApplyLink(job)}
                            >
                              Copy apply link
                            </button>
                          )}
                          {job.status === 'PUBLISHED' && canManage && (
                            <button
                              type="button"
                              disabled={actionBusy !== ''}
                              onClick={() => openClosing(job)}
                            >
                              Close
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                Showing {Math.min(offset + 1, total)}–
                {Math.min(offset + rows.length, total)} of {total}
              </span>
              <button
                disabled={offset === 0}
                onClick={() =>
                  setOffset((current) => Math.max(0, current - 25))
                }
              >
                Previous
              </button>
              <button
                disabled={offset + 25 >= total}
                onClick={() => setOffset((current) => current + 25)}
              >
                Next
              </button>
            </div>
          </>
        ) : (
          <div className="jobs-empty">
            <span className="icon-tile" aria-hidden="true">
              <FontAwesomeIcon icon={faBriefcase} />
            </span>
            <h3>{search || status ? 'No matching jobs' : 'No jobs yet'}</h3>
            <p>
              {search || status
                ? 'Try another search or status filter.'
                : isManager
                  ? 'Request the job you need: an HR Admin approves it, then a recruiter publishes it.'
                  : canCreate
                    ? 'Create your first job requisition to begin hiring.'
                    : canManage
                      ? 'Jobs appear here once a Hiring Manager requests one and an HR Admin approves it. You then add the screening questions and publish it.'
                      : 'Jobs you’re on appear here.'}
            </p>
            {canCreate && !search && !status && (
              <button className="button-primary" onClick={startCreate}>
                <FontAwesomeIcon icon={faPlus} aria-hidden="true" />{' '}
                {isManager ? 'Request your first job' : 'Create your first job'}
              </button>
            )}
          </div>
        )}
      </section>
    </section>
  );
}
