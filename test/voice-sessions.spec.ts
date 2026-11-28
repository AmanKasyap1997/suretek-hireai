import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import {
  callTools,
  GeminiLiveSession,
  OpenAiRealtimeSession,
  VoiceError,
  VoiceHandlers,
  VoiceSessionOptions,
} from '../src/modules/talent-acquisition';

/** A stand-in for the provider's WebSocket API. */
async function fakeProvider(reject?: number) {
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    ...(reject ? { verifyClient: (_info, done) => done(false, reject) } : {}),
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const state = {
    server,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/live`,
    received: [] as Record<string, any>[],
    headers: {} as IncomingHttpHeaders,
    socket: null as WebSocket | null,
    reply: (() => undefined) as (
      message: Record<string, any>,
      socket: WebSocket,
    ) => void,
  };
  server.on('connection', (socket, request) => {
    state.socket = socket;
    state.headers = request.headers;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      state.received.push(message);
      state.reply(message, socket);
    });
  });
  return state;
}

function handlers() {
  return {
    audio: jest.fn(),
    interrupted: jest.fn(),
    transcript: jest.fn(),
    toolCall: jest.fn(),
    failed: jest.fn(),
  } satisfies VoiceHandlers;
}

async function until(check: () => unknown) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out');
}

const options = (endpoint: string): VoiceSessionOptions => ({
  apiKey: 'test-key',
  model: 'test-model',
  voice: 'Kore',
  instructions: 'Ask the questions.',
  tools: callTools,
  language: 'EN',
  transcribe: true,
  endpoint,
});

const send = (socket: WebSocket | null, message: unknown) =>
  socket!.send(JSON.stringify(message));

describe('Gemini Live session', () => {
  let provider: Awaited<ReturnType<typeof fakeProvider>>;
  afterEach(() => provider.server.close());

  it('sets up audio with tools, then streams speech, transcripts and tool calls', async () => {
    provider = await fakeProvider();
    provider.reply = (message, socket) => {
      if (message.setup) socket.send(JSON.stringify({ setupComplete: {} }));
    };
    const events = handlers();
    const session = new GeminiLiveSession(options(provider.url), events);
    await session.start('The candidate answered.');
    expect(provider.headers['x-goog-api-key']).toBe('test-key');
    const setup = provider.received[0].setup;
    expect(setup.model).toBe('models/test-model');
    expect(setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(
      setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig
        .voiceName,
    ).toBe('Kore');
    expect(setup.systemInstruction.parts[0].text).toBe('Ask the questions.');
    // Noisy phone lines and thinking pauses: patient turn detection.
    // Default start sensitivity: a low one missed quiet phone speech.
    expect(
      setup.realtimeInputConfig.automaticActivityDetection,
    ).not.toHaveProperty('startOfSpeechSensitivity');
    expect(setup.realtimeInputConfig.automaticActivityDetection).toMatchObject({
      endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
      silenceDurationMs: 1000,
    });
    const declaration = setup.tools[0].functionDeclarations[0];
    expect(declaration.name).toBe('record_answer');
    expect(declaration.parameters.type).toBe('OBJECT');
    expect(declaration.parameters.properties.answered.type).toBe('BOOLEAN');
    await until(() => provider.received[1]);
    expect(provider.received[1].clientContent).toEqual({
      turns: [{ role: 'user', parts: [{ text: 'The candidate answered.' }] }],
      turnComplete: true,
    });

    session.sendAudio(Buffer.alloc(640));
    await until(() => provider.received[2]);
    expect(provider.received[2].realtimeInput.audio.mimeType).toBe(
      'audio/pcm;rate=16000',
    );

    send(provider.socket, {
      serverContent: { inputTranscription: { text: 'Yes, ' } },
    });
    send(provider.socket, {
      serverContent: { inputTranscription: { text: 'speaking.' } },
    });
    send(provider.socket, {
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/pcm;rate=24000',
                data: Buffer.alloc(4800).toString('base64'),
              },
            },
          ],
        },
        outputTranscription: { text: 'Great, thank you.' },
      },
    });
    send(provider.socket, { serverContent: { turnComplete: true } });
    send(provider.socket, {
      toolCall: {
        functionCalls: [
          { id: 'call-1', name: 'record_answer', args: { question_id: 'q1' } },
        ],
      },
    });
    send(provider.socket, { serverContent: { interrupted: true } });
    await until(() => events.interrupted.mock.calls.length);
    const audio: Buffer = events.audio.mock.calls[0][0];
    expect(Math.abs(audio.length - 3200)).toBeLessThanOrEqual(4);
    expect(events.transcript.mock.calls).toEqual([
      ['candidate', 'Yes, speaking.'],
      ['ai', 'Great, thank you.'],
    ]);
    expect(events.toolCall).toHaveBeenCalledWith({
      id: 'call-1',
      name: 'record_answer',
      args: { question_id: 'q1' },
    });

    session.toolResult(events.toolCall.mock.calls[0][0], { saved: true });
    await until(() => provider.received.some((m) => m.toolResponse));
    expect(provider.received.find((m) => m.toolResponse)!.toolResponse).toEqual(
      {
        functionResponses: [
          { id: 'call-1', name: 'record_answer', response: { saved: true } },
        ],
      },
    );
    session.close();
    expect(events.failed).not.toHaveBeenCalled();
  });

  it('reports a quota or key problem before the call starts', async () => {
    provider = await fakeProvider();
    provider.reply = (message, socket) => {
      if (message.setup)
        socket.close(1011, 'Resource has been exhausted (e.g. check quota).');
    };
    await expect(
      new GeminiLiveSession(options(provider.url), handlers()).start('Go'),
    ).rejects.toMatchObject({ reason: 'quota' });
    provider.server.close();
    provider = await fakeProvider(403);
    const failure = new GeminiLiveSession(
      options(provider.url),
      handlers(),
    ).start('Go');
    await expect(failure).rejects.toBeInstanceOf(VoiceError);
    await expect(failure).rejects.toMatchObject({ reason: 'auth' });
  });

  it('reports a session that drops during the call', async () => {
    provider = await fakeProvider();
    provider.reply = (message, socket) => {
      if (message.setup) socket.send(JSON.stringify({ setupComplete: {} }));
    };
    const events = handlers();
    await new GeminiLiveSession(options(provider.url), events).start('Go');
    provider.socket!.close(1011, 'Internal error');
    await until(() => events.failed.mock.calls.length);
    expect(events.failed.mock.calls[0][0]).toMatchObject({
      reason: 'protocol',
    });
  });
});

describe('OpenAI Realtime session', () => {
  let provider: Awaited<ReturnType<typeof fakeProvider>>;
  afterEach(() => provider.server.close());

  it('configures 24 kHz audio and tools, then answers tool calls and continues', async () => {
    provider = await fakeProvider();
    provider.reply = (message, socket) => {
      if (message.type === 'session.update')
        socket.send(JSON.stringify({ type: 'session.updated' }));
    };
    const events = handlers();
    const session = new OpenAiRealtimeSession(
      { ...options(provider.url), voice: 'marin' },
      events,
    );
    await session.start('The candidate answered.');
    expect(provider.headers.authorization).toBe('Bearer test-key');
    const update = provider.received[0];
    expect(update.session.type).toBe('realtime');
    expect(update.session.audio.input.format).toEqual({
      type: 'audio/pcm',
      rate: 24000,
    });
    expect(update.session.audio.input.transcription.model).toBe(
      'gpt-4o-mini-transcribe',
    );
    expect(update.session.audio.output.voice).toBe('marin');
    expect(update.session.audio.input.turn_detection).toEqual({
      type: 'semantic_vad',
      eagerness: 'low',
    });
    expect(update.session.tools[1]).toMatchObject({
      type: 'function',
      name: 'end_call',
      parameters: { type: 'object', required: ['outcome', 'summary'] },
    });
    await until(() => provider.received.length >= 3);
    expect(provider.received[1].item.content[0].text).toBe(
      'The candidate answered.',
    );
    expect(provider.received[2]).toEqual({ type: 'response.create' });

    session.sendAudio(Buffer.alloc(640));
    await until(() => provider.received.length >= 4);
    const appended = Buffer.from(provider.received[3].audio, 'base64');
    expect(Math.abs(appended.length - 960)).toBeLessThanOrEqual(4);

    send(provider.socket, {
      type: 'response.output_audio.delta',
      delta: Buffer.alloc(4800).toString('base64'),
    });
    send(provider.socket, { type: 'input_audio_buffer.speech_started' });
    send(provider.socket, {
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Yes, speaking.',
    });
    const call = {
      type: 'function_call',
      call_id: 'call-1',
      name: 'record_answer',
      arguments: '{"question_id":"q1","answered":true,"answer":"Yes"}',
    };
    send(provider.socket, {
      ...call,
      type: 'response.function_call_arguments.done',
    });
    send(provider.socket, {
      type: 'response.done',
      response: { status: 'completed', output: [call] },
    });
    await until(() => events.toolCall.mock.calls.length);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.toolCall).toHaveBeenCalledTimes(1);
    expect(events.toolCall).toHaveBeenCalledWith({
      id: 'call-1',
      name: 'record_answer',
      args: { question_id: 'q1', answered: true, answer: 'Yes' },
    });
    expect(events.interrupted).toHaveBeenCalled();
    expect(events.transcript).toHaveBeenCalledWith(
      'candidate',
      'Yes, speaking.',
    );
    expect(
      Math.abs(events.audio.mock.calls[0][0].length - 3200),
    ).toBeLessThanOrEqual(4);

    const before = provider.received.length;
    session.toolResult(events.toolCall.mock.calls[0][0], { saved: true }, true);
    await until(() => provider.received.length >= before + 2);
    expect(provider.received.slice(before)).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: '{"saved":true}',
        },
      },
      { type: 'response.create' },
    ]);
    session.close();
  });

  it('reports an account without credits', async () => {
    provider = await fakeProvider();
    provider.reply = (message, socket) => {
      if (message.type === 'session.update')
        socket.send(
          JSON.stringify({
            type: 'error',
            error: {
              code: 'insufficient_quota',
              message: 'You exceeded your current quota.',
            },
          }),
        );
    };
    await expect(
      new OpenAiRealtimeSession(options(provider.url), handlers()).start('Go'),
    ).rejects.toMatchObject({ reason: 'quota' });
    provider.server.close();
    provider = await fakeProvider(401);
    await expect(
      new OpenAiRealtimeSession(options(provider.url), handlers()).start('Go'),
    ).rejects.toMatchObject({ reason: 'auth' });
  });
});
