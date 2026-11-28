import WebSocket from 'ws';

/** The voice AIs that can talk to candidates. */
export const voiceProviders = ['openai', 'google_ai'] as const;
export type VoiceProvider = (typeof voiceProviders)[number];

export const voiceProviderLabels: Record<VoiceProvider, string> = {
  openai: 'OpenAI Realtime',
  google_ai: 'Gemini Live',
};

/** A function the AI may call during the conversation. */
export interface VoiceTool {
  name: string;
  description: string;
  parameters: {
    properties: Record<
      string,
      {
        type: 'string' | 'boolean';
        description: string;
        enum?: string[];
      }
    >;
    required: string[];
  };
}

export interface VoiceToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface VoiceSessionOptions {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
  tools: VoiceTool[];
  language: 'EN' | 'HI';
  /** Transcribe the candidate's speech (only with consent, or in a test call). */
  transcribe: boolean;
  /** Overrides the provider's WebSocket address (tests). */
  endpoint?: string;
}

/** Why a voice AI couldn't be used. */
export type VoiceFailure = 'auth' | 'quota' | 'model' | 'network' | 'protocol';

export class VoiceError extends Error {
  constructor(
    readonly reason: VoiceFailure,
    readonly detail: string,
  ) {
    super(`Voice AI unavailable: ${reason}`);
  }
}

export interface VoiceHandlers {
  /** AI speech, 16 kHz PCM16 mono. */
  audio(pcm16k: Buffer): void;
  /** The candidate started talking over the AI: stop its queued audio. */
  interrupted(): void;
  transcript(speaker: 'ai' | 'candidate', text: string): void;
  toolCall(call: VoiceToolCall): void;
  /** The session ended unexpectedly after it had started. */
  failed(error: VoiceError): void;
}

/** One live conversation with a voice AI. */
export interface VoiceSession {
  readonly provider: VoiceProvider;
  readonly model: string;
  /**
   * Connects; with `opening`, the AI starts speaking at once. Rejects with a
   * VoiceError.
   */
  start(opening?: string): Promise<void>;
  sendAudio(pcm16k: Buffer): void;
  /**
   * Answers a tool call. `reply`: let the AI keep talking afterwards (OpenAI
   * waits to be asked; Gemini continues by itself).
   */
  toolResult(
    call: VoiceToolCall,
    result: Record<string, unknown>,
    reply: boolean,
  ): void;
  /** A note from HireAI the AI acts on, e.g. that time is nearly up. */
  instruct(text: string): void;
  /**
   * What the AI has said in its current reply that isn't in the transcript
   * yet (Gemini reports it when the reply ends). Empty if none.
   */
  unreportedSpeech?(): string;
  close(): void;
}

/** Classifies a provider's error text or close reason. */
export function voiceFailure(text: string, status?: number): VoiceFailure {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  if (status === 404) return 'model';
  if (/quota|exhaust|rate.?limit|billing|insufficient|credit/i.test(text))
    return 'quota';
  if (/api.?key|unauthori[sz]ed|permission|forbidden|authenticat/i.test(text))
    return 'auth';
  if (/model|not found|not supported|unsupported/i.test(text)) return 'model';
  return 'protocol';
}

/**
 * Opens a provider WebSocket. HTTP failures during the handshake become
 * VoiceErrors without exposing the response body.
 */
export function openSocket(
  url: string,
  headers: Record<string, string>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers,
      handshakeTimeout: 10_000,
      maxPayload: 16 * 1024 * 1024,
    });
    const fail = (error: VoiceError) => {
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.terminate();
      reject(error);
    };
    socket.once('open', () => {
      socket.removeAllListeners('error');
      socket.removeAllListeners('unexpected-response');
      resolve(socket);
    });
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      fail(
        new VoiceError(voiceFailure('', status), `HTTP ${status} on connect`),
      );
    });
    socket.once('error', (error) =>
      fail(new VoiceError('network', error.message.slice(0, 200))),
    );
  });
}

export const b64 = (bytes: Buffer) => bytes.toString('base64');
export const fromB64 = (text: unknown) =>
  typeof text === 'string' ? Buffer.from(text, 'base64') : Buffer.alloc(0);
