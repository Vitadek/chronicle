// TipTap extension that paints LanguageTool's grammar/style lints as inline
// squiggles, following the same debounced async-lint idiom as lib/TenseShift.ts.
//
// Linting is async (it crosses the network to the server's LanguageTool proxy),
// so the work runs off a debounce and the result is only applied if the document
// hasn't changed underneath it. Errors (spelling/grammar/typographical) get a
// red squiggle; stylistic/advisory notes get blue.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorState } from '@tiptap/pm/state';
import { buildPosMap } from './proseMirrorText';
import { lintText, loadGrammarEngine, type GrammarHit } from './grammar/languagetool';

export interface GrammarMark {
  from: number;
  to: number;
  kind: string;
  message: string;
  text: string;
}

export interface GrammarOptions {
  enabled: boolean;
  debounceMs: number;
  /** Skip paragraphs shorter than this many characters. */
  minChars: number;
  /** Called with the full set of marks after each recompute. */
  onMarks?: (marks: GrammarMark[]) => void;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    grammar: {
      /** Turn the grammar checker on/off and recompute (lazy-loads the engine). */
      setGrammarCheck: (enabled: boolean) => ReturnType;
    };
  }
}

const grammarKey = new PluginKey<DecorationSet>('grammar');

// Outright errors read red; stylistic/advisory notes read blue. LanguageTool
// issue types: misspelling | grammar | typographical | style | uncategorized | …
const ERROR_KINDS = new Set(['misspelling', 'grammar', 'typographical', 'whitespace']);
function classFor(kind: string): string {
  return ERROR_KINDS.has(kind) ? 'grammar-lint grammar-error' : 'grammar-lint grammar-style';
}

// Paragraph text rarely changes between recomputes and a lint round-trips a
// worker, so memoize by exact text. Bounded to avoid unbounded growth.
const lintCache = new Map<string, GrammarHit[]>();
async function lintCached(text: string): Promise<GrammarHit[]> {
  const cached = lintCache.get(text);
  if (cached) return cached;
  const hits = await lintText(text);
  if (lintCache.size > 500) lintCache.clear();
  lintCache.set(text, hits);
  return hits;
}

async function compute(
  state: EditorState,
  opts: GrammarOptions,
): Promise<{ decorations: DecorationSet; marks: GrammarMark[] }> {
  // Collect paragraph text + position maps up front (sync), then lint (async).
  const paras: { text: string; posAt: number[] }[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return;
    const { text, posAt } = buildPosMap(node, pos + 1);
    if (text.trim().length >= opts.minChars) paras.push({ text, posAt });
    return false;
  });

  const decos: Decoration[] = [];
  const marks: GrammarMark[] = [];
  for (const p of paras) {
    const lints = await lintCached(p.text);
    for (const ln of lints) {
      const from = p.posAt[ln.start];
      const to = p.posAt[Math.min(ln.end, p.posAt.length - 1)];
      if (from == null || to == null || to <= from) continue;
      decos.push(
        Decoration.inline(from, to, { class: classFor(ln.kind), title: ln.message }, { kind: ln.kind }),
      );
      marks.push({ from, to, kind: ln.kind, message: ln.message, text: p.text.slice(ln.start, ln.end) });
    }
  }

  return { decorations: DecorationSet.create(state.doc, decos), marks };
}

export const Grammar = Extension.create<GrammarOptions>({
  name: 'grammar',

  addOptions() {
    return {
      enabled: false,
      debounceMs: 800,
      minChars: 12,
      onMarks: undefined,
    };
  },

  addStorage() {
    return {
      enabled: false,
      marks: [] as GrammarMark[],
    };
  },

  addCommands() {
    return {
      setGrammarCheck:
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
    ext.storage.enabled = ext.options.enabled;
    let timer: ReturnType<typeof setTimeout> | null = null;

    return [
      new Plugin<DecorationSet>({
        key: grammarKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(grammarKey) as DecorationSet | undefined;
            if (meta) return meta;
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return grammarKey.getState(state);
          },
        },
        view(view) {
          let prevEnabled = ext.storage.enabled;

          const schedule = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(async () => {
              timer = null;
              if (!ext.storage.enabled) return;
              await loadGrammarEngine(); // no-op after first call
              if (!ext.storage.enabled || view.isDestroyed) return;
              const docBefore = view.state.doc;
              const { decorations, marks } = await compute(view.state, ext.options);
              // The document may have changed while we awaited the worker; if so,
              // drop this stale result — a newer pass is already scheduled.
              if (view.isDestroyed || view.state.doc !== docBefore) return;
              ext.storage.marks = marks;
              ext.options.onMarks?.(marks);
              view.dispatch(view.state.tr.setMeta(grammarKey, decorations));
            }, ext.options.debounceMs);
          };

          const clear = () => {
            if (timer) clearTimeout(timer);
            timer = null;
            ext.storage.marks = [];
            ext.options.onMarks?.([]);
            view.dispatch(view.state.tr.setMeta(grammarKey, DecorationSet.empty));
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
