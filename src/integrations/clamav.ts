import { createConnection } from 'node:net';
import { DocumentScanStatus as Status } from '../shared/enums';
import { MalwareScanPort } from './intake';

/** clamd INSTREAM with an absolute deadline, bounded reply and backpressure. */
export class ClamAvScanner extends MalwareScanPort {
  constructor(
    private readonly options: {
      host: string;
      port: number;
      timeoutMs: number;
      maxBytes: number;
    },
  ) {
    super();
  }
  async scan(bytes: Buffer): Promise<Status> {
    if (!bytes.length || bytes.length > this.options.maxBytes)
      return Status.FAILED;
    return new Promise((resolve) => {
      const socket = createConnection({
        host: this.options.host,
        port: this.options.port,
      });
      let done = false,
        reply = Buffer.alloc(0),
        offset = 0;
      const finish = (status: Status) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(status);
      };
      const timer = setTimeout(
        () => finish(Status.FAILED),
        this.options.timeoutMs,
      );
      socket.on('error', () => finish(Status.FAILED));
      socket.on('end', () => finish(Status.FAILED));
      socket.on('close', () => finish(Status.FAILED));
      socket.on('data', (chunk: Buffer) => {
        reply = Buffer.concat([reply, chunk]);
        if (reply.length > 4096) return finish(Status.FAILED);
        const end = reply.indexOf(0);
        if (end < 0) return;
        const value = reply.subarray(0, end).toString('utf8');
        finish(
          value === 'stream: OK'
            ? Status.CLEAN
            : /^stream: [^\r\n]+ FOUND$/.test(value)
              ? Status.INFECTED
              : Status.FAILED,
        );
      });
      const send = () => {
        if (done) return;
        while (offset < bytes.length) {
          const part = bytes.subarray(offset, offset + 65536);
          offset += part.length;
          const header = Buffer.alloc(4);
          header.writeUInt32BE(part.length);
          if (!socket.write(Buffer.concat([header, part]))) {
            socket.once('drain', send);
            return;
          }
        }
        socket.write(Buffer.alloc(4));
      };
      socket.once('connect', () => {
        socket.write('zINSTREAM\0');
        send();
      });
    });
  }
}
