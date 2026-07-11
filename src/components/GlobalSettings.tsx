import React from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, User, Settings, Moon, Sun, Shield, Sparkles, Box, Upload, Trash2, Loader2, Download, Check } from 'lucide-react';
import { cn } from '../lib/utils';
import { UserProfile, ExportSettings, HtmlExportTheme, EpubCoverSource } from '../types';
import { AiConfig, AiProvider } from '../services/aiConfig';
import { ProviderStatus } from '../services/aiService';
import { AiSettingsPanel } from './AiSettingsPanel';
import { usePlugins } from '../plugins/PluginManager';
import { pluginExternalService } from '../services/pluginExternalService';
import { MarkdownFrontMatterFields } from './MarkdownFrontMatterFields';

interface GlobalSettingsProps {
  onClose: () => void;
  isDarkMode: boolean;
  onToggleTheme: () => void;
  userProfile: UserProfile;
  onUpdateUserProfile: (profile: Partial<UserProfile>) => void;
  isAiEnabled: boolean;
  onToggleAiEnabled: () => void;
  aiConfig: AiConfig | null;
  onUpdateAiConfig: (cfg: AiConfig | null) => void;
  serverAiProviders?: Partial<Record<AiProvider, ProviderStatus>>;
  onRevalidateAi?: () => Promise<void> | void;
  exportSettings: ExportSettings;
  onUpdateExportSettings: (settings: ExportSettings) => void;
}

export function GlobalSettings({
  onClose,
  isDarkMode,
  onToggleTheme,
  userProfile,
  onUpdateUserProfile,
  isAiEnabled,
  onToggleAiEnabled,
  aiConfig,
  onUpdateAiConfig,
  serverAiProviders,
  onRevalidateAi,
  exportSettings,
  onUpdateExportSettings,
}: GlobalSettingsProps) {
  const { enabledPlugins, allPlugins, togglePlugin, refreshPlugins } = usePlugins();
  const [isInstalling, setIsInstalling] = React.useState(false);
  const [installError, setInstallError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Section-scoped updaters keep the nested export-settings edits terse.
  const updateHtml = (patch: Partial<ExportSettings['html']>) =>
    onUpdateExportSettings({ ...exportSettings, html: { ...exportSettings.html, ...patch } });
  const updateMarkdown = (patch: Partial<ExportSettings['markdown']>) =>
    onUpdateExportSettings({ ...exportSettings, markdown: { ...exportSettings.markdown, ...patch } });
  const updateEpub = (patch: Partial<ExportSettings['epub']>) =>
    onUpdateExportSettings({ ...exportSettings, epub: { ...exportSettings.epub, ...patch } });

  const handleUploadPlugin = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsInstalling(true);
    setInstallError(null);
    try {
      await pluginExternalService.install(file);
      await refreshPlugins();
      // Reset input
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err: any) {
      setInstallError(err.message || 'Failed to install plugin');
    } finally {
      setIsInstalling(false);
    }
  };

  const handleDeletePlugin = async (pluginId: string) => {
    if (!window.confirm(`Are you sure you want to remove the plugin "${pluginId}"?`)) return;
    try {
      await pluginExternalService.delete(pluginId);
      await refreshPlugins();
    } catch (err: any) {
      alert(`Failed to delete plugin: ${err.message}`);
    }
  };

  const inputClass = cn(
    'w-full px-4 py-3 rounded-xl text-xs bg-black/[0.03] dark:bg-white/[0.08] border border-black/5 dark:border-white/5 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all',
    isDarkMode ? 'text-white' : 'text-black',
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={cn(
        'min-h-screen-dvh w-full overflow-y-auto',
        isDarkMode ? 'bg-manuscript-dark text-white/40' : 'bg-manuscript-light text-black/40',
      )}
    >
      <div className="max-w-3xl mx-auto px-6 sm:px-10 py-10 sm:py-16">
        {/* Page header */}
        <div className="flex items-center justify-between mb-14">
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="p-2 -ml-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              title="Back to library"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <Settings className={cn('w-5 h-5', isDarkMode ? 'text-white/20' : 'text-black/20')} />
            <h2 className={cn('text-xl font-bold uppercase tracking-widest', isDarkMode ? 'text-white' : 'text-black')}>
              Settings
            </h2>
          </div>
          <button
            onClick={onClose}
            className={cn(
              'px-4 py-2 rounded-xl text-[10px] uppercase font-black tracking-widest transition-all',
              isDarkMode ? 'bg-white/10 hover:bg-white/20 text-white' : 'bg-black/5 hover:bg-black/10 text-black',
            )}
          >
            Done
          </button>
        </div>

        <div className="space-y-14">
          {/* Plugins Section */}
          <section className="space-y-6">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">
                <Box className="w-3 h-3" />
                <span>Workstation Plugins</span>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleUploadPlugin}
                  accept=".zip"
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isInstalling}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[9px] uppercase font-black tracking-widest transition-all',
                    isDarkMode ? 'bg-white/10 hover:bg-white/20 text-white' : 'bg-black/5 hover:bg-black/10 text-black',
                    isInstalling && 'opacity-50 cursor-wait',
                  )}
                >
                  {isInstalling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                  Install
                </button>
              </div>
            </div>

            {installError && (
              <p className="px-4 py-2 bg-red-500/10 text-red-500 text-[10px] rounded-xl border border-red-500/20 leading-relaxed mx-1">
                {installError}
              </p>
            )}

            <div className="space-y-3">
              {allPlugins.length === 0 && (
                <p className="text-[10px] opacity-30 italic px-4">No plugins available.</p>
              )}
              {allPlugins.map((plugin) => {
                const isEnabled = enabledPlugins.has(plugin.id);
                const isExternal = !['chronicle.chibi.assistant'].includes(plugin.id);

                return (
                  <div
                    key={plugin.id}
                    className={cn(
                      'px-4 py-4 rounded-2xl border transition-all flex items-start gap-4 group/item',
                      isEnabled
                        ? 'bg-blue-500/5 border-blue-500/10'
                        : 'bg-black/5 dark:bg-white/5 border-transparent opacity-60',
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <h4 className={cn('text-xs font-bold mb-1', isDarkMode ? 'text-white' : 'text-black')}>
                        {plugin.name}
                      </h4>
                      <p className="text-[10px] leading-relaxed opacity-40">{plugin.description}</p>
                    </div>

                    <div className="flex flex-col gap-2 items-end">
                      <button
                        onClick={() => togglePlugin(plugin.id)}
                        className={cn(
                          'px-3 py-1.5 rounded-lg text-[9px] uppercase font-black tracking-widest transition-all',
                          isEnabled
                            ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/20'
                            : 'bg-black/10 dark:bg-white/10 opacity-40 hover:opacity-100',
                        )}
                      >
                        {isEnabled ? 'Enabled' : 'Enable'}
                      </button>

                      {isExternal && (
                        <button
                          onClick={() => handleDeletePlugin(plugin.id)}
                          className="p-1 rounded opacity-0 group-hover/item:opacity-30 hover:opacity-100 touch:opacity-50 hover:bg-red-500/10 hover:text-red-500 transition-all"
                          title="Delete plugin"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Export Defaults Section */}
          <section className="space-y-6">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">
              <Download className="w-3 h-3" />
              <span>Export Defaults</span>
            </div>
            <p className="text-[10px] leading-relaxed opacity-40 italic px-1 -mt-2">
              Applied whenever you export from a manuscript. Manuscript (.docx) always uses
              Standard Manuscript Format and ignores these.
            </p>

            {/* HTML */}
            <div className="rounded-2xl border border-black/5 dark:border-white/5 p-5 space-y-5">
              <h4 className={cn('text-xs font-bold', isDarkMode ? 'text-white' : 'text-black')}>HTML</h4>
              <div>
                <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Theme</label>
                <Segmented
                  isDarkMode={isDarkMode}
                  value={exportSettings.html.theme}
                  options={[
                    { value: 'light', label: 'Light' },
                    { value: 'sepia', label: 'Sepia' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                  onChange={(v) => updateHtml({ theme: v as HtmlExportTheme })}
                />
              </div>
              <ToggleRow
                isDarkMode={isDarkMode}
                label="Include title page"
                hint="Centered title + author before the chapters (book-wide export)."
                checked={exportSettings.html.includeTitlePage}
                onToggle={() => updateHtml({ includeTitlePage: !exportSettings.html.includeTitlePage })}
              />
            </div>

            {/* Markdown / Hugo */}
            <div className="rounded-2xl border border-black/5 dark:border-white/5 p-5 space-y-5">
              <h4 className={cn('text-xs font-bold', isDarkMode ? 'text-white' : 'text-black')}>Markdown (Hugo)</h4>
              <MarkdownFrontMatterFields
                value={exportSettings.markdown}
                onChange={updateMarkdown}
                isDarkMode={isDarkMode}
              />

              <div className="pt-2 border-t border-black/5 dark:border-white/5">
                <ToggleRow
                  isDarkMode={isDarkMode}
                  label="Edit front matter on every export"
                  hint="Show these fields in the Markdown export dialog so you can tweak them per export (defaults here stay unchanged)."
                  checked={exportSettings.markdown.promptBeforeExport}
                  onToggle={() => updateMarkdown({ promptBeforeExport: !exportSettings.markdown.promptBeforeExport })}
                />
              </div>
            </div>

            {/* EPUB */}
            <div className="rounded-2xl border border-black/5 dark:border-white/5 p-5 space-y-5">
              <h4 className={cn('text-xs font-bold', isDarkMode ? 'text-white' : 'text-black')}>EPUB</h4>
              <div>
                <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Cover source</label>
                <Segmented
                  isDarkMode={isDarkMode}
                  value={exportSettings.epub.coverSource}
                  options={[
                    { value: 'uploaded', label: 'Uploaded' },
                    { value: 'generated', label: 'Generated' },
                  ]}
                  onChange={(v) => updateEpub({ coverSource: v as EpubCoverSource })}
                />
                <p className="text-[10px] leading-relaxed opacity-40 italic mt-2">
                  {exportSettings.epub.coverSource === 'uploaded'
                    ? "Uses the manuscript's uploaded cover, falling back to a generated one if none exists."
                    : 'Always uses the generated typographic cover, even if an upload exists.'}
                </p>
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">
                  Rights / copyright text
                </label>
                <textarea
                  value={exportSettings.epub.rightsText}
                  onChange={(e) => updateEpub({ rightsText: e.target.value })}
                  placeholder="Leave blank for standard boilerplate. One paragraph per line."
                  className={cn(inputClass, 'h-28 resize-none leading-relaxed')}
                />
              </div>
            </div>
          </section>

          {/* Profile Section */}
          <section className="space-y-6">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">
              <User className="w-3 h-3" />
              <span>Author Profile</span>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Author Name</label>
                <input
                  type="text"
                  value={userProfile.name}
                  onChange={(e) => onUpdateUserProfile({ name: e.target.value })}
                  placeholder="Your pen name"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Mailing Address</label>
                <textarea
                  value={userProfile.address}
                  onChange={(e) => onUpdateUserProfile({ address: e.target.value })}
                  placeholder="For title page exports"
                  className={cn(inputClass, 'h-24 resize-none')}
                />
              </div>
            </div>
          </section>

          {/* Appearance */}
          <section className="space-y-6">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">
              <Moon className="w-3 h-3" />
              <span>Appearance</span>
            </div>
            <button
              onClick={onToggleTheme}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all text-sm group"
            >
              <div className="flex items-center gap-3">
                {isDarkMode ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                <span className={cn('font-medium', isDarkMode ? 'text-white/80' : 'text-black/80')}>
                  {isDarkMode ? 'Night Mode' : 'Day Mode'}
                </span>
              </div>
              <div
                className={cn(
                  'w-8 h-4 rounded-full relative transition-colors duration-300',
                  isDarkMode ? 'bg-white/20' : 'bg-black/10',
                )}
              >
                <div
                  className={cn(
                    'absolute top-1 w-2 h-2 rounded-full transition-all duration-300',
                    isDarkMode ? 'bg-white left-5' : 'bg-black left-1',
                  )}
                />
              </div>
            </button>
          </section>

          {/* AI Section */}
          <section className="space-y-6">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">
              <Sparkles className="w-3 h-3" />
              <span>AI Capabilities</span>
            </div>
            <AiSettingsPanel
              isDarkMode={isDarkMode}
              isAiEnabled={isAiEnabled}
              onToggleAiEnabled={onToggleAiEnabled}
              aiConfig={aiConfig}
              onUpdateAiConfig={onUpdateAiConfig}
              serverProviders={serverAiProviders}
              onRevalidate={onRevalidateAi}
            />
          </section>

          {/* Security/Sync Note */}
          <section className="pt-8 border-t border-black/5 dark:border-white/5">
            <div className="flex items-start gap-3 p-4 rounded-2xl bg-black/5 dark:bg-white/5">
              <Shield className="w-4 h-4 opacity-20 shrink-0 mt-0.5" />
              <p className="text-[10px] leading-relaxed opacity-40 italic">
                Settings and API keys are stored locally on this device. Profile information can be synced to your title pages during export.
              </p>
            </div>
          </section>
        </div>

        <div className="py-10 mt-6 border-t border-black/5 dark:border-white/5 text-center">
          <p className="text-[10px] opacity-20 uppercase tracking-widest font-bold">Chronicle Global Config</p>
        </div>
      </div>
    </motion.div>
  );
}

interface ToggleRowProps {
  isDarkMode: boolean;
  label: string;
  hint?: string;
  checked: boolean;
  onToggle: () => void;
}

/** A labelled on/off switch row, matching the Appearance toggle's visual style. */
function ToggleRow({ isDarkMode, label, hint, checked, onToggle }: ToggleRowProps) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-4 text-left group"
    >
      <div className="min-w-0">
        <div className={cn('text-xs font-medium', isDarkMode ? 'text-white/80' : 'text-black/80')}>{label}</div>
        {hint && <div className="text-[10px] leading-relaxed opacity-40 mt-0.5">{hint}</div>}
      </div>
      <div
        className={cn(
          'w-8 h-4 rounded-full relative shrink-0 transition-colors duration-300',
          checked ? 'bg-blue-500' : isDarkMode ? 'bg-white/20' : 'bg-black/10',
        )}
      >
        <div
          className={cn(
            'absolute top-1 w-2 h-2 rounded-full bg-white transition-all duration-300',
            checked ? 'left-5' : 'left-1',
          )}
        />
      </div>
    </button>
  );
}

interface SegmentedProps {
  isDarkMode: boolean;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

/** A small segmented control for mutually-exclusive choices (theme, cover). */
function Segmented({ isDarkMode, value, options, onChange }: SegmentedProps) {
  return (
    <div className="inline-flex rounded-xl p-1 bg-black/[0.04] dark:bg-white/[0.06] gap-1">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              'flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[10px] uppercase font-black tracking-widest transition-all',
              active
                ? isDarkMode
                  ? 'bg-white/15 text-white shadow'
                  : 'bg-white text-black shadow'
                : 'opacity-40 hover:opacity-80',
            )}
          >
            {active && <Check className="w-3 h-3" />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
