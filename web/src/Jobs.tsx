import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
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
  created_at: string;
  updated_at: string;
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

function JobBuilder({
  initialJob,
  canPublish,
  onCancel,
  onSaved,
}: {
  initialJob: Job | null;
  canPublish: boolean;
  onCancel: () => void;
  onSaved: (job: Job, published: boolean) => void;
}) {
  const [form, setForm] = useState(
    initialJob ? jobDraft(initialJob) : emptyDraft,
  );
  const [criteria, setCriteria] = useState<Criterion[]>(
    initialJob?.screening_criteria ?? [],
  );
  const [step, setStep] = useState(0);
  const [currentJob, setCurrentJob] = useState<Job | null>(initialJob);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nextCriterionId = useRef(1);

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
    };
  }

  function validateDraft() {
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
    if (form.description.trim().length < 10)
      return {
        message: 'Add a job description with at least 10 characters.',
        step: 1,
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
    return null;
  }

  async function save(publish: boolean) {
    const validation = validateDraft();
    if (validation) {
      setError(validation.message);
      setStep(validation.step);
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
        onSaved(job, true);
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
                    <button
                      type="button"
                      className="add-skill-button"
                      onClick={() => {
                        addCriterion();
                        setStep(2);
                      }}
                    >
                      <FontAwesomeIcon icon={faPlus} aria-hidden="true" /> Add
                      Skill
                    </button>
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
                    Write the responsibilities and qualifications for the role.
                  </p>
                </div>
              </div>
              <label className="form-field description-field">
                Description <span aria-hidden="true">*</span>
                <textarea
                  required
                  minLength={10}
                  maxLength={30000}
                  rows={14}
                  value={form.description}
                  onChange={(event) =>
                    update('description', event.target.value)
                  }
                  placeholder="Describe the role, responsibilities, and experience you are looking for."
                />
              </label>
              <div className="feature-notice">
                <strong>
                  AI description generation isn&apos;t connected yet.
                </strong>
                <span>
                  You can write and save the description here; AI-generated
                  content is not available in this deployment.
                </span>
              </div>
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
              <div className="feature-notice">
                <strong>Automated resume screening is not enabled.</strong>
                <span>
                  These criteria are saved with the job; automated scoring
                  requires a separate screening service.
                </span>
              </div>
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
              </dl>
              <div className="feature-notice">
                <strong>External job-board posting is separate.</strong>
                <span>
                  Publishing here changes the HireAI job status. LinkedIn Jobs
                  requires its own approved integration and career-page URL.
                </span>
              </div>
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
                disabled={busy}
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
                disabled
                title="AI job description generation is not available in this workspace."
              >
                <FontAwesomeIcon
                  icon={faWandMagicSparkles}
                  aria-hidden="true"
                />{' '}
                Generate with AI
              </button>
              {canPublish && (
                <button
                  type="button"
                  className="button-primary"
                  disabled={busy}
                  aria-label="Publish Job"
                  title="Publishes this job record in HireAI, not to an external job board."
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
                <p>Draft manually; AI generation isn&apos;t connected.</p>
              </div>
              <span className="status-pill status-muted">Unavailable</span>
            </li>
            <li>
              <FontAwesomeIcon icon={faFileCircleCheck} aria-hidden="true" />
              <div>
                <strong>Resume screening</strong>
                <p>
                  Criteria can be saved; automated scoring isn&apos;t enabled.
                </p>
              </div>
              <span className="status-pill status-muted">Unavailable</span>
            </li>
            <li>
              <FontAwesomeIcon icon={faPhoneVolume} aria-hidden="true" />
              <div>
                <strong>Candidate calling</strong>
                <p>Calling preferences are not part of this job form.</p>
              </div>
              <span className="status-pill status-muted">Unavailable</span>
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
  const canManage = ['HR_ADMIN', 'RECRUITER'].includes(
    session?.user.role ?? '',
  );
  const canApprove = session?.user.role === 'HR_ADMIN';
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
  }

  function startEdit(job: Job) {
    setBuilderJob(job);
    setBuilderOpen(true);
    setMessage('');
  }

  async function transition(job: Job, action: 'approve' | 'publish' | 'close') {
    setActionError('');
    setMessage('');
    setActionBusy(`${job.id}:${action}`);
    try {
      const body = action === 'close' ? JSON.stringify({}) : undefined;
      const updated = await api<Job>(`/jobs/${job.id}/${action}`, {
        method: 'POST',
        ...(body ? { body } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      setMessage(
        action === 'approve'
          ? `${job.title} approved.`
          : action === 'publish'
            ? `${job.title} published in HireAI.`
            : `${job.title} closed.`,
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
          onSaved={(savedJob, published) => {
            setMessage(
              published
                ? `${savedJob.title} was published in HireAI.`
                : `${savedJob.title} was saved as a draft.`,
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
                              onClick={() => void transition(job, 'publish')}
                            >
                              {actionBusy === `${job.id}:publish`
                                ? 'Publishing…'
                                : 'Publish'}
                            </button>
                          )}
                          {job.status === 'PUBLISHED' && canManage && (
                            <button
                              type="button"
                              disabled={actionBusy !== ''}
                              onClick={() => void transition(job, 'close')}
                            >
                              {actionBusy === `${job.id}:close`
                                ? 'Closing…'
                                : 'Close'}
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
