import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { Editor } from '@tiptap/react';
import { PluginStateRecord } from '../types';
import { ChroniclePlugin, PluginContext } from './types';
import { PLUGIN_REGISTRY } from './registry';
import { pluginService } from '../services/pluginService';
import { pluginExternalService } from '../services/pluginExternalService';

interface PluginManagerContextType {
  enabledPlugins: Set<string>;
  allPlugins: ChroniclePlugin[];
  togglePlugin: (pluginId: string, manuscriptId?: string | null) => Promise<void>;
  updatePluginState: (pluginId: string, newState: any) => Promise<void>;
  getPluginContext: (pluginId: string, editor: Editor, manuscriptId: string) => PluginContext;
  isLoading: boolean;
  refreshPlugins: () => Promise<void>;
}

const PluginManagerContext = createContext<PluginManagerContextType | null>(null);

export const usePlugins = () => {
  const context = useContext(PluginManagerContext);
  if (!context) throw new Error('usePlugins must be used within PluginProvider');
  return context;
};

export const PluginProvider: React.FC<{ children: React.ReactNode; syncSignal?: number }> = ({ children, syncSignal }) => {
  const [pluginRecords, setPluginRecords] = useState<PluginStateRecord[]>([]);
  const [dynamicPlugins, setDynamicPlugins] = useState<ChroniclePlugin[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const allPlugins = useMemo(() => {
    return [...PLUGIN_REGISTRY, ...dynamicPlugins];
  }, [dynamicPlugins]);

  const loadPlugins = useCallback(async () => {
    try {
      const [records, externalManifests] = await Promise.all([
        pluginService.list(),
        pluginExternalService.list()
      ]);

      setPluginRecords(records);

      // Dynamically load external plugin modules
      const loaded: ChroniclePlugin[] = [];
      for (const manifest of externalManifests) {
        try {
          // @vite-ignore used to tell Vite not to try to bundle this at compile time
          const moduleUrl = `/plugins-raw/${manifest.dir}/${manifest.entry}`;
          const module = await import(/* @vite-ignore */ moduleUrl);
          
          loaded.push({
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            defaultState: manifest.defaultState || {},
            component: module.default || module.component,
            portalCommands: module.portalCommands,
            onEditorTransaction: module.onEditorTransaction
          });
        } catch (e) {
          console.error(`Failed to load external plugin ${manifest.id}:`, e);
        }
      }
      setDynamicPlugins(loaded);
    } catch (error) {
      console.error('Failed to load plugins:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins, syncSignal]);

  const enabledPlugins = useMemo(() => {
    return new Set(pluginRecords.filter(r => r.enabled).map(r => r.pluginId));
  }, [pluginRecords]);

  const togglePlugin = useCallback(async (pluginId: string, manuscriptId: string | null = null) => {
    const existing = pluginRecords.find(r => r.pluginId === pluginId && r.manuscriptId === manuscriptId);
    const id = existing?.id || `plugin_${pluginId}_${manuscriptId || 'global'}`;
    const enabled = !existing?.enabled;
    
    const manifest = allPlugins.find(p => p.id === pluginId);
    const state = existing?.state || JSON.stringify(manifest?.defaultState || {});

    const update: Partial<PluginStateRecord> = {
      pluginId,
      manuscriptId,
      enabled,
      state,
      lastModified: Date.now()
    };

    setPluginRecords(prev => {
      const other = prev.filter(r => r.id !== id);
      return [...other, { id, ...update, enabled: !!enabled, state: state as string, lastModified: update.lastModified! } as PluginStateRecord];
    });

    try {
      await pluginService.update(id, update);
    } catch (error) {
      console.error('Failed to toggle plugin:', error);
      loadPlugins();
    }
  }, [pluginRecords, allPlugins, loadPlugins]);

  const updatePluginState = useCallback(async (pluginId: string, newState: any) => {
    const manuscriptId = null; 
    const existing = pluginRecords.find(r => r.pluginId === pluginId && r.manuscriptId === manuscriptId);
    if (!existing) return;

    const id = existing.id;
    const stateStr = JSON.stringify(newState);
    const lastModified = Date.now();

    setPluginRecords(prev => prev.map(r => r.id === id ? { ...r, state: stateStr, lastModified } : r));

    try {
      await pluginService.update(id, { state: stateStr, lastModified });
    } catch (error) {
      console.error('Failed to update plugin state:', error);
      loadPlugins();
    }
  }, [pluginRecords, loadPlugins]);

  const getPluginContext = useCallback((pluginId: string, editor: Editor, manuscriptId: string): PluginContext => {
    const record = pluginRecords.find(r => r.pluginId === pluginId);
    const state = record ? JSON.parse(record.state) : {};

    return {
      editor,
      manuscriptId,
      state,
      updateState: (nextState: any) => updatePluginState(pluginId, nextState),
      invokePortalCommand: async (command, args) => {
        // This can be used by plugins to trigger other commands
        console.log('Invoke plugin command:', command, args);
      }
    };
  }, [pluginRecords, updatePluginState]);

  const value = useMemo(() => ({
    enabledPlugins,
    allPlugins,
    togglePlugin,
    updatePluginState,
    getPluginContext,
    isLoading,
    refreshPlugins: loadPlugins
  }), [enabledPlugins, allPlugins, togglePlugin, updatePluginState, getPluginContext, isLoading, loadPlugins]);

  return (
    <PluginManagerContext.Provider value={value}>
      {children}
    </PluginManagerContext.Provider>
  );
};

export const ActivePluginHost: React.FC<{ editor: Editor; manuscriptId: string }> = ({ editor, manuscriptId }) => {
  const { enabledPlugins, allPlugins, getPluginContext } = usePlugins();

  return (
    <>
      {Array.from(enabledPlugins).map(pluginId => {
        const manifest = allPlugins.find(p => p.id === pluginId);
        if (!manifest) return null;
        
        const PluginComponent = manifest.component;
        if (!PluginComponent) return null;
        
        const context = getPluginContext(pluginId, editor, manuscriptId);
        return <PluginComponent key={pluginId} {...context} />;
      })}
    </>
  );
};
