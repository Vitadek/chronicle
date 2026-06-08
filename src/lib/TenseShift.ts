// TipTap extension that paints the local tense-shift detector (lib/tense/detect)
// as inline squiggles in the editor, following the same decoration-plugin idiom
// as lib/Autocomplete.ts.
//
// Analysis is the expensive part (a POS pass per paragraph), so it runs on a
// debounce off the editing path: between recomputes the existing decorations are
// mapped through transactions so they track edits, then a fresh pass replaces
// them. Results are also mirrored into storage + an onShifts callback so a
// native/sidebar list can render the same findings.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorState } from '@tiptap/pm/state';
import { analyzeParagraph, loadTenseEngine, type ParagraphAnalysis, type Tense } from './tense/detect';
import { buildPosMap } from './proseMirrorText';

export interface TenseShiftHit {
  from: number;
  to: number;
  tense: Tense;
  expected: Tense;
  text: string;
}

export interface TenseShiftOptions {
  enabled: boolean;
  debounceMs: number;
  /** Skip paragraphs shorter than this many characters (too little to judge). */
  minChars: number;
  /** Called with the full set of hits after each recompute. */
  onShifts?: (hits: TenseShiftHit[]) => void;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tenseShift: {
      /** Turn the tense-shift checker on/off and recompute immediately. */
      setTenseCheck: (enabled: boolean) => ReturnType;
    };
  }
}

const tenseShiftKey = new PluginKey<DecorationSet>('tenseShift');

// Paragraph text rarely changes between recomputes, and the POS pass dominates
// cost, so memoize analysis by exact text. Bounded to avoid unbounded growth.
const analysisCache = new Map<string, ParagraphAnalysis>();
function analyze(text: string): ParagraphAnalysis {
  const cached = analysisCache.get(text);
  if (cached) return cached;
  const result = analyzeParagraph(text);
  if (analysisCache.size > 500) analysisCache.clear();
  analysisCache.set(text, result);
  return result;
}

function compute(
  state: EditorState,
  opts: TenseShiftOptions,
): { decorations: DecorationSet; hits: TenseShiftHit[] } {
  const decos: Decoration[] = [];
  const hits: TenseShiftHit[] = [];

  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return;
    const { text, posAt } = buildPosMap(node, pos + 1);
    if (text.trim().length < opts.minChars) return false;

    const analysis = analyze(text);
    for (const sh of analysis.shifts) {
      const from = posAt[sh.start];
      const to = posAt[Math.min(sh.end, posAt.length - 1)];
      if (from == null || to == null || to <= from) continue;
      decos.push(
        Decoration.inline(
          from,
          to,
          { class: 'tense-shift' },
          { tense: sh.tense, expected: sh.expected },
        ),
      );
      hits.push({ from, to, tense: sh.tense, expected: sh.expected, text: sh.text.trim() });
    }
    return false; // don't descend into the paragraph's inline content
  });

  return { decorations: DecorationSet.create(state.doc, decos), hits };
}

export const TenseShift = Extension.create<TenseShiftOptions>({
  name: 'tenseShift',

  addOptions() {
    return {
      enabled: false,
      debounceMs: 600,
      minChars: 12,
      onShifts: undefined,
    };
  },

  addStorage() {
    return {
      enabled: false,
      hits: [] as TenseShiftHit[],
    };
  },

  addCommands() {
    return {
      // Flip the flag and wake the plugin with a no-op transaction; the plugin's
      // view reacts to the enabled-change (lazy-loading the engine if needed).
      setTenseCheck:
        (enabled: boolean) =>
        ({ state, dispatch }) => {
          this.storage.enabled = enabled;
          if (dispatch) dispatch(state.tr);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const ext = this;
    // Seed storage from the configured default so the initial pass is gated.
    ext.storage.enabled = ext.options.enabled;
    let timer: ReturnType<typeof setTimeout> | null = null;

    return [
      new Plugin<DecorationSet>({
        key: tenseShiftKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(tenseShiftKey) as DecorationSet | undefined;
            if (meta) return meta;
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return tenseShiftKey.getState(state);
          },
        },
        view(view) {
          let prevEnabled = ext.storage.enabled;

          const schedule = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(async () => {
              timer = null;
              if (!ext.storage.enabled) return;
              await loadTenseEngine(); // no-op after the first call
              if (!ext.storage.enabled || view.isDestroyed) return;
              const { decorations, hits } = compute(view.state, ext.options);
              ext.storage.hits = hits;
              ext.options.onShifts?.(hits);
              view.dispatch(view.state.tr.setMeta(tenseShiftKey, decorations));
            }, ext.options.debounceMs);
          };

          const clear = () => {
            if (timer) clearTimeout(timer);
            timer = null;
            ext.storage.hits = [];
            ext.options.onShifts?.([]);
            view.dispatch(view.state.tr.setMeta(tenseShiftKey, DecorationSet.empty));
          };

          if (ext.storage.enabled) schedule();
          return {
            update(updatedView, prevState) {
              const enabledChanged = ext.storage.enabled !== prevEnabled;
              prevEnabled = ext.storage.enabled;
              if (ext.storage.enabled) {
                if (enabledChanged || !prevState.doc.eq(updatedView.state.doc)) schedule();
              } else if (enabledChanged) {
                clear();
              }
            },
            destroy() {
              if (timer) clearTimeout(timer);
            },
          };
        },
      }),
    ];
  },
});
