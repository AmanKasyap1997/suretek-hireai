import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { callTokenValid } from './call-links';
import { PhoneCallsService } from './phone-calls.service';
import { TestCallsService } from './test-calls.service';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PLIVO_STREAM = new RegExp(
  `^/api/v1/public/calls/plivo/stream/(${UUID})/(${UUID})/([A-Za-z0-9_-]{20,100})$`,
);
const TEST_CALL = /^\/api\/v1\/calls\/test\/([A-Za-z0-9_-]{20,100})$/;

/**
 * The audio WebSockets for AI calls, on the API's own HTTP server: Plivo's
 * per-call stream (signed address) and a recruiter's test call (one-time
 * ticket). Every other upgrade request is refused.
 */
@Injectable()
export class CallMediaGateway
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private server?: WebSocketServer;

  constructor(
    private readonly host: HttpAdapterHost,
    private readonly phone: PhoneCallsService,
    private readonly tests: TestCallsService,
  ) {}

  onApplicationBootstrap() {
    const http = this.host.httpAdapter?.getHttpServer();
    if (!http) return;
    this.server = new WebSocketServer({
      noServer: true,
      maxPayload: 256 * 1024,
    });
    http.on(
      'upgrade',
      (request: IncomingMessage, socket: Duplex, head: Buffer) =>
        this.upgrade(request, socket, head),
    );
  }

  onApplicationShutdown() {
    for (const client of this.server?.clients ?? []) client.terminate();
    this.server?.close();
  }

  private refuse(socket: Duplex, status: 403 | 404) {
    socket.end(
      `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Not Found'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const server = this.server!;
    socket.on('error', () => socket.destroy());
    let path: string;
    try {
      path = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      return this.refuse(socket, 404);
    }
    const plivo = PLIVO_STREAM.exec(path);
    if (plivo) {
      const [, tenantId, attemptId, token] = plivo;
      if (!callTokenValid(tenantId, attemptId, token))
        return this.refuse(socket, 403);
      return server.handleUpgrade(request, socket, head, (ws) =>
        this.phone.connect(tenantId, attemptId, ws),
      );
    }
    const test = TEST_CALL.exec(path);
    if (test) {
      const ticket = this.tests.take(test[1]);
      if (!ticket) return this.refuse(socket, 403);
      return server.handleUpgrade(request, socket, head, (ws) =>
        this.tests.connect(ticket, ws),
      );
    }
    this.refuse(socket, 404);
  }
}
