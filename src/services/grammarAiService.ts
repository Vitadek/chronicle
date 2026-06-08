import { authFetch } from './authService';

export interface AiIssue {
  /** Exact substring of the text the model flagged. */
  quote: string;
  message: string;
  suggestion?: string;
}

/**
 * Run the on-demand AI grammar pass over a chunk of text. Catches the
 * structural errors (fragments, missing verbs) that the live rule engine can't.
 * Throws with the server's message on failure so the UI can surface it.
 */
export async function aiGrammarPass(text: string): Promise<AiIssue[]> {
  const res = await authFetch('/api/ai/grammar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    let msg = 'AI grammar pass failed';
    try {
      const e = await res.json();
      msg = e?.error?.message || msg;
    } catch {
      /* non-JSON error */
    }
    throw new Error(msg);
  }
  const data = (await res.json()) as { issues?: AiIssue[] };
  return data.issues || [];
}
