// Lazy wrapper around Harper (harper.js, a Rust->WASM grammar/style linter).
//
// The WASM binary is ~18 MB (≈7.8 MB gzipped), so this module is built to load
// it only on demand, off the main thread, and never as part of the default
// page bundle:
//   - dynamic import() keeps harper.js + its WASM in a separate chunk that the
//     bundler only fetches when the grammar checker is first switched on;
//   - WorkerLinter runs the compile + linting in a Web Worker so the 18 MB
//     compile never janks the editor;
//   - setGrammarWasmUrl() lets the mobile build point at the WASM served from
//     the Chronicle server instead of baking it into the APK.

export interface GrammarHit {
  /** Char offset into the linted text (inclusive). */
  start: number;
  /** Char offset into the linted text (exclusive). */
  end: number;
  /** Harper lint kind, e.g. 'Spelling' | 'Agreement' | 'Repetition' | 'Style'. */
  kind: string;
  message: string;
}

// Build-time flag: the editor/mobile bundle defines this as `false` so the
// bundled-WASM import below constant-folds away (keeping Harper's 18 MB binary
// out of the APK); when undefined (web build) it defaults to bundled.
declare const __HARPER_BUNDLED__: boolean | undefined;

let wasmUrlOverride: string | null = null;

/**
 * Point Harper at a WASM binary hosted at `url` (e.g. the Chronicle server)
 * instead of the bundler-emitted asset. Must be called before the first lint.
 */
export function setGrammarWasmUrl(url: string): void {
  wasmUrlOverride = url;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let linterPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getLinter(): Promise<any> {
  if (!linterPromise) {
    linterPromise = (async () => {
      const harper = await import('harper.js');
      // The `else if` condition folds to a literal `false` in the editor/mobile
      // bundle (__HARPER_BUNDLED__ defined as false), so Rollup drops the dynamic
      // import of the bundled binary AND its 18 MB WASM asset. That build must
      // call setGrammarWasmUrl() (server-hosted WASM) before enabling grammar.
      let binary;
      if (wasmUrlOverride) {
        binary = harper.createBinaryModuleFromUrl(wasmUrlOverride, 'full');
      } else if (typeof __HARPER_BUNDLED__ === 'undefined' || __HARPER_BUNDLED__) {
        binary = (await import('harper.js/binary')).binary;
      } else {
        throw new Error('[grammar] no WASM URL set; call setGrammarWasmUrl() first');
      }
      // Prefer the off-main-thread WorkerLinter; fall back to the in-thread
      // LocalLinter if the worker can't be constructed under the bundler.
      try {
        const linter = new harper.WorkerLinter({ binary });
        await linter.setup();
        return linter;
      } catch (err) {
        console.warn('[grammar] WorkerLinter unavailable, using LocalLinter', err);
        const linter = new harper.LocalLinter({ binary });
        await linter.setup();
        return linter;
      }
    })();
  }
  return linterPromise;
}

/** Begin loading + compiling the engine (idempotent). */
export async function loadGrammarEngine(): Promise<void> {
  await getLinter();
}

/** Lint a chunk of plain text and return normalized hits. */
export async function lintText(text: string): Promise<GrammarHit[]> {
  const linter = await getLinter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lints = await linter.lint(text);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return lints.map((l: any) => {
    const s = l.span();
    return { start: s.start, end: s.end, kind: l.lint_kind(), message: l.message() };
  });
}
