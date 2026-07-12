// Client side of the grammar checker. The engine is now self-hosted
// LanguageTool living behind the Chronicle server (/api/grammar/check), so the
// client just POSTs text and gets hits back — no WASM, no worker, nothing to
// download to the device.
//
// Web runs same-origin and reads the bearer from localStorage automatically.
// The mobile editor bundle (served locally in a WebView, no app localStorage)
// calls setGrammarEndpoint(serverBaseUrl, token) once before enabling.

export interface GrammarHit {
  /** Char offset into the linted text (inclusive). */
  start: number;
  /** Char offset into the linted text (exclusive). */
  end: number;
  /** LanguageTool issue type: misspelling | grammar | typographical | style | … */
  kind: string;
  message: string;
  /** Dictionary correction candidates (misspellings), capped server-side. */
  replacements?: string[];
}

let endpointBase = '';
let authToken: string | null = null;

/**
 * Configure where grammar requests go and how they authenticate. Web doesn't
 * need to call this (same-origin + localStorage token); the mobile bundle does.
 */
export function setGrammarEndpoint(base: string, token?: string | null): void {
  endpointBase = (base || '').replace(/\/+$/, '');
  if (token !== undefined) authToken = token;
}

function bearer(): string | null {
  if (authToken) return authToken;
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem('chronicle_token') : null;
  } catch {
    return null;
  }
}

/** No engine to load (server-side); kept for API parity with the old loader. */
export async function loadGrammarEngine(): Promise<void> {
  /* no-op */
}

/** Lint a chunk of text via the server's LanguageTool proxy. */
export async function lintText(text: string): Promise<GrammarHit[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = bearer();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const res = await fetch(`${endpointBase}/api/grammar/check`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { hits?: GrammarHit[] };
    return data.hits || [];
  } catch {
    return [];
  }
}
