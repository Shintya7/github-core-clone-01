// The entrypoint: bind the forge on an ephemeral port, register that port with the
// trial environment, then poll until the environment says the trial is over and exit 0.
//
//   MAKEFUN_ENV_URL   the env's origin (http://store:8080 in a trial container)
//   MAKEFUN_SHOP_TOKEN the bearer token the suite presents (read by app.ts)
//
// The lifecycle is deliberately boring: bind(0), POST /register {"port": N}, then
// GET /done in a loop with exponential backoff. A register or poll that fails is
// retried; only a contract error (400/405 on register) or a missing env URL ends the
// process early. The process never exits before /done answers {"done": true}.

import { createForgeServer } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: there is no environment to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it (200) or reports a first register (409). */
async function registerPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The env may still be starting: wait and try again.
    }
    if (response !== null) {
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    }
    await sleep(backoff(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A failed poll means "not done yet": wait and poll again.
    }
    await sleep(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const server = createForgeServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);

  await registerPort(address.port);
  process.stdout.write('[forge] registered; waiting for the environment to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
