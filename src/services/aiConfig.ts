/**
 * Client-side AI preferences: which provider to talk to, which model to
 * use, optional TTS settings, and user-added custom model IDs.
 *
 * The API key itself lives server-side (OPENAI_API_KEY / ANTHROPIC_API_KEY)
 * and never leaves the host — the client only chooses what to send. The
 * server probes via `/api/auth/config` tell the UI which providers have
 * keys configured so the disabled ones can grey out.
 */

export type AiProvider = 'openai' | 'anthropic' | 'gemini';

export interface ProviderInfo {
  id: AiProvider;
  name: string;
  /** Suggested text models, newest/best first. */
  textModels: string[];
  defaultTextModel: string;
  /** True if this provider offers TTS via the same key. */
  supportsTts: boolean;
  /** OpenAI-specific TTS settings (only used when supportsTts is true). */
  ttsModels?: string[];
  defaultTtsModel?: string;
  ttsVoices?: string[];
  defaultTtsVoice?: string;
  /** Env var name the server reads this provider's key from. Surfaced in
   *  the UI when the server reports the key is missing or invalid. */
  envVar: string;
}

export const PROVIDERS: Record<AiProvider, ProviderInfo> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    textModels: [
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
      'gpt-4o-mini',
      'o1',
      'o3-mini',
    ],
    defaultTextModel: 'gpt-4o',
    supportsTts: true,
    ttsModels: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
    defaultTtsModel: 'gpt-4o-mini-tts',
    ttsVoices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],
    defaultTtsVoice: 'alloy',
    envVar: 'OPENAI_API_KEY',
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    textModels: [
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ],
    defaultTextModel: 'claude-sonnet-4-6',
    supportsTts: false,
    envVar: 'ANTHROPIC_API_KEY',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    // Public Generative Language API models. Users can add their own custom
    // models alongside these via the "Add Model" field in Settings.
    textModels: [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-1.5-pro-latest',
      'gemini-1.5-flash-latest',
    ],
    defaultTextModel: 'gemini-2.0-flash',
    supportsTts: false,
    envVar: 'GEMINI_API_KEY',
  },
};

export interface AiConfig {
  provider: AiProvider;
  textModel: string;
  /** Only meaningful when provider supports TTS. */
  ttsModel?: string;
  ttsVoice?: string;
  /** 
   * Input Limit: How much of the preceding manuscript text to include 
   * in the prompt (in characters). Defaults to 10000 (~2500 tokens).
   */
  contextLimit?: number;
  /** 
   * Output Limit: Maximum tokens for the AI response. 
   * Anthropic requires this; others treat it as a cap.
   */
  maxOutputTokens?: number;
  /**
   * User-added model IDs, scoped per provider. The Settings dropdown
   * surfaces these alongside the suggested list in PROVIDERS.
   */
  customTextModels?: Partial<Record<AiProvider, string[]>>;
}

/**
 * Merge the suggested model list with any custom models the user has added
 * for this provider. Suggestions come first; user-added entries follow.
 */
export function modelsForProvider(provider: AiProvider, customByProvider?: AiConfig['customTextModels']): string[] {
  const suggested = PROVIDERS[provider].textModels;
  const custom = customByProvider?.[provider] || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...suggested, ...custom]) {
    if (!seen.has(m)) { seen.add(m); out.push(m); }
  }
  return out;
}

export function addCustomModel(cfg: AiConfig, provider: AiProvider, model: string): AiConfig {
  const trimmed = model.trim();
  if (!trimmed) return cfg;
  const next = { ...cfg, customTextModels: { ...(cfg.customTextModels || {}) } };
  const list = [...(next.customTextModels![provider] || [])];
  if (!list.includes(trimmed) && !PROVIDERS[provider].textModels.includes(trimmed)) {
    list.push(trimmed);
  }
  next.customTextModels![provider] = list;
  return next;
}

export function removeCustomModel(cfg: AiConfig, provider: AiProvider, model: string): AiConfig {
  const next = { ...cfg, customTextModels: { ...(cfg.customTextModels || {}) } };
  const list = (next.customTextModels![provider] || []).filter(m => m !== model);
  next.customTextModels![provider] = list;
  return next;
}

const STORAGE_KEY = 'chronicle_ai_config_v1';

/**
 * Read the saved AI configuration, or null if none. Note that an absent
 * config doesn't mean AI is unusable — the UI seeds a default config (openai
 * + default model) when the user first enables AI in Settings.
 */
export function loadAiConfig(): AiConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AiConfig;
    if (!parsed.provider || !parsed.textModel) return null;
    if (parsed.provider !== 'openai' && parsed.provider !== 'anthropic' && parsed.provider !== 'gemini') return null;
    // Strip any leftover apiKey from older configs that stored it client-side.
    // The key now lives only server-side.
    delete (parsed as any).apiKey;
    return parsed;
  } catch {
    return null;
  }
}

export function saveAiConfig(cfg: AiConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function clearAiConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Build a sensible default config for a freshly enabled AI agent. */
export function defaultAiConfig(): AiConfig {
  return {
    provider: 'openai',
    textModel: PROVIDERS.openai.defaultTextModel,
    contextLimit: 10000,
    maxOutputTokens: 2048,
  };
}
