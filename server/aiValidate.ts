import { config } from './config';

/**
 * Boot-time validator for AI provider keys.
 *
 * Hits a cheap endpoint per provider (preferably one that lists models)
 * to confirm the key is structurally valid and currently accepted.
 *
 * Design notes:
 *   - We DO NOT fail boot on a bad key. The app should still start, and the
 *     UI can warn the user. Failing boot would mean a rotated key turns
 *     into downtime for the rest of the app (chapters, sync, etc).
 *   - Each probe is wrapped in an AbortController with a short timeout so a
 *     hung upstream can't delay startup indefinitely.
 *   - Results are cached in-memory so /api/ai/config can return them without
 *     re-probing every request. The cache is refreshed on a timer (every
 *     hour by default) and on explicit re-validation.
 *
 * The results are exposed via the AiKeyValidator export — `getStatus()`
 * returns the current cache, `revalidate()` forces a fresh check.
 */

export type ProviderId = 'openai' | 'anthropic' | 'gemini';

export interface KeyStatus {
  /** Whether the key is set in env at all. */
  configured: boolean;
  /** Last validation outcome: 'ok', 'invalid', 'error', 'unchecked'. */
  state: 'ok' | 'invalid' | 'error' | 'unchecked';
  /** Last error string for 'invalid' / 'error' states. */
  message?: string;
  /** Epoch ms of the last check. */
  checkedAt?: number;
}

const PROBE_TIMEOUT_MS = 8000;
const REVALIDATE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const cache: Record<ProviderId, KeyStatus> = {
  openai: { configured: false, state: 'unchecked' },
  anthropic: { configured: false, state: 'unchecked' },
  gemini: { configured: false, state: 'unchecked' },
};

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await p;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OpenAI: GET /v1/models is cheap, list-only, and returns 401 with a clear
 * "Invalid API key" body on bad keys. We don't actually use the model list.
 */
async function probeOpenAi(apiKey: string): Promise<KeyStatus> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status === 401) {
      return { configured: true, state: 'invalid', message: 'OpenAI rejected the key (401).', checkedAt: Date.now() };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { configured: true, state: 'error', message: `OpenAI ${res.status}: ${body.slice(0, 200)}`, checkedAt: Date.now() };
    }
    return { configured: true, state: 'ok', checkedAt: Date.now() };
  } catch (err: any) {
    return { configured: true, state: 'error', message: err?.message || 'Network error', checkedAt: Date.now() };
  }
}

/**
 * Anthropic: there is no /models list endpoint that accepts cheap auth-only
 * calls, but POST /v1/messages with a 1-token request validates the key
 * (and bills the tiny amount). We send max_tokens=1 to keep it minimal.
 *
 * A clearly invalid key returns 401 with `authentication_error`. Anything
 * else (4xx with valid auth, model-not-found, etc.) means the key works.
 */
async function probeAnthropic(apiKey: string): Promise<KeyStatus> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      // We pick a known-cheap model. If the account doesn't have access, we
      // still get an authenticated error rather than a 401, which is fine —
      // the auth itself succeeded.
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status === 401) {
      return { configured: true, state: 'invalid', message: 'Anthropic rejected the key (401).', checkedAt: Date.now() };
    }
    // 200 or any non-auth error means the key authenticated.
    return { configured: true, state: 'ok', checkedAt: Date.now() };
  } catch (err: any) {
    return { configured: true, state: 'error', message: err?.message || 'Network error', checkedAt: Date.now() };
  }
}

/**
 * Gemini: GET /v1beta/models?key=… returns 400/403 on bad keys and 200 with
 * the model list on good ones. The key is passed as a URL parameter per
 * Google's convention.
 */
async function probeGemini(apiKey: string): Promise<KeyStatus> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
      method: 'GET',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status === 400 || res.status === 403) {
      return { configured: true, state: 'invalid', message: `Gemini rejected the key (${res.status}).`, checkedAt: Date.now() };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { configured: true, state: 'error', message: `Gemini ${res.status}: ${body.slice(0, 200)}`, checkedAt: Date.now() };
    }
    return { configured: true, state: 'ok', checkedAt: Date.now() };
  } catch (err: any) {
    return { configured: true, state: 'error', message: err?.message || 'Network error', checkedAt: Date.now() };
  }
}

export async function revalidate(): Promise<typeof cache> {
  const openaiKey = config.openaiKey;
  const anthropicKey = config.anthropicKey;
  const geminiKey = config.geminiKey;

  // Run all three in parallel; any one that times out doesn't hold up the
  // others. Each individual probe has its own timeout already.
  const [oa, an, gm] = await Promise.all([
    openaiKey ? probeOpenAi(openaiKey) : Promise.resolve<KeyStatus>({ configured: false, state: 'unchecked' }),
    anthropicKey ? probeAnthropic(anthropicKey) : Promise.resolve<KeyStatus>({ configured: false, state: 'unchecked' }),
    geminiKey ? probeGemini(geminiKey) : Promise.resolve<KeyStatus>({ configured: false, state: 'unchecked' }),
  ]);
  cache.openai = oa;
  cache.anthropic = an;
  cache.gemini = gm;
  return cache;
}

export function getStatus(): typeof cache {
  return cache;
}

/**
 * Boot-time entry point. Runs the probe once, logs a one-line summary per
 * provider, and starts a refresh timer for long-running deployments.
 *
 * Suppress in test mode (NODE_ENV=test) to avoid touching the network in CI.
 */
export function startAiKeyValidation(): void {
  if (process.env.NODE_ENV === 'test') return;
  const summarize = (id: string, s: KeyStatus) => {
    if (!s.configured) return `  ${id.padEnd(10)}  (not configured)`;
    if (s.state === 'ok') return `  ${id.padEnd(10)}  OK`;
    return `  ${id.padEnd(10)}  ${s.state.toUpperCase()}${s.message ? ` — ${s.message}` : ''}`;
  };

  revalidate().then((c) => {
    console.log('[ai] Key validation:');
    console.log(summarize('openai', c.openai));
    console.log(summarize('anthropic', c.anthropic));
    console.log(summarize('gemini', c.gemini));
  }).catch((err) => {
    console.error('[ai] Key validation failed unexpectedly:', err);
  });

  // Refresh periodically so a key rotation eventually reflects in the UI
  // without restarting the server.
  setInterval(() => { void revalidate(); }, REVALIDATE_INTERVAL_MS).unref();
}
