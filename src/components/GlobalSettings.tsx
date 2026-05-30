import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, User, Settings, Moon, Sun, Shield, Sparkles, Box, Upload, Trash2, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { UserProfile } from '../types';
import { AiConfig, AiProvider } from '../services/aiConfig';
import { ProviderStatus } from '../services/aiService';
import { AiSettingsPanel } from './AiSettingsPanel';
import { usePlugins } from '../plugins/PluginManager';
import { pluginExternalService } from '../services/pluginExternalService';

interface GlobalSettingsProps {
  isOpen: boolean;
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
}

export function GlobalSettings({
  isOpen,
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
}: GlobalSettingsProps) {
  const { enabledPlugins, allPlugins, togglePlugin, refreshPlugins } = usePlugins();
  const [isInstalling, setIsInstalling] = React.useState(false);
  const [installError, setInstallError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

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

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/40 backdrop-blur-md z-[100]"
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className={cn(
              "fixed inset-y-0 right-0 w-full sm:w-[400px] z-[101] shadow-2xl flex flex-col p-8 sm:p-12 overflow-hidden",
              isDarkMode ? "bg-manuscript-dark text-white/40" : "bg-manuscript-light text-black/40"
            )}
          >
            <div className="flex items-center justify-between mb-12">
              <div className="flex items-center gap-3">
                <Settings className={cn("w-5 h-5", isDarkMode ? "text-white/20" : "text-black/20")} />
                <h2 className={cn("text-xl font-bold uppercase tracking-widest", isDarkMode ? "text-white" : "text-black")}>
                  Settings
                </h2>
              </div>
              <button 
                onClick={onClose}
                className="p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-12 pr-2 custom-scrollbar">
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
                        "flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[9px] uppercase font-black tracking-widest transition-all",
                        isDarkMode ? "bg-white/10 hover:bg-white/20 text-white" : "bg-black/5 hover:bg-black/10 text-black",
                        isInstalling && "opacity-50 cursor-wait"
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
                  {allPlugins.map(plugin => {
                    const isEnabled = enabledPlugins.has(plugin.id);
                    const isExternal = !['chronicle.chibi.assistant'].includes(plugin.id);

                    return (
                      <div 
                        key={plugin.id}
                        className={cn(
                          "px-4 py-4 rounded-2xl border transition-all flex items-start gap-4 group/item",
                          isEnabled 
                            ? "bg-blue-500/5 border-blue-500/10" 
                            : "bg-black/5 dark:bg-white/5 border-transparent opacity-60"
                        )}
                      >
                        <div className="flex-1 min-w-0">
                          <h4 className={cn("text-xs font-bold mb-1", isDarkMode ? "text-white" : "text-black")}>
                            {plugin.name}
                          </h4>
                          <p className="text-[10px] leading-relaxed opacity-40">
                            {plugin.description}
                          </p>
                        </div>
                        
                        <div className="flex flex-col gap-2 items-end">
                          <button 
                            onClick={() => togglePlugin(plugin.id)}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-[9px] uppercase font-black tracking-widest transition-all",
                              isEnabled 
                                ? "bg-blue-500 text-white shadow-lg shadow-blue-500/20" 
                                : "bg-black/10 dark:bg-white/10 opacity-40 hover:opacity-100"
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
                      className={cn(
                        "w-full px-4 py-3 rounded-xl text-xs bg-black/[0.03] dark:bg-white/[0.08] border border-black/5 dark:border-white/5 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all",
                        isDarkMode ? "text-white" : "text-black"
                      )}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2">Mailing Address</label>
                    <textarea 
                      value={userProfile.address}
                      onChange={(e) => onUpdateUserProfile({ address: e.target.value })}
                      placeholder="For title page exports"
                      className={cn(
                        "w-full h-24 px-4 py-3 rounded-xl text-xs bg-black/[0.03] dark:bg-white/[0.08] border border-black/5 dark:border-white/5 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all resize-none",
                        isDarkMode ? "text-white" : "text-black"
                      )}
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
                    <span className={cn("font-medium", isDarkMode ? "text-white/80" : "text-black/80")}>
                      {isDarkMode ? 'Night Mode' : 'Day Mode'}
                    </span>
                  </div>
                  <div className={cn(
                    "w-8 h-4 rounded-full relative transition-colors duration-300",
                    isDarkMode ? "bg-white/20" : "bg-black/10"
                  )}>
                    <div className={cn(
                      "absolute top-1 w-2 h-2 rounded-full transition-all duration-300",
                      isDarkMode ? "bg-white left-5" : "bg-black left-1"
                    )} />
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

            <div className="py-8 mt-auto border-t border-black/5 dark:border-white/5 text-center">
              <p className="text-[10px] opacity-20 uppercase tracking-widest font-bold">
                Chronicle Global Config
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
