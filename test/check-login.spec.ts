import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frontendTenant } from '../scripts/check-login';

it('checks the tenant Vite uses, including local/mode/environment overrides', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hireai-login-check-'));
  try {
    writeFileSync(join(directory, '.env'), 'VITE_TENANT_ID=base');
    writeFileSync(join(directory, '.env.local'), 'VITE_TENANT_ID=local');
    expect(frontendTenant(directory, {})).toBe('local');
    writeFileSync(join(directory, '.env.development'), 'VITE_TENANT_ID=mode');
    expect(frontendTenant(directory, {})).toBe('mode');
    writeFileSync(
      join(directory, '.env.development.local'),
      'VITE_TENANT_ID="mode-local"',
    );
    expect(frontendTenant(directory, {})).toBe('mode-local');
    expect(frontendTenant(directory, { VITE_TENANT_ID: 'shell' })).toBe(
      'shell',
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});
