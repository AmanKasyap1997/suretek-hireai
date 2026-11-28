/** What the AI recorded for one question during a call. */
export type CallAnswer = {
  question_id: string;
  question: string;
  answered: boolean;
  answer: string;
  value: string | null;
  expected_answer: 'yes' | 'no' | null;
  matches_expected: boolean | null;
};

export type CallOutcome =
  'COMPLETED' | 'DECLINED' | 'CALL_BACK' | 'WRONG_PERSON' | 'NO_RESPONSE';

export interface TestCallHandlers {
  live(provider: string): void;
  transcript(speaker: 'ai' | 'candidate', text: string): void;
  answer(answer: CallAnswer): void;
  ended(outcome: CallOutcome, summary: string | null, reason: string): void;
  /** The connection closed (after `ended`, or unexpectedly). */
  closed(): void;
}

export interface TestCallConnection {
  hangUp(): void;
}

const RATE = 16000;

/**
 * A browser test call: the microphone streams to HireAI as 16 kHz PCM and the
 * AI's speech plays back. Echo cancellation keeps the AI from hearing itself.
 */
export async function startTestCall(
  ticket: string,
  handlers: TestCallHandlers,
): Promise<TestCallConnection> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext();
  let socket: WebSocket | null = null;
  let done = false;
  const playing = new Set<AudioBufferSourceNode>();
  const stopPlayback = () => {
    for (const source of playing) {
      try {
        source.stop();
      } catch {
        /* Already stopped. */
      }
    }
    playing.clear();
    playhead = 0;
  };
  let playhead = 0;
  const cleanup = () => {
    if (done) return;
    done = true;
    stopPlayback();
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };
  try {
    await context.audioWorklet.addModule(
      `${import.meta.env.BASE_URL}call-mic-worklet.js`,
    );
    const microphone = context.createMediaStreamSource(stream);
    const encoder = new AudioWorkletNode(context, 'call-mic');
    // A silent route to the speakers keeps the encoder running.
    const mute = context.createGain();
    mute.gain.value = 0;
    microphone.connect(encoder).connect(mute).connect(context.destination);

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(
      `${scheme}://${location.host}/api/v1/calls/test/${ticket}`,
    );
    socket.binaryType = 'arraybuffer';
    const open = socket;
    encoder.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (open.readyState === WebSocket.OPEN) open.send(event.data);
    };
    open.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data !== 'string') {
        const samples = new Int16Array(event.data);
        if (!samples.length) return;
        const buffer = context.createBuffer(1, samples.length, RATE);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++)
          channel[i] = samples[i] / 0x8000;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        const at = Math.max(context.currentTime + 0.05, playhead);
        source.start(at);
        playhead = at + buffer.duration;
        playing.add(source);
        source.onended = () => playing.delete(source);
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'clear') stopPlayback();
      else if (message.type === 'live') handlers.live(String(message.provider));
      else if (message.type === 'transcript')
        handlers.transcript(
          message.speaker === 'ai' ? 'ai' : 'candidate',
          String(message.text ?? ''),
        );
      else if (message.type === 'answer')
        handlers.answer(message.answer as CallAnswer);
      else if (message.type === 'ended')
        handlers.ended(
          message.outcome as CallOutcome,
          typeof message.summary === 'string' ? message.summary : null,
          String(message.reason ?? ''),
        );
    };
    open.onclose = () => {
      // Let the goodbye finish playing before releasing the speakers.
      const left = Math.max(0, playhead - context.currentTime);
      window.setTimeout(cleanup, left * 1000 + 200);
      handlers.closed();
    };
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    hangUp() {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'hangup' }));
      socket?.close();
      cleanup();
    },
  };
}
