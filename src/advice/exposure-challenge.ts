export function challengeAdviceResponse(stdout: string, makeToken: () => string): string {
  const response = JSON.parse(stdout) as { status?: unknown; entries?: unknown };
  if (response.status !== 'ready' || !Array.isArray(response.entries) || response.entries.length === 0) return stdout;
  const token = makeToken();
  if (!/^[a-f0-9]{32}$/.test(token)) throw new TypeError('Delivery challenge must be a 128-bit hex token.');
  const challenged = JSON.stringify({ ...response, deliveryChallenge: `aap-challenge:${token}` }) + '\n';
  return Buffer.byteLength(challenged, 'utf8') <= 4096 ? challenged : stdout;
}
