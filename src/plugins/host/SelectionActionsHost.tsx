import React from 'react';
import { BubbleMenu } from '@tiptap/react/menus';
import type { Editor } from '@tiptap/react';
import { usePluginHost, usePluginSlot } from './PluginHost';
import { cn } from '../../lib/utils';

/**
 * Bubble-menu actions contributed by plugins (the `selectionActions` slot — what
 * a Thesaurus plugin uses).
 *
 * Rendered as its own bubble beneath the built-in selection toolbar rather than
 * threaded into it, so a plugin can never break the core formatting bar.
 */
export const SelectionActionsHost: React.FC<{ editor: Editor | null; isDarkMode: boolean }> = ({
  editor,
  isDarkMode,
}) => {
  const actions = usePluginSlot('selectionActions');
  const { makeContext, reportError } = usePluginHost();

  if (!editor || actions.length === 0) return null;

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: 'bottom', offset: 8 }}
      shouldShow={({ state, from, to }) =>
        from !== to && state.doc.textBetween(from, to).trim().length > 0
      }
    >
      <div
        className={cn(
          'flex items-center gap-1 p-1 rounded-xl border shadow-xl',
          isDarkMode ? 'bg-[#2b2926] border-white/10 text-white' : 'bg-white border-black/10 text-black',
        )}
      >
        {actions.map(({ pluginId, item }) => (
          <button
            key={`${pluginId}:${item.id}`}
            onClick={() => {
              const { state } = editor;
              const { from, to } = state.selection;
              const text = state.doc.textBetween(from, to, ' ').trim();
              try {
                item.run(makeContext(pluginId), text);
              } catch (err) {
                reportError(pluginId, err instanceof Error ? err.message : String(err));
              }
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] uppercase font-bold tracking-widest hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            title={item.label}
          >
            {item.icon && <item.icon className="w-3.5 h-3.5" />}
            {item.label}
          </button>
        ))}
      </div>
    </BubbleMenu>
  );
};
