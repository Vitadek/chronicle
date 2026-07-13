import React from 'react';

interface Props {
  /** Which plugin's contribution this wraps — used in the error report. */
  pluginId: string;
  /** Told when this plugin throws, so the host can mark it failed in Settings. */
  onError: (pluginId: string, message: string) => void;
  children: React.ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * Contains a misbehaving plugin. In v1 anything a plugin threw during render
 * took the whole app down with it (no boundary anywhere); now the plugin's own
 * UI disappears, the error is reported to the host (surfaced in Settings), and
 * Chronicle keeps running.
 */
export class PluginBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(this.props.pluginId, error.message || String(error));
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}
