import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { audit } from '../../../platform/audit/audit';
import { DbService } from '../../../platform/database/db.service';
import { runWithTenant } from '../../../platform/database/tenant-context';
import { Actor } from '../../../shared/actor';
import { CallLanguage, Role } from '../../../shared/enums';
import {
  aiSettings,
  callingStatus,
  enabledAiConnections,
} from '../../organization-integrations/organization-ai';
import { callQuestionsSchema } from '../jobs';
import { CallConversation, CallEvent, PhoneLeg } from './call-conversation';
import { CallSetup, callQuestions } from './call-script';
import { callingHours, firstName, voiceOptions } from './call-setup';

export const testCallSchema = z
  .object({
    jobId: z.string().uuid(),
    language: z.enum(CallLanguage).default(CallLanguage.EN),
    /** Questions not saved yet (the job form); defaults to the job's own. */
    questions: callQuestionsSchema.optional(),
  })
  .strict();
export type TestCallInput = z.infer<typeof testCallSchema>;

/** A test call runs at most this long. */
export const TEST_CALL_SECONDS = 300;
const TICKET_SECONDS = 60;

interface Ticket {
  tenantId: string;
  userId: string;
  setup: CallSetup;
  expires: number;
}

const digest = (ticket: string) =>
  createHash('sha256').update(ticket).digest('hex');

/** The recruiter's browser as the candidate: 16 kHz PCM16 both ways. */
class BrowserLeg implements PhoneLeg {
  constructor(private readonly socket: WebSocket) {}

  private json(message: unknown) {
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }

  play(pcm16k: Buffer) {
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.send(pcm16k, { binary: true });
  }

  clear() {
    this.json({ type: 'clear' });
  }

  hangUp() {
    setTimeout(() => this.socket.close(1000), 500).unref();
  }

  event(event: CallEvent) {
    this.json(event);
  }
}

/**
 * Test calls: a recruiter talks to the AI from the browser, as a candidate
 * would, with a job's questions. Nothing about the call is saved.
 */
@Injectable()
export class TestCallsService {
  private readonly tickets = new Map<string, Ticket>();

  constructor(private readonly db: DbService) {}

  async create(actor: Actor, input: TestCallInput) {
    const job = await this.db.one<{
      organization: string;
      title: string;
      department: string | null;
      location: string | null;
      description: string | null;
      call_questions: unknown;
      caller: string | null;
    }>(
      `SELECT t.name AS organization,j.title,j.department,j.location,j.description,j.call_questions,
         (SELECT u.full_name FROM users u WHERE u.tenant_id=j.tenant_id AND u.id=$3) AS caller
       FROM jobs j JOIN tenants t ON t.id=j.tenant_id WHERE j.tenant_id=$1 AND j.id=$2${
         // A hiring manager: only the jobs they're on (e.g. their requests).
         actor.role === Role.HIRING_MANAGER
           ? ` AND EXISTS (SELECT 1 FROM job_assignments ja WHERE ja.tenant_id=j.tenant_id
                AND ja.job_id=j.id AND ja.user_id=$3 AND ja.role='HIRING_MANAGER')`
           : ''
       }`,
      [actor.tenantId, input.jobId, actor.userId],
    );
    if (!job) throw new NotFoundException('Job not found.');
    const settings = await aiSettings(this.db, actor.tenantId);
    if (!settings.callingEnabled)
      throw new ConflictException(
        'AI calling is off. An HR Admin can turn it on in Integrations.',
      );
    const status = await callingStatus(
      this.db,
      actor.tenantId,
      await enabledAiConnections(this.db, actor.tenantId),
      settings.callingProvider,
      settings.callingVoice,
    );
    if (status.voice_problem) throw new ConflictException(status.voice_problem);
    const saved = callQuestionsSchema.safeParse(job.call_questions ?? []);
    const questions = callQuestions(
      input.questions ?? (saved.success ? saved.data : []),
    );
    if (!questions.length)
      throw new ConflictException(
        'Add at least one call question to try a call.',
      );
    const ticket = randomBytes(32).toString('base64url');
    const now = Date.now();
    for (const [key, value] of this.tickets)
      if (value.expires < now) this.tickets.delete(key);
    this.tickets.set(digest(ticket), {
      tenantId: actor.tenantId,
      userId: actor.userId,
      expires: now + TICKET_SECONDS * 1000,
      setup: {
        organization: job.organization,
        assistantName: settings.callingAssistantName,
        job: {
          title: job.title,
          department: job.department,
          location: job.location,
          description: job.description,
        },
        // The recruiter plays the candidate, so the AI asks for them by name.
        candidateFirstName: firstName(job.caller),
        language: input.language,
        questions,
        recording: false,
        transcription: false,
        maxSeconds: TEST_CALL_SECONDS,
        test: true,
        // So a call-back can be tried out too (nothing is scheduled).
        callingHours: await callingHours(this.db),
      },
    });
    await this.db.transaction((tx) =>
      audit(tx, actor, 'call.test_started', 'job', input.jobId, {
        questions: questions.length,
        voice: status.voice?.provider ?? null,
      }),
    );
    return {
      ticket,
      expires_in: TICKET_SECONDS,
      max_seconds: TEST_CALL_SECONDS,
      voice: status.voice?.label ?? null,
      sample_rate: 16000,
    };
  }

  /** Uses a ticket once; null if it's unknown or expired. */
  take(ticket: string) {
    const key = digest(ticket);
    const entry = this.tickets.get(key);
    this.tickets.delete(key);
    return entry && entry.expires >= Date.now() ? entry : null;
  }

  /** Runs the test conversation over the browser's WebSocket. */
  connect(ticket: Ticket, socket: WebSocket) {
    void runWithTenant(ticket.tenantId, async () => {
      const leg = new BrowserLeg(socket);
      const conversation = new CallConversation(
        ticket.setup,
        await voiceOptions(this.db, ticket.tenantId),
        leg,
      );
      socket.on('message', (data, binary) => {
        if (binary)
          conversation.candidateAudio(
            Buffer.isBuffer(data)
              ? data
              : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]),
          );
        else if (data.toString().includes('"hangup"')) conversation.legClosed();
      });
      socket.on('close', () => conversation.legClosed());
      socket.on('error', () => conversation.legClosed());
      await conversation.start();
      const result = await conversation.done;
      if (!result.voiceProvider)
        leg.event({
          type: 'ended',
          outcome: 'NO_RESPONSE',
          summary: `The voice AI couldn’t be reached${
            result.voiceFailures.length
              ? ` (${result.voiceFailures.map((f) => `${f.provider}: ${f.reason}`).join(', ')})`
              : ''
          }. Check the AI provider’s key and credits.`,
          reason: 'voice_failed',
        });
    });
  }
}

export type { Ticket as TestCallTicket };
