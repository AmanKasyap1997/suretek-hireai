import { CallRecorder, callSeconds } from './audio';
import {
  AttemptOutcome,
  CallAnswer,
  CallSetup,
  TranscriptLine,
  callAnswer,
  callEnding,
  callInstructions,
  callToolsFor,
  openingCue,
  wrapUpCue,
} from './call-script';
import {
  VoiceError,
  VoiceFailure,
  VoiceHandlers,
  VoiceProvider,
  VoiceSession,
  VoiceSessionOptions,
  VoiceToolCall,
} from './voice-session';

/**
 * How many times the AI is stopped from hanging up before hearing an answer,
 * before HireAI lets it.
 */
const MAX_REFUSED_ENDINGS = 2;

/** A question in the AI's words ("…reach you?"). */
const ASKS = /[?？]/;

/** The candidate's side of the call: a phone line or a browser. */
export interface PhoneLeg {
  /** Plays AI speech (16 kHz PCM16) to the candidate. */
  play(pcm16k: Buffer): void;
  /** Drops AI speech that hasn't played yet (the candidate interrupted). */
  clear(): void;
  hangUp(): void;
  /** Live updates, shown during a browser test call. */
  event?(event: CallEvent): void;
}

export type CallEvent =
  | { type: 'live'; provider: VoiceProvider }
  | { type: 'transcript'; speaker: 'ai' | 'candidate'; text: string }
  | { type: 'answer'; answer: CallAnswer }
  | {
      type: 'ended';
      outcome: AttemptOutcome;
      summary: string | null;
      reason: CallEndReason;
    };

/** A voice AI that may take the call, in the order they're tried. */
export interface VoiceOption {
  provider: VoiceProvider;
  model: string;
  create(
    options: Pick<
      VoiceSessionOptions,
      'instructions' | 'tools' | 'language' | 'transcribe'
    >,
    handlers: VoiceHandlers,
  ): VoiceSession;
}

export type CallEndReason =
  'ai' | 'candidate' | 'silence' | 'time_limit' | 'voice_failed' | 'cancelled';

export interface ConversationResult {
  outcome: AttemptOutcome;
  reason: CallEndReason;
  answers: CallAnswer[];
  summary: string | null;
  callbackNote: string | null;
  /** The time agreed to call back, when the AI gave one. */
  callbackAt: Date | null;
  /** A booking call: the interview the candidate booked. */
  bookedInterviewId: string | null;
  /** Only when the candidate agreed to a transcript. */
  transcript: TranscriptLine[] | null;
  /** WAV; only when the candidate agreed to a recording. */
  recording: Buffer | null;
  voiceProvider: VoiceProvider | null;
  voiceModel: string | null;
  /** The voice AIs that couldn't be used, and why. */
  voiceFailures: { provider: VoiceProvider; reason: VoiceFailure }[];
  /** voice_unavailable when no voice AI could take the call. */
  failure: string | null;
  seconds: number;
  /**
   * How fast the AI's speech arrived, as a multiple of real time (below 1:
   * slower than it plays, so the voice breaks up). null when unmeasured.
   */
  aiAudioSpeed: number | null;
}

/** What a booking call does when the candidate picks a time. */
export interface ConversationHooks {
  book?: (
    slotId: string,
  ) => Promise<
    | { booked: true; when: string; interviewId: string }
    | { booked: false; reason: 'unknown_slot' | 'taken' | 'failed' }
  >;
}

/** Hang up when nobody has spoken for this long (voicemail, dead air). */
export const SILENCE_SECONDS = 40;
/**
 * AI speech held back when the line has nothing queued (a new reply, or
 * after it ran dry), so the AI's audio arriving unevenly doesn't play with
 * holes in it.
 */
export const PLAYOUT_BUFFER_MS = 800;
/** While the AI talks, only speech this long interrupts it (not noise). */
export const BARGE_IN_MS = 400;
/** The AI greets once the candidate has said hello, or after this long. */
export const GREETING_WAIT_MS = 2500;
/** After the candidate's hello, how long the AI may take to answer it. */
export const AFTER_HELLO_MS = 3000;
/** A frame this loud (RMS) counts as the candidate speaking. */
const SPEECH_RMS = 700;

function loud(pcm: Buffer) {
  const count = pcm.length >> 1;
  if (!count) return false;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / count) >= SPEECH_RMS;
}

/**
 * One AI call: connects the candidate's leg to a voice AI, keeps the
 * answers the AI records, and decides how the call ended.
 */
export class CallConversation {
  private voice?: VoiceSession;
  private voiceOption?: VoiceOption;
  private readonly voiceFailures: ConversationResult['voiceFailures'] = [];
  private readonly answers = new Map<string, CallAnswer>();
  private readonly transcript: TranscriptLine[] = [];
  private readonly recorder: CallRecorder | null;
  private readonly startedAt: number;
  /** When the AI audio sent so far will have finished playing. */
  private playbackEnd = 0;
  private lastAiAudio = 0;
  private lastSpeech: number;
  /** When each AI reply's audio arrived, to measure its speed. */
  private readonly replies: {
    start: number;
    end: number;
    firstMs: number;
    audioMs: number;
  }[] = [];
  /** AI audio waiting to fill the playout buffer. */
  private pending: Buffer[] = [];
  private pendingMs = 0;
  private flushTimer?: NodeJS.Timeout;
  /** Candidate audio held while the AI talks, released on a real barge-in. */
  private held: Buffer[] = [];
  private heldMs = 0;
  private loudSince = 0;
  private bargeIn = false;
  private connectedAt = 0;
  private greeted = false;
  /** When the candidate last spoke before the greeting ("Hello?"). */
  private heardAt = 0;
  /** When the candidate's audio was last loud enough to be speech. */
  private candidateSpokeAt = 0;
  /** The interview booked on this call, if any. */
  private booked: string | null = null;
  /** Times the AI was stopped from hanging up before hearing an answer. */
  private refusedEndings = 0;
  /** How the AI ended the call, once HireAI hangs up. */
  private ending: ReturnType<typeof callEnding> | null = null;
  /**
   * How the AI last wanted to end the call, while HireAI waits for an answer
   * first. Used if the call ends another way (e.g. silence).
   */
  private wantedEnding: ReturnType<typeof callEnding> | null = null;
  private finished = false;
  private readonly timers: NodeJS.Timeout[] = [];
  private resolve!: (result: ConversationResult) => void;
  readonly done = new Promise<ConversationResult>((r) => (this.resolve = r));

  constructor(
    private readonly setup: CallSetup,
    private readonly voices: VoiceOption[],
    private readonly leg: PhoneLeg,
    private readonly now: () => number = Date.now,
    private readonly hooks: ConversationHooks = {},
  ) {
    this.startedAt = now();
    this.lastSpeech = this.startedAt;
    this.recorder = setup.recording ? new CallRecorder(setup.maxSeconds) : null;
  }

  get active() {
    return !this.finished;
  }

  /** Connects a voice AI (falling back to the next one) and starts talking. */
  async start() {
    const handlers = this.handlers();
    const options = {
      instructions: callInstructions(this.setup),
      tools: callToolsFor(this.setup),
      language: this.setup.language,
      transcribe: this.setup.transcription || this.setup.test,
    };
    for (const option of this.voices) {
      if (this.finished) return;
      const session = option.create(options, handlers);
      try {
        // No opening yet: the candidate usually says "Hello?" first.
        await session.start();
        this.voice = session;
        this.voiceOption = option;
        break;
      } catch (error) {
        session.close();
        this.voiceFailures.push({
          provider: option.provider,
          reason: error instanceof VoiceError ? error.reason : 'network',
        });
      }
    }
    if (this.finished) {
      this.voice?.close();
      return;
    }
    if (!this.voice) {
      this.finish('voice_failed');
      return;
    }
    this.lastSpeech = this.now();
    this.connectedAt = this.now();
    this.leg.event?.({ type: 'live', provider: this.voiceOption!.provider });
    this.timers.push(setInterval(() => this.checkGreeting(), 100));
    const ms = this.setup.maxSeconds * 1000;
    if (this.setup.maxSeconds > 90)
      this.timers.push(
        setTimeout(() => this.voice?.instruct(wrapUpCue), ms - 45_000),
      );
    this.timers.push(setTimeout(() => this.finish('time_limit'), ms));
    this.timers.push(setInterval(() => this.checkSilence(), 1000));
  }

  /** Audio from the candidate, 16 kHz PCM16. */
  candidateAudio(pcm16k: Buffer) {
    if (this.finished) return;
    this.recorder?.addCandidate(pcm16k);
    const now = this.now();
    const speaking = loud(pcm16k);
    if (speaking) {
      this.lastSpeech = now;
      this.candidateSpokeAt = now;
      if (!this.greeted) this.heardAt = now;
    }
    const voice = this.voice;
    if (!voice) return;
    const aiTalking = now < this.playbackEnd || this.pendingMs > 0;
    if (!aiTalking) this.bargeIn = false;
    if (!aiTalking || this.bargeIn) {
      this.release();
      this.loudSince = 0;
      voice.sendAudio(pcm16k);
      return;
    }
    // The AI is talking. Line noise, echo and a quick "hmm" shouldn't cut it
    // off: hold the audio, and pass it on only if the candidate keeps talking.
    this.loudSince = speaking ? this.loudSince || now : 0;
    this.held.push(pcm16k);
    this.heldMs += callSeconds(pcm16k) * 1000;
    while (this.heldMs > BARGE_IN_MS + 200 && this.held.length > 1)
      this.heldMs -= callSeconds(this.held.shift()!) * 1000;
    if (this.loudSince && now - this.loudSince >= BARGE_IN_MS) {
      this.bargeIn = true;
      this.release();
    }
  }

  /** Sends the candidate audio held while the AI was talking. */
  private release() {
    for (const chunk of this.held) this.voice?.sendAudio(chunk);
    this.held = [];
    this.heldMs = 0;
  }

  /**
   * Greets once the candidate has said hello (if the AI hasn't answered it
   * already), or after a short wait if they say nothing.
   */
  private checkGreeting() {
    if (this.greeted || !this.voice) return;
    const now = this.now();
    const ready = this.heardAt
      ? now - this.heardAt >= AFTER_HELLO_MS
      : now - this.connectedAt >= GREETING_WAIT_MS;
    if (!ready) return;
    this.greeted = true;
    this.voice.instruct(openingCue);
  }

  /** Plays AI speech now. */
  private play(pcm: Buffer) {
    this.leg.play(pcm);
    this.recorder?.addAi(pcm);
    this.playbackEnd =
      Math.max(this.playbackEnd, this.now()) + callSeconds(pcm) * 1000;
  }

  private flushPending() {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const chunk of this.pending) this.play(chunk);
    this.pending = [];
    this.pendingMs = 0;
  }

  /** The candidate hung up or the line dropped. */
  legClosed() {
    this.finish('candidate');
  }

  /** A recruiter cancelled the call. */
  cancel() {
    this.finish('cancelled');
  }

  private checkSilence() {
    const now = this.now();
    const quiet = now - Math.max(this.lastSpeech, this.playbackEnd);
    if (!this.ending && quiet > SILENCE_SECONDS * 1000) this.finish('silence');
  }

  private handlers(): VoiceHandlers {
    return {
      audio: (pcm) => {
        if (this.finished) return;
        const now = this.now();
        const ms = callSeconds(pcm) * 1000;
        const reply = this.replies.at(-1);
        if (!reply || now - this.lastAiAudio > 1500)
          this.replies.push({ start: now, end: now, firstMs: ms, audioMs: ms });
        else {
          reply.end = now;
          reply.audioMs += ms;
        }
        this.lastAiAudio = now;
        // The AI answered the candidate's hello by itself.
        this.greeted = true;
        // Audio still queued on the line: keep it fed.
        if (now < this.playbackEnd && !this.pending.length) {
          this.play(pcm);
          return;
        }
        // Nothing queued: build a small buffer first, then play it all.
        this.pending.push(pcm);
        this.pendingMs += callSeconds(pcm) * 1000;
        if (this.pendingMs >= PLAYOUT_BUFFER_MS) this.flushPending();
        else {
          clearTimeout(this.flushTimer);
          // A short reply ("Sure.") plays once no more audio follows.
          this.flushTimer = setTimeout(() => this.flushPending(), 250);
        }
      },
      interrupted: () => {
        if (this.finished) return;
        clearTimeout(this.flushTimer);
        this.pending = [];
        this.pendingMs = 0;
        this.bargeIn = false;
        this.leg.clear();
        this.recorder?.interrupt();
        this.playbackEnd = this.now();
        this.lastSpeech = this.now();
      },
      transcript: (speaker, text) => {
        if (this.finished || !text) return;
        if (speaker === 'candidate') this.lastSpeech = this.now();
        this.transcript.push({
          speaker,
          text: text.slice(0, 2000),
          at: this.now() - this.startedAt,
        });
        this.leg.event?.({ type: 'transcript', speaker, text });
      },
      toolCall: (call) => {
        const voice = this.voice;
        if (this.finished || !voice) return;
        if (call.name === 'record_answer') {
          const answer = callAnswer(this.setup.questions, call.args);
          if (!answer) {
            voice.toolResult(
              call,
              { error: 'Unknown question_id. Use an id from the list.' },
              true,
            );
            return;
          }
          this.answers.set(answer.question_id, answer);
          this.leg.event?.({ type: 'answer', answer });
          voice.toolResult(call, { saved: true }, true);
        } else if (call.name === 'book_interview') void this.book(call);
        else if (call.name === 'end_call') this.requestEnding(call);
        else voice.toolResult(call, { error: 'Unknown function.' }, true);
      },
      failed: (error) => {
        if (this.voiceOption)
          this.voiceFailures.push({
            provider: this.voiceOption.provider,
            reason: error.reason,
          });
        this.finish('voice_failed');
      },
    };
  }

  /**
   * Books the time the candidate chose. The AI waits for the answer (Gemini
   * pauses until it has it), then confirms the time or offers another.
   */
  private async book(call: VoiceToolCall) {
    const slotId =
      typeof call.args.slot_id === 'string' ? call.args.slot_id : '';
    let result: Record<string, unknown>;
    try {
      const booked = this.hooks.book
        ? await this.hooks.book(slotId)
        : ({ booked: false, reason: 'failed' } as const);
      if (booked.booked) this.booked = booked.interviewId;
      result = booked.booked
        ? { booked: true, when: booked.when }
        : {
            booked: false,
            error:
              booked.reason === 'taken'
                ? 'That time was just taken. Apologise and offer the other times.'
                : booked.reason === 'unknown_slot'
                  ? 'Use a slot_id from the list of interview times.'
                  : 'It couldn’t be booked. Apologise, say the recruiting team will confirm a time by email, and end the call with outcome COMPLETED.',
          };
    } catch {
      result = {
        booked: false,
        error:
          'It couldn’t be booked. Apologise, say the recruiting team will confirm a time by email, and end the call with outcome COMPLETED.',
      };
    }
    if (!this.finished) this.voice?.toolResult(call, result, true);
  }

  /** Audio received after each reply's first piece, per second it took. */
  private audioSpeed() {
    const long = this.replies.filter((r) => r.end - r.start >= 2000);
    const span = long.reduce((sum, r) => sum + r.end - r.start, 0);
    if (!span) return null;
    const audio = long.reduce((sum, r) => sum + r.audioMs - r.firstMs, 0);
    return Math.round((audio / span) * 100) / 100;
  }

  /**
   * The AI asked to end the call. It's answered at once: Gemini stops
   * speaking until it is, so waiting would cut its sentence short.
   *
   * - "Call back later" without a time: it asked "when?" and didn't wait for
   *   the answer, so it's told to wait.
   * - Otherwise HireAI hangs up once the AI has finished speaking, unless it
   *   asked something in this turn: then the call stays on for the answer,
   *   and the AI ends it again after hearing it.
   *
   * At most MAX_REFUSED_ENDINGS a call, so a call can't get stuck.
   */
  private requestEnding(call: VoiceToolCall) {
    const voice = this.voice!;
    const ending = callEnding(call.args, this.setup.callingHours?.timezone);
    this.wantedEnding = ending;
    const mayRefuse = this.refusedEndings < MAX_REFUSED_ENDINGS;
    if (mayRefuse && ending.outcome === 'CALL_BACK' && !ending.callbackNote) {
      this.refusedEndings++;
      voice.toolResult(
        call,
        {
          ended: false,
          error:
            'The call wasn’t ended: you don’t know when to call back yet. Finish your question if you were asking one, then say nothing and wait for their answer. If they don’t know, end the call with callback_time "not given".',
        },
        false,
      );
      return;
    }
    voice.toolResult(
      call,
      {
        ended: true,
        note: 'HireAI hangs up as soon as you finish speaking. Say nothing more.',
      },
      false,
    );
    // Only what the AI said after the candidate last spoke is this turn.
    const turnStart = this.candidateSpokeAt - this.startedAt;
    const since = this.now();
    const timer = setInterval(() => {
      const now = this.now();
      const settled =
        now - this.lastAiAudio >= 1500 &&
        !this.pending.length &&
        now >= this.playbackEnd + 400;
      if (!settled && now - since <= 15_000) return;
      clearInterval(timer);
      if (this.finished) return;
      // A question still waiting for its answer: the call stays on.
      if (mayRefuse && ASKS.test(this.wordsSince(turnStart))) {
        this.refusedEndings++;
        return;
      }
      this.ending = ending;
      this.finish('ai');
    }, 200);
    this.timers.push(timer);
  }

  /**
   * What the AI has said since `turnStart` (ms into the call), including
   * words not yet in the transcript.
   */
  private wordsSince(turnStart: number) {
    return [
      ...this.transcript
        .filter((line) => line.speaker === 'ai' && line.at >= turnStart)
        .map((line) => line.text),
      this.voice?.unreportedSpeech?.() ?? '',
    ].join(' ');
  }

  private finish(reason: CallEndReason) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.flushTimer);
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.voice?.close();
    const answers = [...this.answers.values()];
    // Ended another way (silence, the time limit) while waiting for an answer
    // the AI asked for: what it wanted, e.g. to call back later.
    this.ending ??= this.wantedEnding;
    const outcome: AttemptOutcome =
      this.ending?.outcome ?? (answers.length ? 'COMPLETED' : 'NO_RESPONSE');
    const result: ConversationResult = {
      outcome,
      reason,
      answers: this.setup.questions
        .map((q) => answers.find((a) => a.question_id === q.id))
        .filter((a): a is CallAnswer => !!a),
      summary: this.ending?.summary ?? null,
      callbackNote: this.ending?.callbackNote ?? null,
      callbackAt: this.ending?.callbackAt ?? null,
      bookedInterviewId: this.booked,
      transcript: this.setup.transcription ? this.transcript : null,
      recording: this.recorder?.wav() ?? null,
      voiceProvider: this.voiceOption?.provider ?? null,
      voiceModel: this.voiceOption?.model ?? null,
      voiceFailures: this.voiceFailures,
      failure: this.voice ? null : 'voice_unavailable',
      seconds: Math.round((this.now() - this.startedAt) / 1000),
      aiAudioSpeed: this.audioSpeed(),
    };
    this.leg.event?.({
      type: 'ended',
      outcome,
      summary: result.summary,
      reason,
    });
    if (reason !== 'candidate') this.leg.hangUp();
    this.resolve(result);
  }
}
