/**
 * Read MAKEFUN_ENV_URL, listen on port 0, register with the environment,
 * then poll /done, close the server, and exit 0 when complete.
 */
import { createApp } from './app.ts';

const origin = process.env.MAKEFUN_ENV_URL;
if (!origin) {
  console.error('MAKEFUN_ENV_URL is required');
  process.exit(1);
}

const server = createApp();
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '0.0.0.0', () => {
    server.removeListener('error', reject);
    resolve();
  });
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing server port');
console.error(`Forge listening on port ${address.port}`);

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function poll(path: string, options: RequestInit, complete: (response: Response) => Promise<boolean>) {
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(new URL(path, origin), {
        ...options,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 400 || response.status === 405) {
        await response.body?.cancel();
        console.error(`Environment contract error: ${path} returned ${response.status}`);
        process.exit(1);
      }
      if (await complete(response)) return;
    } catch (error) {
      console.error(`Environment ${path} retry: ${error instanceof Error ? error.message : String(error)}`);
    }
    await pause(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

await poll('/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ port: address.port }),
}, async response => {
  await response.body?.cancel();
  return response.status === 200;
});
await poll('/done', { method: 'GET' }, async response => {
  if (response.status !== 200) {
    await response.body?.cancel();
    return false;
  }
  const body = await response.json();
  return body !== null && typeof body === 'object' && body.done === true;
});
await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
process.exit(0);
