import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  faCircleInfo,
  faCoins,
  faFileCircleCheck,
  faFileLines,
  faFilePen,
  faFloppyDisk,
  faLocationDot,
  faMicrochip,
  faPaperPlane,
  faPhone,
  faPhoneVolume,
  faPlus,
  faSquareCheck,
  faTags,
  faWandMagicSparkles,
  faWaveSquare,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { api } from './api';
import { useAuth } from './auth';
import {
  ChannelPicker,
  ChannelResults,
  CloseJobDialog,
  emptySelection,
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
  created_at: string;
  updated_at: string;
};
type CallQuestion = {
  id: string;
  text: string;
  answer_type: 'yes_no' | 'number' | 'text';
  /** For a yes/no deal-breaker: a different answer is flagged. */
  expected_answer: 'yes' | 'no' | null;
  criterion_id: string | null;
};
type DraftedQuestions = {
  questions: CallQuestion[];
  label: string;
  environment: 'production' | 'sandbox';
};
const answerTypeLabels: Record<CallQuestion['answer_type'], string> = {
  yes_no: 'Yes or no',
  number: 'A number',
  text: 'Free answer',
};
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
  canPublish,
  onCancel,
  onSaved,
}: {
  initialJob: Job | null;
  canPublish: boolean;
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
  const autoDrafted = useRef(false);
  const nextQuestionId = useRef(1);
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

  async function save(publish: boolean) {
    const validation = validateDraft();
    if (validation) {
      setError(validation.message);
      setStep(validation.step);
      return;
    }
    const channelProblem =
      publish && canPublish && selectionError(selection, 'publish');
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
      } else if (job.status === 'DRAFT') {
        job = await api<Job>(`/jobs/${job.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload()),
        });
        setCurrentJob(job);
      }

      if (publish && canPublish) {
        if (job.status === 'DRAFT') {
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
        onSaved(job, true, await sendToChannels(job.id, selection));
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
            {initialJob ? 'Edit Job' : 'Create and Publish Job'}
          </h1>
          <p>
            Add job details, define screening criteria, and publish your
            opening.
          </p>
        </div>
      </header>

      <ol className="job-stepper" aria-label="Job creation steps">
        {steps.map((label, index) => (
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
                        <h3>AI Calling Settings</h3>
                        <p>Configure automated candidate calls.</p>
                      </div>
                    </div>
                    <p className="calling-label">
                      <FontAwesomeIcon icon={faCircleInfo} aria-hidden="true" />{' '}
                      Calling language
                    </p>
                    <div className="calling-options" aria-disabled="true">
                      <span>
                        <FontAwesomeIcon
                          icon={faSquareCheck}
                          aria-hidden="true"
                        />{' '}
                        English
                      </span>
                      <span>
                        <FontAwesomeIcon
                          icon={faSquareCheck}
                          aria-hidden="true"
                        />{' '}
                        Hindi
                      </span>
                    </div>
                    <p className="calling-label">AI call flow</p>
                    <div className="calling-flow">
                      <FontAwesomeIcon icon={faWaveSquare} aria-hidden="true" />{' '}
                      Not configured for this workspace
                    </div>
                    <p className="calling-unavailable">
                      Candidate calling is not enabled. These preferences cannot
                      be saved yet.
                    </p>
                  </section>
                </div>
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="job-form-section">
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
                        disabled={aiBusy || busy}
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
                              placeholder="e.g. Are you comfortable working night shifts?"
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
                            answer_type: 'yes_no',
                            expected_answer: null,
                            criterion_id: null,
                          },
                        ])
                      }
                    >
                      <FontAwesomeIcon icon={faPlus} aria-hidden="true" /> Add
                      call question
                    </button>
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
                  <h3>Review and publish</h3>
                  <p>Check the details before saving or publishing this job.</p>
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
              {canPublish ? (
                <ChannelPicker
                  query={channelsQuery}
                  selection={selection}
                  onChange={(next) => {
                    setSelection(next);
                    setError('');
                  }}
                  job={form}
                  disabled={busy}
                />
              ) : (
                <div className="feature-notice">
                  <strong>An HR Admin publishes this job.</strong>
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
                aria-label="Save draft"
                disabled={busy || aiBusy}
                onClick={() => void save(false)}
              >
                {busy ? (
                  'Saving…'
                ) : (
                  <>
                    <FontAwesomeIcon icon={faFloppyDisk} aria-hidden="true" />{' '}
                    Save Draft
                  </>
                )}
              </button>
              <button
                type="button"
                className="button-ai"
                disabled={busy || aiBusy || !aiProvider}
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
              {canPublish && step === steps.length - 1 && (
                <button
                  type="button"
                  className="button-primary"
                  disabled={busy || aiBusy}
                  aria-label="Publish Job"
                  title="Publishes the job in HireAI and posts it to the channels you selected."
                  onClick={() => void save(true)}
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
                    ? `Calls aren’t placed yet. ${
                        usableQuestions.length
                          ? `${usableQuestions.length} call question${usableQuestions.length === 1 ? ' is' : 's are'} ready.`
                          : 'Prepare the call questions in the Screening Questions step.'
                      }`
                    : 'An HR Admin can turn on AI calling in Integrations.'}
                </p>
              </div>
              <span className="status-pill status-muted">
                {calling ? 'Coming soon' : 'Unavailable'}
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

export function JobsPage() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
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
  const [outcome, setOutcome] = useState<{
    title: string;
    outcome: PublishOutcome;
  } | null>(null);
  const canManage = ['HR_ADMIN', 'RECRUITER'].includes(
    session?.user.role ?? '',
  );
  const canApprove = session?.user.role === 'HR_ADMIN';
  const slug = session?.user.organization_slug;
  /** HireAI's public apply page; `source` records where candidates came from. */
  const applyLink = (job: Job, source?: string) =>
    slug
      ? `${window.location.origin}${import.meta.env.BASE_URL}careers/${slug}/jobs/${job.id}${source ? `?source=${source}` : ''}`
      : '';
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
  if (status) params.set('status', status);
  const jobs = useQuery({
    queryKey: ['jobs', status, search, offset],
    queryFn: () => api<Page<Job>>(`/jobs?${params.toString()}`),
  });
  const channelsQuery = useJobChannels(canApprove);
  const hasChannels =
    Array.isArray(channelsQuery.data) && channelsQuery.data.length > 0;

  useEffect(() => {
    if (searchParams.get('create') === '1') {
      setBuilderJob(null);
      setBuilderOpen(true);
    }
  }, [searchParams]);

  function closeBuilder() {
    setBuilderOpen(false);
    setBuilderJob(null);
    if (searchParams.has('create')) setSearchParams({}, { replace: true });
  }

  function startCreate() {
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
          canPublish={canApprove}
          onCancel={closeBuilder}
          onSaved={(savedJob, published, result) => {
            setMessage(
              published
                ? `${savedJob.title} was published in HireAI.`
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
            Create requisitions, manage approvals, and publish openings.
          </p>
        </div>
        {canManage && (
          <button className="button-primary" onClick={startCreate}>
            <FontAwesomeIcon icon={faPlus} aria-hidden="true" /> Create Job
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
          applyUrl={
            // LinkedIn only accepts a public HTTPS application link.
            window.location.protocol === 'https:'
              ? applyLink(publishing.job, 'linkedin') || undefined
              : undefined
          }
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
                        <span
                          className={`status-pill status-${job.status.toLowerCase()}`}
                        >
                          {job.status[0] + job.status.slice(1).toLowerCase()}
                        </span>
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
                          {job.status === 'DRAFT' && canManage && (
                            <button
                              type="button"
                              onClick={() => startEdit(job)}
                            >
                              Edit
                            </button>
                          )}
                          {job.status === 'DRAFT' && canApprove && (
                            <button
                              type="button"
                              disabled={actionBusy !== ''}
                              onClick={() => void transition(job, 'approve')}
                            >
                              {actionBusy === `${job.id}:approve`
                                ? 'Approving…'
                                : 'Approve'}
                            </button>
                          )}
                          {job.status === 'APPROVED' && canManage && (
                            <button
                              type="button"
                              disabled={actionBusy !== ''}
                              className="button-primary"
                              onClick={() =>
                                canApprove
                                  ? openPublishing(job, 'publish')
                                  : void transition(job, 'publish')
                              }
                            >
                              {actionBusy === `${job.id}:publish`
                                ? 'Publishing…'
                                : 'Publish'}
                            </button>
                          )}
                          {job.status === 'PUBLISHED' &&
                            canApprove &&
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
                : 'Create your first job requisition to begin hiring.'}
            </p>
            {canManage && !search && !status && (
              <button className="button-primary" onClick={startCreate}>
                <FontAwesomeIcon icon={faPlus} aria-hidden="true" /> Create your
                first job
              </button>
            )}
          </div>
        )}
      </section>
    </section>
  );
}
