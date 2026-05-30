import { Editor } from '@tiptap/react';
import { AiConfig } from '../services/aiConfig';

/**
 * The runtime context provided to every active plugin instance.
 */
export interface PluginContext {
  /** The active TipTap editor instance. */
  editor: Editor;
  /** The ID of the manuscript currently being edited. */
  manuscriptId: string;
  /** The user's AI configuration (provider, model, etc.) */
  aiConfig: AiConfig | null;
  /** Arbitrary JSON-serializable state for this plugin instance. */
  state: any;
  /** Persists state changes to the backend sync engine. */
  updateState: (newState: any) => void;
  /** Allows plugins to programmatically invoke CommandPortal (#!) commands. */
  invokePortalCommand: (command: string, args: string[]) => Promise<any>;
}

/**
 * The structural definition of a Chronicle plugin.
 */
export interface ChroniclePlugin {
  /** Unique identifier (e.g., "chronicle.chibi.assistant"). */
  id: string;
  /** Human-readable name shown in the Settings menu. */
  name: string;
  /** Short description of what the plugin does. */
  description: string;
  /** The initial state used when the plugin is first enabled. */
  defaultState: any;
  
  /** 
   * The React component that renders the plugin's UI.
   * Receives the PluginContext as props.
   */
  component: React.ComponentType<PluginContext>;
  
  /** 
   * Custom command interceptors for the CommandPortal (#!) or CLI.
   * Maps command names (e.g., "chibi_rename") to handler functions.
   */
  portalCommands?: {
    [name: string]: (context: PluginContext, args: string[]) => void | Promise<void>;
  };
  
  /** 
   * Optional hook triggered on every editor transaction.
   * Useful for tracking metrics like word count velocity.
   */
  onEditorTransaction?: (context: PluginContext) => void;
}
