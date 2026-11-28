import WebSocket from 'ws';
import { Resampler } from './audio';
import {
  VoiceError,
  VoiceHandlers,
  VoiceSession,
  VoiceSessionOptions,
  VoiceTool,
  VoiceToolCall,
  b64,
  fromB64,
  openSocket,
  voiceFailure,
} from './voice-session';

export const GEMINI_LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** Gemini's schema types are upper-case OpenAPI names. */
function declaration(tool: VoiceTool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'OBJECT',
      properties: Object.fromEntries(
        Object.entries(tool.parameters.properties).map(([name, p]) => [
          name,
          {
            type: p.type.toUpperCase(),
            description: p.description,
            ...(p.enum ? { enum: p.enum } : {}),
          },
        ]),
      ),
      required: tool.parameters.required,
    },
  };
}

/**
 * Gemini Live API over WebSocket. Audio in: 16 kHz PCM16; audio out: 24 kHz
 * PCM16, converted to 16 kHz here.
 */
export class GeminiLiveSession implements VoiceSession {
  readonly provider = 'google_ai' as const;
  private socket?: WebSocket;
  private readonly output = new Resampler(24000, 16000);
  private candidateText = '';
  private aiText = '';
  private closed = false;

  constructor(
    private readonly options: VoiceSessionOptions,
    private readonly handlers: VoiceHandlers,
  ) {}

  get model() {
    return this.options.model;
  }

  async start(opening?: string) {
    const socket = await openSocket(
      this.options.endpoint ?? GEMINI_LIVE_URL,
      // A header, not ?key=, so the key never appears in a URL.
      { 'x-goog-api-key': this.options.apiKey },
    );
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(
        () => fail(new VoiceError('network', 'setup timed out')),
        10_000,
      );
      const fail = (error: VoiceError) => {
        clearTimeout(timer);
        if (!ready) {
          this.closed = true;
          socket.terminate();
          reject(error);
        } else if (!this.closed) {
          this.closed = true;
          this.handlers.failed(error);
        }
      };
      socket.on('message', (data) => {
        let message: Record<string, any>;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message.setupComplete && !ready) {
          ready = true;
          clearTimeout(timer);
          if (opening) this.instruct(opening);
          resolve();
          return;
        }
        if (ready) this.handle(message);
      });
      socket.on('close', (code, reason) => {
        const text = reason.toString().slice(0, 300);
        if (!this.closed)
          fail(
            new VoiceError(
              code === 1000 ? 'protocol' : voiceFailure(text),
              `closed ${code}: ${text}`,
            ),
          );
      });
      socket.on('error', (error) =>
        fail(new VoiceError('network', error.message.slice(0, 200))),
      );
      this.send({
        setup: {
          model: `models/${this.options.model}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: this.options.voice },
              },
            },
          },
          systemInstruction: { parts: [{ text: this.options.instructions }] },
          tools: [
            { functionDeclarations: this.options.tools.map(declaration) },
          ],
          // Candidates pause to think: a turn ends only after 1 s of silence.
          // Speech detection keeps its default sensitivity: phone audio is
          // quiet, and a low setting missed candidates entirely. HireAI's
          // own gate keeps line noise from interrupting the AI.
          realtimeInputConfig: {
            automaticActivityDetection: {
              endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
              prefixPaddingMs: 300,
              silenceDurationMs: 1000,
            },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      });
    });
  }

  private send(message: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }

  private flushCandidate() {
    const text = this.candidateText.trim();
    this.candidateText = '';
    if (text && this.options.transcribe)
      this.handlers.transcript('candidate', text);
  }

  private flushAi() {
    const text = this.aiText.trim();
    this.aiText = '';
    if (text) this.handlers.transcript('ai', text);
  }

  private handle(message: Record<string, any>) {
    const content = message.serverContent;
    if (content) {
      if (typeof content.inputTranscription?.text === 'string')
        this.candidateText += content.inputTranscription.text;
      if (content.interrupted) {
        this.flushAi();
        this.handlers.interrupted();
      }
      for (const part of content.modelTurn?.parts ?? []) {
        const data = part?.inlineData;
        if (data && String(data.mimeType ?? '').startsWith('audio/')) {
          this.flushCandidate();
          const pcm = this.output.push(fromB64(data.data));
          if (pcm.length) this.handlers.audio(pcm);
        }
      }
      if (typeof content.outputTranscription?.text === 'string') {
        this.flushCandidate();
        this.aiText += content.outputTranscription.text;
      }
      if (content.turnComplete) {
        this.flushCandidate();
        this.flushAi();
      }
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      if (typeof call?.name !== 'string') continue;
      this.flushCandidate();
      this.handlers.toolCall({
        id: typeof call.id === 'string' ? call.id : call.name,
        name: call.name,
        args:
          call.args && typeof call.args === 'object'
            ? (call.args as Record<string, unknown>)
            : {},
      });
    }
  }

  sendAudio(pcm16k: Buffer) {
    if (!pcm16k.length) return;
    this.send({
      realtimeInput: {
        audio: { data: b64(pcm16k), mimeType: 'audio/pcm;rate=16000' },
      },
    });
  }

  toolResult(call: VoiceToolCall, result: Record<string, unknown>) {
    this.send({
      toolResponse: {
        functionResponses: [{ id: call.id, name: call.name, response: result }],
      },
    });
  }

  unreportedSpeech() {
    return this.aiText.trim();
  }

  instruct(text: string) {
    this.send({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      },
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.flushCandidate();
    this.flushAi();
    this.socket?.close(1000);
  }
}
