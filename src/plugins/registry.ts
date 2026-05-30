import { ChroniclePlugin } from './types';
import { ChibiCompanion } from './chibi/ChibiCompanion';

/**
 * Global registry of all available plugins in the system.
 * Add new plugin manifests here to make them available in the Settings menu.
 */
export const PLUGIN_REGISTRY: ChroniclePlugin[] = [
  {
    id: 'chronicle.chibi.assistant',
    name: 'Chibi Assistant',
    description: 'Pixel-art workspace interaction avatar companion.',
    defaultState: { petName: 'ChronicleBot', totalInteractions: 0 },
    component: ChibiCompanion,
    portalCommands: {
      chibi_rename: async (context, args) => {
        const newName = args.join(' ');
        if (!newName) return;
        context.updateState({ ...context.state, petName: newName });
      }
    }
  }
];

/**
 * Finds a plugin manifest by its unique ID.
 */
export function getPluginManifest(id: string): ChroniclePlugin | undefined {
  return PLUGIN_REGISTRY.find(p => p.id === id);
}
