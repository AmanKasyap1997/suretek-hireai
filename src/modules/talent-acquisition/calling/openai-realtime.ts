import WebSocket from 'ws';
import { Resampler } from './audio';
import {
  VoiceError,
  VoiceHandlers,
  VoiceSession,
  VoiceSessionOptions,
  VoiceToolCall,
  b64,
  fromB64,
  openSocket,
  voiceFailure,
} from './voice-session';

export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

/**
 * OpenAI Realtime API (GA) over WebSocket. Its PCM audio is 24 kHz both
 * ways, converted from and to 16 kHz here.
 */
export class OpenAiRealtimeSession implements VoiceSession {
  readonly provider = 'openai' as const;
  private socket?: WebSocket;
  private readonly input = new Resampler(16000, 24000);
  private readonly output = new Resampler(24000, 16000);
  private closed = false;
  /** Tool calls of the last response still waiting for a result. */
  private pending = new Set<string>();
  private replyAfterTools = false;
  private seenCalls = new Set<string>();

  constructor(
    private readonly options: VoiceSessionOptions,
    private readonly handlers: VoiceHandlers,
  ) {}

  get model() {
    return this.options.model;
  }

  async start(opening?: string) {
    const url = new URL(this.options.endpoint ?? OPENAI_REALTIME_URL);
    url.searchParams.set('model', this.options.model);
    const socket = await openSocket(url.toString(), {
      Authorization: `Bearer ${this.options.apiKey}`,
    });
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
        let event: Record<string, any>;
        try {
          event = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (event.type === 'error') {
          const code = String(event.error?.code ?? '');
          const text = `${code} ${String(event.error?.message ?? '')}`.slice(
            0,
            300,
          );
          // Only problems with the account or model end the call; others
          // (e.g. a response already in progress) are harmless.
          const reason = voiceFailure(text);
          if (!ready || reason !== 'protocol')
            fail(new VoiceError(reason, text));
          return;
        }
        if (event.type === 'session.updated' && !ready) {
          ready = true;
          clearTimeout(timer);
          if (opening) this.instruct(opening);
          resolve();
          return;
        }
        if (ready) this.handle(event);
      });
      socket.on('close', (code, reason) => {
        const text = reason.toString().slice(0, 300);
        if (!this.closed)
          fail(new VoiceError(voiceFailure(text), `closed ${code}: ${text}`));
      });
      socket.on('error', (error) =>
        fail(new VoiceError('network', error.message.slice(0, 200))),
      );
      const language = this.options.language === 'HI' ? 'hi' : 'en';
      this.send({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: this.options.instructions,
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              // "low": waits longer before deciding the candidate is done.
              turn_detection: { type: 'semantic_vad', eagerness: 'low' },
              ...(this.options.transcribe
                ? {
                    transcription: {
                      model: 'gpt-4o-mini-transcribe',
                      language,
                    },
                  }
                : {}),
            },
            output: {
              format: { type: 'audio/pcm', rate: 24000 },
              voice: this.options.voice,
            },
          },
          tools: this.options.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: {
              type: 'object',
              properties: tool.parameters.properties,
              required: tool.parameters.required,
              additionalProperties: false,
            },
          })),
          tool_choice: 'auto',
        },
      });
    });
  }

  private send(message: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }

  private handle(event: Record<string, any>) {
    switch (event.type) {
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const pcm = this.output.push(fromB64(event.delta));
        if (pcm.length) this.handlers.audio(pcm);
        return;
      }
      case 'input_audio_buffer.speech_started':
        this.handlers.interrupted();
        return;
      case 'conversation.item.input_audio_transcription.completed':
        if (this.options.transcribe && typeof event.transcript === 'string')
          this.handlers.transcript('candidate', event.transcript.trim());
        return;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (typeof event.transcript === 'string' && event.transcript.trim())
          this.handlers.transcript('ai', event.transcript.trim());
        return;
      case 'response.function_call_arguments.done':
        this.call(event.call_id, event.name, event.arguments);
        return;
      case 'response.done': {
        for (const item of event.response?.output ?? [])
          if (item?.type === 'function_call')
            this.call(item.call_id, item.name, item.arguments);
        const error = event.response?.status_details?.error;
        if (event.response?.status === 'failed' && error) {
          const text =
            `${String(error.code ?? '')} ${String(error.message ?? '')}`.slice(
              0,
              300,
            );
          const reason = voiceFailure(text);
          if (reason !== 'protocol' && !this.closed) {
            this.closed = true;
            this.handlers.failed(new VoiceError(reason, text));
          }
        }
        return;
      }
    }
  }

  private call(id: unknown, name: unknown, args: unknown) {
    if (typeof id !== 'string' || typeof name !== 'string') return;
    if (this.seenCalls.has(id)) return;
    this.seenCalls.add(id);
    let parsed: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(typeof args === 'string' ? args : '{}');
      if (value && typeof value === 'object')
        parsed = value as Record<string, unknown>;
    } catch {
      /* The tool handler reports missing fields. */
    }
    this.pending.add(id);
    this.handlers.toolCall({ id, name, args: parsed });
  }

  sendAudio(pcm16k: Buffer) {
    const pcm = this.input.push(pcm16k);
    if (pcm.length)
      this.send({ type: 'input_audio_buffer.append', audio: b64(pcm) });
  }

  toolResult(
    call: VoiceToolCall,
    result: Record<string, unknown>,
    reply: boolean,
  ) {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: call.id,
        output: JSON.stringify(result),
      },
    });
    this.pending.delete(call.id);
    this.replyAfterTools ||= reply;
    if (!this.pending.size && this.replyAfterTools) {
      this.replyAfterTools = false;
      this.send({ type: 'response.create' });
    }
  }

  instruct(text: string) {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    this.send({ type: 'response.create' });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket?.close(1000);
  }
}
