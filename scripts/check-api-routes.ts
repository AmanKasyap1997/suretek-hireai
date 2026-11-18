export {};
// No credentials required: a registered protected route returns 401, not 404.
const origin = process.env.API_CHECK_ORIGIN ?? 'http://localhost:3000';
async function main() {
  let failed = false;
  for (const path of [
    '/super-admin/organizations',
    '/super-admin/integrations',
    '/super-admin/integration-providers',
    '/organization/integrations',
  ]) {
    try {
      const response = await fetch(new URL('/api/v1' + path, origin), {
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      const ok = response.status === 401;
      await response.body?.cancel();
      console.log(
        `${ok ? 'PASS' : 'FAIL'} /api/v1${path}: HTTP ${response.status}`,
      );
      if (!ok) failed = true;
    } catch {
      console.log(`FAIL /api/v1${path}: cannot reach API`);
      failed = true;
    }
  }
  if (failed) {
    console.error(
      'Rebuild and restart the API from feature/super-admin-completion. Check API_TARGET / reverse proxy routing. A frontend rebuild alone does not update backend routes.',
    );
    process.exitCode = 1;
  }
}
void main();
