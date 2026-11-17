process.env.BOOTSTRAP_PLATFORM = 'true';
void import('./bootstrap').catch(() => {
  console.error('Platform bootstrap could not start.');
  process.exitCode = 1;
});
