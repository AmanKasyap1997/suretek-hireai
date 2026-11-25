import { z } from 'zod';
import { aiProviders } from '../../organization-integrations/ai-client';

export const answerTypes = ['yes_no', 'number', 'text'] as const;

/** One question the AI asks on a candidate call. */
export const callQuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    text: z.string().trim().min(5).max(300),
    answer_type: z.enum(answerTypes),
    /** For a yes/no deal-breaker: a different answer is flagged. */
    expected_answer: z.enum(['yes', 'no']).nullable().default(null),
    /** The screening criterion the question checks, if any. */
    criterion_id: z.string().trim().min(1).max(100).nullable().default(null),
  })
  .strict()
  .refine((q) => q.answer_type === 'yes_no' || q.expected_answer === null, {
    message: 'Only a yes/no question can have an expected answer',
    path: ['expected_answer'],
  });
export type CallQuestion = z.infer<typeof callQuestionSchema>;

export const callQuestionsSchema = z
  .array(callQuestionSchema)
  .max(10)
  .refine((v) => new Set(v.map((q) => q.id)).size === v.length, {
    message: 'Duplicate question ids',
  });

/** What drafting needs from the job wizard. Nothing about any candidate. */
export const callQuestionDraftSchema = z
  .object({
    /** The provider to draft with; otherwise each enabled one in turn. */
    provider: z.enum(aiProviders).optional(),
    title: z.string().trim().min(2).max(200),
    department: z.string().trim().min(1).max(150),
    location: z.string().trim().min(1).max(200),
    employmentType: z
      .enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'])
      .optional(),
    description: z.string().trim().min(10).max(30_000),
    screeningCriteria: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            label: z.string().trim().min(1).max(500),
            must_have: z.boolean(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    guidance: z.string().trim().max(1000).optional(),
  })
  .strict();
export type CallQuestionDraftInput = z.infer<typeof callQuestionDraftSchema>;

export const callQuestionsSystemPrompt = `You write the questions an AI voice assistant will ask job candidates on a short phone call, for a hiring team in India. A recruiter reviews and edits your questions before the job is published, and people make every hiring decision.

Write 5 to 8 questions:
- Each asks one thing, in plain spoken English, and can be answered in under a minute.
- Focus on what a resume shows poorly: hands-on depth with the job's key requirements, willingness for conditions the job details state (such as shifts, travel or working on site), and availability to interview.
- Don't ask what the application form already collects: name, contact details, current city, willingness to relocate, total experience, current company and job title, notice period, and current or expected pay.
- Ask only about the job. Never ask about age or date of birth, marital status, family or children, pregnancy, religion, caste, health or disability, nationality (other than the right to work in the job's country when the job details require it), or anything else personal.
- Never ask for passwords, ID numbers or bank details.

For each question:
- answer_type: "yes_no" for a yes or no answer, "number" for a count such as years, or "text" for an open answer.
- expected_answer: "yes" or "no" only when a yes/no question checks an essential requirement stated in the job details, so a different answer is flagged for the recruiter. Otherwise "none".
- criterion_id: the id of the requirement in <requirements> that the question checks, or "" if none.`;

const employment: Record<string, string> = {
  FULL_TIME: 'Full time',
  PART_TIME: 'Part time',
  CONTRACT: 'Contract',
  INTERN: 'Internship',
};

export function callQuestionsPrompt(input: CallQuestionDraftInput) {
  return [
    'Write the call questions for this job.',
    `<job>\nTitle: ${input.title}\nDepartment: ${input.department}\nLocation: ${input.location}\nEmployment type: ${employment[input.employmentType ?? 'FULL_TIME']}\nDescription:\n${input.description.slice(0, 12_000)}\n</job>`,
    input.screeningCriteria.length
      ? `<requirements>\n${input.screeningCriteria
          .map(
            (c) =>
              `- id: ${c.id} | ${c.must_have ? 'must have' : 'nice to have'} | ${c.label}`,
          )
          .join('\n')}\n</requirements>`
      : '<requirements>\nNone listed: use the job description.\n</requirements>',
    ...(input.guidance
      ? [`<recruiter_guidance>\n${input.guidance}\n</recruiter_guidance>`]
      : []),
  ].join('\n\n');
}

export const callQuestionsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'answer_type', 'expected_answer', 'criterion_id'],
        properties: {
          text: { type: 'string' },
          answer_type: { type: 'string', enum: [...answerTypes] },
          expected_answer: { type: 'string', enum: ['yes', 'no', 'none'] },
          criterion_id: { type: 'string' },
        },
      },
    },
  },
};

type AnswerType = (typeof answerTypes)[number];

/** A model's wording for an answer type, mapped onto HireAI's three. */
function answerType(value: unknown): AnswerType {
  const key = typeof value === 'string' ? value.toLowerCase() : '';
  if (/yes|bool/.test(key)) return 'yes_no';
  if (/num|int|count|year/.test(key)) return 'number';
  return 'text';
}

/** The questions array, wherever a model put it. */
function questionList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const questions = (value as { questions?: unknown } | null)?.questions;
  return Array.isArray(questions) ? questions : null;
}

/**
 * Personal topics a hiring question must not touch. A drafted question that
 * mentions one is dropped; the recruiter still reviews the rest.
 */
const personal =
  /\b(age|aged|how old|date of birth|born|married|marital|spouse|wife|husband|children|kids|pregnan\w*|religion|religious|caste|disabled|disability|health|medical|nationality)\b/i;

/** The AI's reply could not be used; `detail` names why, without content. */
export class CallQuestionsError extends Error {
  constructor(readonly detail: string) {
    super(`Drafted call questions unusable: ${detail}`);
  }
}

/**
 * The AI's questions, checked and tidied, with HireAI's own ids. Small
 * differences in shape (a null instead of "none", "yes/no" instead of
 * "yes_no", a bare array) are accepted; an unusable item is skipped.
 */
export function normalizeCallQuestions(
  value: unknown,
  criteria: { id: string }[],
): CallQuestion[] {
  const list = questionList(value);
  if (!list) throw new CallQuestionsError('no questions list');
  const known = new Set(criteria.map((c) => c.id));
  const seen = new Set<string>();
  const questions: CallQuestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const source = typeof raw.text === 'string' ? raw.text : raw.question;
    const text =
      typeof source === 'string' ? source.trim().replace(/\s+/g, ' ') : '';
    const key = text.toLowerCase();
    if (text.length < 5 || text.length > 300) continue;
    if (personal.test(text) || seen.has(key)) continue;
    seen.add(key);
    const type = answerType(raw.answer_type ?? raw.answerType);
    const expected =
      typeof raw.expected_answer === 'string'
        ? raw.expected_answer.trim().toLowerCase()
        : '';
    const criterion =
      typeof raw.criterion_id === 'string' ||
      typeof raw.criterion_id === 'number'
        ? String(raw.criterion_id)
        : '';
    questions.push({
      id: `q${questions.length + 1}`,
      text,
      answer_type: type,
      expected_answer:
        type === 'yes_no' && (expected === 'yes' || expected === 'no')
          ? expected
          : null,
      criterion_id: known.has(criterion) ? criterion : null,
    });
    if (questions.length === 10) break;
  }
  if (!questions.length)
    throw new CallQuestionsError(`none of ${list.length} items usable`);
  return questions;
}
