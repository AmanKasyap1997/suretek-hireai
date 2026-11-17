import express from 'express';
import request from 'supertest';
import { requestLogging, SafeJsonLogger } from '../src/platform/http/logging';

describe('privacy-preserving JSON logs', () => {
  it('assigns a new request ID and omits paths, queries, headers and bodies', async () => {
    const lines: string[] = [];
    const output = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
      });
    try {
      const app = express();
      app.use(requestLogging);
      app.post('/probe/:personal', (_req, res) => {
        res.sendStatus(202);
      });
      const response = await request(app)
        .post('/probe/personal-name?token=secret-query')
        .set('Authorization', 'Bearer secret-header')
        .set('X-Request-ID', 'untrusted-id')
        .send({ email: 'private@example.test', password: 'secret-body' });
      expect(response.status).toBe(202);
      expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
      const event = JSON.parse(lines.join(''));
      expect(event).toMatchObject({
        event: 'http_request',
        requestId: response.headers['x-request-id'],
        method: 'POST',
        status: 202,
      });
      expect(Object.keys(event).sort()).toEqual([
        'durationMs',
        'event',
        'method',
        'requestId',
        'status',
        'time',
      ]);
      expect(lines.join('')).not.toMatch(/secret|private|personal|untrusted/);
    } finally {
      output.mockRestore();
    }
  });
  it('drops arbitrary framework and provider messages', () => {
    const output = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const logger = new SafeJsonLogger();
      // Nest passes arbitrary messages; the adapter deliberately has no message parameter.
      const invoke = logger.error.bind(logger) as (...args: unknown[]) => void;
      invoke('private@example.test', new Error('password=secret'));
      const event = JSON.parse(String(output.mock.calls[0][0]));
      expect(event).toMatchObject({ event: 'runtime', level: 'error' });
      expect(JSON.stringify(event)).not.toMatch(/private|password|secret/);
    } finally {
      output.mockRestore();
    }
  });
});
