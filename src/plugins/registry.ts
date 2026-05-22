import { ChroniclePlugin } from './types';

/**
 * Global registry of all available plugins in the system.
 * Add new plugin manifests here to make them available in the Settings menu.
 */
export const PLUGIN_REGISTRY: ChroniclePlugin[] = [
  // Registry is empty by default for a clean ship.
  // Add plugins like ChibiCompanion here when desired.
];

/**
 * Finds a plugin manifest by its unique ID.
 */
export function getPluginManifest(id: string): ChroniclePlugin | undefined {
  return PLUGIN_REGISTRY.find(p => p.id === id);
}
