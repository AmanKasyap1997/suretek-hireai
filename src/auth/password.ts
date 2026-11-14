import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [scheme, salt, key] = encoded.split(':');
  if (
    scheme !== 'scrypt' ||
    !/^[0-9a-f]{32}$/.test(salt ?? '') ||
    !/^[0-9a-f]{128}$/.test(key ?? '')
  )
    return false;
  return timingSafeEqual(
    (await scrypt(password, salt, 64)) as Buffer,
    Buffer.from(key, 'hex'),
  );
}
