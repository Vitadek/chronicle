import { authFetch } from './authService';
import type { AiConfig, AiProvider } from './aiConfig';
import { PROVIDERS } from './aiConfig';

/**
 * Client wrappers for the AI proxy. The provider + model travel in every
 * request body; the API key lives server-side and is attached during proxy
 * forwarding. The server normalises Anthropic and Gemini responses into the
 * OpenAI Responses shape so callers don't need to know which upstream
 * answered.
 */

export interface ProviderStatus {
  configured: boolean;
  valid: boolean;
  state: 'ok' | 'invalid' | 'error' | 'unchecked';
  message: string | null;
  checkedAt: number | null;
}

export interface AiServerConfig {
  providers: Record<AiProvider, ProviderStatus>;
  defaultModel: string;
  audioModel: string;
  audioVoice: string;
}

/**
 * Fetch which providers the server has keys for and whether boot-time key
 * probes succeeded. The Settings panel renders the result to dim providers
 * whose key is missing or rejected.
 */
export async function fetchAiServerConfig(): Promise<AiServerConfig | null> {
  try {
    const res = await authFetch('/api/ai/config');
    if (!res.ok) return null;
    return (await res.json()) as AiServerConfig;
  } catch {
    return null;
  }
}

/**
 * Force the server to re-run its key probes. Returns the fresh status so
 * the UI can update immediately without waiting for the hourly refresh.
 */
export async function revalidateAiKeys(): Promise<Record<AiProvider, ProviderStatus> | null> {
  try {
    const res = await authFetch('/api/ai/config/revalidate', { method: 'POST' });
    if (!res.ok) return null;
    const data = await res.json();
    // Server returns the raw cache shape; coerce to our typed view.
    return data as Record<AiProvider, ProviderStatus>;
  } catch {
    return null;
  }
}

export async function getAiResponse(input: string, cfg: AiConfig, system?: string): Promise<any> {
  const response = await authFetch('/api/ai/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: cfg.provider,
      model: cfg.textModel,
      input,
      maxTokens: cfg.maxTokens,
      system,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const message = typeof data.error?.message === 'string'
      ? data.error.message
      : (data.error ? JSON.stringify(data.error) : `AI API returned ${response.status}`);
    throw new Error(message);
  }
  return data;
}

/**
 * Pull the text content out of the normalised AI response. Works the same
 * for OpenAI, Anthropic, and Gemini because the server normalises all three
 * into `output[].content[].text`.
 */
export function extractAiText(response: any): string {
  if (typeof response?.output_text === 'string') return response.output_text;
  if (Array.isArray(response?.output)) {
    const parts: string[] = [];
    for (const item of response.output) {
      if (item?.content && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (typeof block?.text === 'string') parts.push(block.text);
        }
      }
    }
    if (parts.length) return parts.join('\n\n');
  }
  return '';
}

/**
 * Text-to-speech. Only valid when the active provider supports TTS
 * (currently OpenAI only). The server bills against OPENAI_API_KEY
 * regardless of which text provider is active — TTS is a separate
 * capability with its own key.
 */
export async function getAiSpeech(text: string, cfg: AiConfig): Promise<string> {
  const provider = PROVIDERS[cfg.provider];
  if (!provider.supportsTts) {
    throw new Error(`${provider.name} doesn't offer text-to-speech. Switch to OpenAI to use /ai_listen.`);
  }

  const response = await authFetch('/api/ai/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.ttsModel || provider.defaultTtsModel,
      voice: cfg.ttsVoice || provider.defaultTtsVoice,
      text,
    }),
  });
  if (!response.ok) {
    try {
      const j = await response.json();
      throw new Error(j?.error?.message || `TTS failed: ${response.status}`);
    } catch {
      throw new Error(`TTS failed: ${response.status}`);
    }
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
