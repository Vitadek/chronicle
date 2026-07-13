import { config } from '../config';

/**
 * What the HOST can offer a plugin right now — the `host:*` half of the plugin
 * capability namespace (see pluginResolve.ts).
 *
 * A plugin declares `"requires": ["host:languagetool"]` and the host refuses to
 * enable it when the sidecar isn't there, instead of loading it and letting it
 * silently do nothing. That was the old failure mode: Grammar Check and
 * Proofreader would install, enable, and simply never flag anything.
 *
 * LanguageTool is PROBED, not read from config: LANGUAGETOOL_URL has a default
 * (http://languagetool:8010), so it is always set and a config check would
 * always say "yes" — including on the many installs that never ran the sidecar.
 * The only honest answer comes from asking it.
 */

/** Capability strings the host can provide. */
export const HOST_CAPABILITIES = ['host:languagetool', 'host:ai', 'host:gemini'] as const;
export type HostCapability = (typeof HOST_CAPABILITIES)[number];

const PROBE_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 60_000;

let cache: { at: number; caps: string[] } | null = null;

/** Is the LanguageTool sidecar actually up? Cheap, cached endpoint. */
async function languagetoolReachable(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.grammar.languagetoolUrl}/v2/languages`, {
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false; // unreachable, DNS failure, timeout — all the same to a plugin
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The live host capability set. Cached for a minute: this is consulted on every
 * plugin list, and a dead sidecar would otherwise cost a 2s timeout each time.
 */
export async function hostCapabilities(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.caps;

  const caps: string[] = [];

  if (await languagetoolReachable()) caps.push('host:languagetool');

  // AI_UI=off is a hard kill switch: the server refuses AI calls, so a plugin's
  // AI path is dead even with keys configured. Report it as absent.
  const anyKey = !!(config.openaiKey || config.anthropicKey || config.geminiKey);
  if (config.aiUiEnabled && anyKey) caps.push('host:ai');
  // Structured-output passes (Proofread clarity, the AI grammar pass) are
  // Gemini-specific, so they get their own capability.
  if (config.aiUiEnabled && config.geminiKey) caps.push('host:gemini');

  cache = { at: Date.now(), caps };
  return caps;
}

/** Drop the cache — used by tests and after a config-affecting change. */
export function invalidateHostCapabilities(): void {
  cache = null;
}

/** Human-readable "why isn't this available", shown in Settings. */
export function explainMissingHostCapability(cap: string): string {
  switch (cap) {
    case 'host:languagetool':
      return `LanguageTool is not reachable at ${config.grammar.languagetoolUrl}. Start the sidecar (see docker-compose.yml) or set LANGUAGETOOL_URL.`;
    case 'host:ai':
      return config.aiUiEnabled
        ? 'No AI provider key is configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY.'
        : 'AI is disabled on this instance (AI_UI=off).';
    case 'host:gemini':
      return config.aiUiEnabled
        ? 'This needs GEMINI_API_KEY (it uses Gemini structured output).'
        : 'AI is disabled on this instance (AI_UI=off).';
    default:
      return `The host does not provide "${cap}".`;
  }
}
