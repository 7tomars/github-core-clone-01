// main.ts — the entry <-> env lifecycle: bind an ephemeral port, tell the env the
// port, then poll until the env says the trial is over and exit 0.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to
//      register with, so the program exits 1 at once.
//   2. The server listens on port 0 (the kernel picks a free port) — never 8080,
//      which the env owns.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}; the first register wins.
//   4. GET $MAKEFUN_ENV_URL/done until it answers {"done": true}; a failed poll
//      is retried with a short backoff and the process never exits early.
//   5. Close the server and exit 0.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postRegister(port: number): Promise<boolean> {
  try {
    const response = await fetch(`${ENV_URL}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.text().catch(() => undefined);
    return response.status === 200;
  } catch {
    return false;
  }
}

async function pollDone(): Promise<boolean> {
  try {
    const response = await fetch(`${ENV_URL}/done`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { done?: unknown } | null;
    return body?.done === true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    process.stderr.write('[entry] server has no port\n');
    process.exit(1);
  }
  const port = address.port;

  let wait = RETRY_INITIAL_MS;
  while (!(await postRegister(port))) {
    await sleep(wait);
    wait = Math.min(RETRY_MAX_MS, wait * 2);
  }

  wait = RETRY_INITIAL_MS;
  for (;;) {
    if (await pollDone()) break;
    await sleep(wait);
    wait = Math.min(RETRY_MAX_MS, wait * 2);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

void main();
