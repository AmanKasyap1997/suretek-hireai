import { createServer, Server } from 'node:net';
import { ClamAvScanner, TurnstileCaptcha } from '../src/integrations';
import { DocumentScanStatus as S } from '../src/shared/enums';
const eicar = Buffer.from(
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
);
describe('ClamAV INSTREAM', () => {
  let server: Server, port: number;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });
  async function start(mode = 'normal') {
    server = createServer((socket) => {
      let bytes = Buffer.alloc(0);
      socket.on('data', (data) => {
        bytes = Buffer.concat([bytes, data]);
        if (mode === 'timeout') return;
        if (bytes.length < 10) return;
        expect(bytes.subarray(0, 10).toString()).toBe('zINSTREAM\0');
        let offset = 10;
        const parts: Buffer[] = [];
        while (offset + 4 <= bytes.length) {
          const size = bytes.readUInt32BE(offset);
          offset += 4;
          if (size === 0) {
            const payload = Buffer.concat(parts);
            socket.end(
              mode === 'bad'
                ? 'stream: OK'
                : payload.includes(eicar)
                  ? 'stream: Eicar-Test-Signature FOUND\0'
                  : 'stream: OK\0',
            );
            return;
          }
          if (offset + size > bytes.length) return;
          expect(size).toBeLessThanOrEqual(65536);
          parts.push(bytes.subarray(offset, offset + size));
          offset += size;
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  }
  const scanner = () =>
    new ClamAvScanner({
      host: '127.0.0.1',
      port,
      timeoutMs: 150,
      maxBytes: 200000,
    });
  it('chunks large streams and distinguishes clean from EICAR', async () => {
    await start();
    expect(await scanner().scan(Buffer.alloc(150000, 65))).toBe(S.CLEAN);
    expect(await scanner().scan(eicar)).toBe(S.INFECTED);
  });
  it('fails closed on truncated replies and oversized input', async () => {
    await start('bad');
    expect(await scanner().scan(Buffer.from('test'))).toBe(S.FAILED);
    expect(await scanner().scan(Buffer.alloc(200001))).toBe(S.FAILED);
  });
  it('bounds an unresponsive scanner with an absolute deadline', async () => {
    await start('timeout');
    expect(await scanner().scan(Buffer.from('test'))).toBe(S.FAILED);
  });
});
describe('Turnstile', () => {
  afterEach(() => jest.restoreAllMocks());
  const adapter = () =>
    new TurnstileCaptcha({
      secretKey: 'test-only',
      timeoutMs: 100,
      expectedHostname: 'careers.example.test',
      expectedAction: 'apply',
    });
  it('requires success, matching hostname and action', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          hostname: 'careers.example.test',
          action: 'apply',
        }),
      ),
    );
    expect(await adapter().verify('token', '192.0.2.1')).toBe(true);
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          hostname: 'attacker.test',
          action: 'apply',
        }),
      ),
    );
    expect(await adapter().verify('token', '192.0.2.1')).toBe(false);
  });
  it('rejects missing, malformed, oversized and failed responses', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    expect(await adapter().verify(undefined, '192.0.2.1')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    for (const body of [
      'bad',
      JSON.stringify({ success: false }),
      'x'.repeat(9000),
    ]) {
      fetch.mockResolvedValue(new Response(body));
      expect(await adapter().verify('token', '192.0.2.1')).toBe(false);
    }
    fetch.mockRejectedValue(new Error('unavailable'));
    expect(await adapter().verify('token', '192.0.2.1')).toBe(false);
  });
});
