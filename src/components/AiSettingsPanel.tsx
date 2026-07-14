import React, { useState } from 'react';
import { Plus, X, Bot, Sparkles, AlertCircle, RefreshCw, Check } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  type AiConfig,
  type AiProvider,
  PROVIDERS,
  modelsForProvider,
  addCustomModel,
  removeCustomModel,
} from '../services/aiConfig';
import type { ProviderStatus } from '../services/aiService';

interface AiSettingsPanelProps {
  isDarkMode: boolean;
  isAiEnabled: boolean;
  onToggleAiEnabled: () => void;
  aiConfig: AiConfig | null;
  onUpdateAiConfig: (cfg: AiConfig | null) => void;
  isAiBubbleMenuEnabled: boolean;
  onToggleAiBubbleMenu: () => void;
  /**
   * Per-provider status reported by the server. Each entry covers whether
   * a key is configured AND whether boot-time validation passed.
   * Undefined while the initial probe is in flight; treat as available.
   */
  serverProviders?: Partial<Record<AiProvider, ProviderStatus>>;
  /** Forces the server to re-probe each key, then refreshes serverProviders. */
  onRevalidate?: () => Promise<void> | void;
}

/**
 * AI configuration panel.
 *
 * Picks a provider and a text model. Keys live server-side (OPENAI_API_KEY,
 * ANTHROPIC_API_KEY, GEMINI_API_KEY) and are validated at boot — the panel
 * surfaces per-provider state so the user can see at a glance whether each
 * provider is ready, missing a key, or has an invalid key.
 *
 * Three states per provider:
 *   - ok: key is set and a startup probe passed. Show a green check.
 *   - invalid: key is set but the provider rejected it. Amber + tooltip.
 *   - unchecked/missing: key isn't configured. Greyed; clicking still
 *     selects (so the user can choose what they want and add a key later).
 */
export const AiSettingsPanel: React.FC<AiSettingsPanelProps> = ({
  isDarkMode,
  isAiEnabled,
  onToggleAiEnabled,
  aiConfig,
  onUpdateAiConfig,
  isAiBubbleMenuEnabled,
  onToggleAiBubbleMenu,
  serverProviders,
  onRevalidate,
}) => {
  const [newModelInput, setNewModelInput] = useState('');
  const [isRevalidating, setIsRevalidating] = useState(false);

  const cfg: AiConfig = aiConfig || {
    provider: 'openai',
    textModel: PROVIDERS.openai.defaultTextModel,
  };

  const provider = PROVIDERS[cfg.provider];
  const models = modelsForProvider(cfg.provider, cfg.customTextModels);
  const customForProvider = cfg.customTextModels?.[cfg.provider] || [];

  const setField = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => {
    onUpdateAiConfig({ ...cfg, [key]: value });
  };

  const setProvider = (next: AiProvider) => {
    const nextModels = modelsForProvider(next, cfg.customTextModels);
    const nextDefault = nextModels[0] || PROVIDERS[next].defaultTextModel;
    onUpdateAiConfig({ ...cfg, provider: next, textModel: nextDefault });
  };

  const handleAddModel = () => {
    const trimmed = newModelInput.trim();
    if (!trimmed) return;
    const next = addCustomModel(cfg, cfg.provider, trimmed);
    onUpdateAiConfig({ ...next, textModel: trimmed });
    setNewModelInput('');
  };

  const handleRemoveModel = (model: string) => {
    const next = removeCustomModel(cfg, cfg.provider, model);
    if (next.textModel === model) {
      next.textModel = PROVIDERS[cfg.provider].defaultTextModel;
    }
    onUpdateAiConfig(next);
  };

  const handleRevalidate = async () => {
    if (!onRevalidate) return;
    setIsRevalidating(true);
    try { await onRevalidate(); } finally { setIsRevalidating(false); }
  };

  const statusFor = (p: AiProvider): ProviderStatus | undefined => serverProviders?.[p];
  const activeStatus = statusFor(cfg.provider);

  return (
    <div className="space-y-3">
      <button
        onClick={onToggleAiEnabled}
        className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all text-sm group"
        title="Toggle the #! AI agent menu in the editor"
      >
        <div className="flex items-center gap-3">
          <Bot className="w-4 h-4" />
          <span className={cn('font-medium', isDarkMode ? 'text-white/80' : 'text-black/80')}>
            AI Agent
          </span>
        </div>
        <div className={cn(
          'w-8 h-4 rounded-full relative transition-colors duration-300',
          isAiEnabled ? 'bg-white/20' : 'bg-black/10',
        )}>
          <div className={cn(
            'absolute top-1 w-2 h-2 rounded-full transition-all duration-300',
            isAiEnabled ? 'bg-white left-5' : 'bg-black left-1',
          )} />
        </div>
      </button>

      {isAiEnabled && (
        <div className="px-4 space-y-4 pt-1">
          {/* Provider */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30">Provider</label>
              {onRevalidate && (
                <button
                  onClick={handleRevalidate}
                  disabled={isRevalidating}
                  className="text-[9px] uppercase tracking-widest font-bold opacity-40 hover:opacity-100 flex items-center gap-1 transition-opacity"
                  title="Re-check provider keys against their APIs"
                >
                  <RefreshCw className={cn('w-2.5 h-2.5', isRevalidating && 'animate-spin')} />
                  Re-check
                </button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(Object.values(PROVIDERS) as typeof provider[]).map((p) => {
                const st = statusFor(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => setProvider(p.id)}
                    className={cn(
                      'px-2 py-2 rounded-lg text-xs font-medium transition-all border min-w-0',
                      cfg.provider === p.id
                        ? (isDarkMode ? 'bg-white/10 border-white/20 text-white' : 'bg-black/5 border-black/10 text-black')
                        : 'border-transparent opacity-50 hover:opacity-100',
                    )}
                    title={statusLabel(st)}
                  >
                    <div className="flex items-center justify-center gap-1">
                      <span className="truncate">{p.name}</span>
                      {st?.state === 'ok' && <Check className="w-3 h-3 text-emerald-500/80 shrink-0" />}
                      {st?.configured && st.state !== 'ok' && st.state !== 'unchecked' && (
                        <AlertCircle className="w-3 h-3 text-amber-500/80 shrink-0" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Per-provider status detail for the *active* provider. */}
            {activeStatus && (
              <ProviderStatusLine
                provider={cfg.provider}
                status={activeStatus}
              />
            )}
          </div>

          {/* Active model */}
          <div>
            <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Active Model</label>
            <select
              value={cfg.textModel}
              onChange={(e) => setField('textModel', e.target.value)}
              className={cn(
                'w-full px-4 py-2.5 rounded-xl text-xs font-mono bg-black/[0.03] dark:bg-white/[0.08] border border-black/12 dark:border-white/15 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all appearance-none',
                isDarkMode ? 'text-white' : 'text-black',
              )}
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {/* Limits */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Input Context</label>
              <div className="relative">
                <input
                  type="number"
                  value={cfg.contextLimit || 10000}
                  onChange={(e) => setField('contextLimit', parseInt(e.target.value, 10))}
                  className={cn(
                    'w-full px-3 py-2 rounded-lg text-xs font-mono bg-black/[0.03] dark:bg-white/[0.08] border border-black/12 dark:border-white/15 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all',
                    isDarkMode ? 'text-white' : 'text-black',
                  )}
                />
                <span className="absolute right-3 top-2 text-[8px] opacity-20 font-bold uppercase">Chars</span>
              </div>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Output Limit</label>
              <div className="relative">
                <input
                  type="number"
                  value={cfg.maxOutputTokens || 2048}
                  onChange={(e) => setField('maxOutputTokens', parseInt(e.target.value, 10))}
                  className={cn(
                    'w-full px-3 py-2 rounded-lg text-xs font-mono bg-black/[0.03] dark:bg-white/[0.08] border border-black/12 dark:border-white/15 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all',
                    isDarkMode ? 'text-white' : 'text-black',
                  )}
                />
                <span className="absolute right-3 top-2 text-[8px] opacity-20 font-bold uppercase">Tokens</span>
              </div>
            </div>
          </div>

          {/* Custom models */}
          <div>
            <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Add Your Own Model</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={newModelInput}
                onChange={(e) => setNewModelInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddModel(); } }}
                placeholder={placeholderFor(cfg.provider)}
                className={cn(
                  'flex-1 px-3 py-2 rounded-lg text-xs font-mono bg-black/[0.03] dark:bg-white/[0.08] border border-black/12 dark:border-white/15 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all',
                  isDarkMode ? 'text-white' : 'text-black',
                )}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                onClick={handleAddModel}
                disabled={!newModelInput.trim()}
                className={cn(
                  'flex items-center justify-center px-3 rounded-lg transition-all',
                  newModelInput.trim()
                    ? (isDarkMode ? 'bg-white/10 hover:bg-white/20 text-white' : 'bg-black/10 hover:bg-black/20 text-black')
                    : 'opacity-30 cursor-not-allowed',
                )}
                title="Add this model to the dropdown"
                type="button"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>

            {customForProvider.length > 0 && (
              <div className="mt-2 space-y-1">
                <p className="text-[9px] uppercase tracking-widest opacity-30 px-1">Your models</p>
                <div className="flex flex-wrap gap-1.5">
                  {customForProvider.map((m) => (
                    <span
                      key={m}
                      className={cn(
                        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono border',
                        isDarkMode ? 'border-white/10 bg-white/5' : 'border-black/10 bg-black/[0.03]',
                      )}
                    >
                      <span>{m}</span>
                      <button
                        onClick={() => handleRemoveModel(m)}
                        className="opacity-40 hover:opacity-100 transition-opacity"
                        title="Remove this model"
                        type="button"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <p className="text-[9px] opacity-30 mt-2 leading-relaxed">
              Type a model ID exactly as the provider lists it. {provider.name} validates the name when you run an AI command.
            </p>
          </div>

          {/* Bubble-menu toggle */}
          <button
            onClick={onToggleAiBubbleMenu}
            className="w-full flex items-center justify-between py-2 transition-all text-sm group"
            title="Show AI Listen / Review buttons in the selection toolbar"
            type="button"
          >
            <div className="flex items-center gap-3">
              <Sparkles className="w-3.5 h-3.5" />
              <span className={cn('text-xs', isDarkMode ? 'text-white/70' : 'text-black/70')}>
                AI in selection menu
              </span>
            </div>
            <div className={cn(
              'w-8 h-4 rounded-full relative transition-colors duration-300',
              isAiBubbleMenuEnabled ? 'bg-white/20' : 'bg-black/10',
            )}>
              <div className={cn(
                'absolute top-1 w-2 h-2 rounded-full transition-all duration-300',
                isAiBubbleMenuEnabled ? 'bg-white left-5' : 'bg-black left-1',
              )} />
            </div>
          </button>
        </div>
      )}
    </div>
  );
};

interface ProviderStatusLineProps {
  provider: AiProvider;
  status: ProviderStatus;
}

const ProviderStatusLine: React.FC<ProviderStatusLineProps> = ({ provider, status }) => {
  const env = PROVIDERS[provider].envVar;
  if (!status.configured) {
    return (
      <p className="text-[10px] text-amber-500/80 mt-2 leading-relaxed flex items-start gap-1.5">
        <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
        <span>
          Server has no key for {PROVIDERS[provider].name}. Set{' '}
          <code className="font-mono text-[9px] bg-amber-500/10 px-1 rounded">{env}</code>
          {' '}and restart.
        </span>
      </p>
    );
  }
  if (status.state === 'invalid') {
    return (
      <p className="text-[10px] text-red-500/80 mt-2 leading-relaxed flex items-start gap-1.5">
        <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
        <span>
          {PROVIDERS[provider].name} rejected the key. Check{' '}
          <code className="font-mono text-[9px] bg-red-500/10 px-1 rounded">{env}</code>
          {status.message ? ` (${status.message})` : ''}.
        </span>
      </p>
    );
  }
  if (status.state === 'error') {
    return (
      <p className="text-[10px] text-amber-500/80 mt-2 leading-relaxed flex items-start gap-1.5">
        <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
        <span>
          Couldn't reach {PROVIDERS[provider].name} at boot: {status.message || 'network error'}.
        </span>
      </p>
    );
  }
  if (status.state === 'ok') {
    return (
      <p className="text-[10px] text-emerald-500/70 mt-2 leading-relaxed flex items-center gap-1.5">
        <Check className="w-3 h-3 shrink-0" />
        <span>Key valid. Last checked {formatCheckedAt(status.checkedAt)}.</span>
      </p>
    );
  }
  return null;
};

function statusLabel(s?: ProviderStatus): string | undefined {
  if (!s) return undefined;
  if (!s.configured) return 'No key configured';
  if (s.state === 'ok') return 'Key valid';
  if (s.state === 'invalid') return s.message || 'Key invalid';
  if (s.state === 'error') return s.message || 'Couldn\'t validate';
  return undefined;
}

function placeholderFor(p: AiProvider): string {
  if (p === 'openai') return 'e.g. gpt-5-preview';
  if (p === 'anthropic') return 'e.g. claude-future-1';
  return 'e.g. gemini-3.0';
}

function formatCheckedAt(t: number | null): string {
  if (!t) return 'just now';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}
