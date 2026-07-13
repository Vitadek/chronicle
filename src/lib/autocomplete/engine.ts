// The completion engine behind lib/Autocomplete.ts — pure data + scoring, no
// ProseMirror, so scripts/verify-autocomplete.ts can exercise it directly
// (same layering as lib/tense/detect.ts under lib/TenseShift.ts).
//
// Candidates come from two sources, blended:
//
//  1. THE DOCUMENT ITSELF — every word the writer has used, with counts and
//     bigram (previous-word → word) counts. This is what makes completion feel
//     personal instead of random: character names, invented places, and the
//     writer's own vocabulary always outrank a generic dictionary. The same
//     idea as editor buffer-completion (vim's C-n, Sublime's), which has
//     worked for decades.
//  2. A FREQUENCY-RANKED ENGLISH LIST (see wordlist.ts) — 25k words from
//     Norvig's Google-corpus counts, so short prefixes complete to genuinely
//     common words, not to whatever happens to sit first in an array.
//
// Ranking is tiered, most personal first:
//
//     bigram match in doc  >  repeated doc word  >  top-frequency dictionary
//     word  >  doc word seen once  >  everything else by corpus rank
//
// All lookups are synchronous and O(candidates): a Map walk over document
// vocabulary plus a binary-searched slice of the sorted dictionary. There is
// nothing to debounce — the ghost can be recomputed on every keystroke.

export interface EngineSuggestion {
  /** The full word being offered, in its display casing. */
  word: string;
  /** What the ghost shows / Tab inserts: `word` minus the typed prefix. */
  suffix: string;
  source: 'document' | 'dictionary';
}

/** Below this many typed chars we never suggest — too little signal. */
export const MIN_PREFIX = 2;
/** A ghost shorter than this is noise: typing it is faster than reading it. */
export const MIN_SUFFIX = 2;

// A document word seen ONCE ranks as if it were this frequent in the corpus:
// above workaday vocabulary, below the true function-word core ("that",
// "with", …), which a single typo shouldn't displace. Seen twice, it beats
// the whole dictionary — at that point it's established manuscript canon.
const SINGLETON_EQUIV_RANK = 800;

// Score tiers, far enough apart that the tiers never interleave.
const TIER_BIGRAM = 4_000_000_000;
const TIER_DOC_REPEATED = 3_000_000_000;
const TIER_DICT_MAX = 1_000_000; // dictionary word score = TIER_DICT_MAX - rank

// Letters plus in-word apostrophes ("didn't", "Katherine's"). Hyphens split:
// compound coinages pollute the vocabulary more than they help completion.
const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;

export class CompletionEngine {
  /** Dictionary words, lexicographically sorted (for prefix range search). */
  private dictSorted: string[] = [];
  /** word → corpus rank, 0 = most frequent. */
  private dictRank = new Map<string, number>();

  /** lowercased word → occurrences in the document. */
  private docCounts = new Map<string, number>();
  /** lowercased word → most frequent original casing ("katherine" → "Katherine"). */
  private docForms = new Map<string, string>();
  /** lowercased previous word → (lowercased word → count). */
  private docBigrams = new Map<string, Map<string, number>>();

  get dictionaryLoaded(): boolean {
    return this.dictSorted.length > 0;
  }

  /** Feed the newline-separated, frequency-ordered wordlist (see wordlist.ts). */
  loadDictionary(newlineSeparated: string): void {
    this.dictRank.clear();
    const words = newlineSeparated.split('\n');
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w && !this.dictRank.has(w)) this.dictRank.set(w, i);
    }
    this.dictSorted = Array.from(this.dictRank.keys()).sort();
  }

  /**
   * Rebuild the document-derived tables from plain text. A full rescan of a
   * chapter is single-digit milliseconds, so the caller just debounces edits;
   * no incremental bookkeeping to get wrong.
   */
  scanDocument(text: string): void {
    const formCounts = new Map<string, number>(); // exact form → count
    const counts = new Map<string, number>();
    const bigrams = new Map<string, Map<string, number>>();

    let prev: string | null = null;
    for (const match of text.matchAll(WORD_RE)) {
      const form = match[0];
      const lower = form.toLowerCase();
      formCounts.set(form, (formCounts.get(form) ?? 0) + 1);
      counts.set(lower, (counts.get(lower) ?? 0) + 1);
      // "Katherine's" also vouches for "Katherine".
      const apos = lower.search(/['’]/);
      if (apos > 0) {
        const base = lower.slice(0, apos);
        counts.set(base, (counts.get(base) ?? 0) + 1);
        const baseForm = form.slice(0, apos);
        formCounts.set(baseForm, (formCounts.get(baseForm) ?? 0) + 1);
      }
      if (prev !== null) {
        let next = bigrams.get(prev);
        if (!next) bigrams.set(prev, (next = new Map()));
        next.set(lower, (next.get(lower) ?? 0) + 1);
      }
      prev = lower;
    }

    // Fold exact forms down to one display casing per word: the form seen
    // most often wins, so "The" at sentence starts doesn't capitalize "the",
    // while a name that is always capitalized stays capitalized.
    const forms = new Map<string, string>();
    const formWins = new Map<string, number>();
    for (const [form, count] of formCounts) {
      const lower = form.toLowerCase();
      if ((formWins.get(lower) ?? 0) < count) {
        formWins.set(lower, count);
        forms.set(lower, form);
      }
    }

    this.docCounts = counts;
    this.docForms = forms;
    this.docBigrams = bigrams;
  }

  /**
   * Credit an accepted completion immediately, bridging the gap until the
   * next document rescan picks it up from the text itself.
   */
  noteAccepted(prevWord: string | null, word: string): void {
    const lower = word.toLowerCase();
    this.docCounts.set(lower, (this.docCounts.get(lower) ?? 0) + 1);
    if (!this.docForms.has(lower)) this.docForms.set(lower, word);
    if (prevWord) {
      const prev = prevWord.toLowerCase();
      let next = this.docBigrams.get(prev);
      if (!next) this.docBigrams.set(prev, (next = new Map()));
      next.set(lower, (next.get(lower) ?? 0) + 1);
    }
  }

  /**
   * The single best completion for what's under the caret, or null when
   * nothing clears the bars (prefix ≥ 2, ghost ≥ 2, known word ≠ the prefix).
   * Deterministic: ties break to the shorter word, then alphabetically.
   */
  suggest(prefix: string, prevWord: string | null): EngineSuggestion | null {
    if (prefix.length < MIN_PREFIX) return null;
    const p = prefix.toLowerCase();
    const prev = prevWord ? prevWord.toLowerCase() : null;
    const bigramNext = prev ? this.docBigrams.get(prev) : undefined;

    let bestWord: string | null = null;
    let bestScore = -1;
    let bestSource: EngineSuggestion['source'] = 'document';

    const consider = (lower: string, score: number, source: EngineSuggestion['source']) => {
      if (
        bestWord === null ||
        score > bestScore ||
        (score === bestScore &&
          (lower.length < bestWord.length || (lower.length === bestWord.length && lower < bestWord)))
      ) {
        bestWord = lower;
        bestScore = score;
        bestSource = source;
      }
    };

    // Document vocabulary: a few thousand Map entries at novel-chapter scale;
    // a linear pass is well under a millisecond.
    for (const [lower, count] of this.docCounts) {
      if (lower.length - p.length < MIN_SUFFIX) continue;
      if (!lower.startsWith(p)) continue;
      const bigramCount = bigramNext?.get(lower) ?? 0;
      const score =
        bigramCount > 0
          ? TIER_BIGRAM + bigramCount * 1000 + Math.min(count, 999)
          : count >= 2
            ? TIER_DOC_REPEATED + count
            : TIER_DICT_MAX - SINGLETON_EQUIV_RANK;
      consider(lower, score, 'document');
    }

    // Dictionary: binary-search the start of the prefix range, walk it.
    const start = lowerBound(this.dictSorted, p);
    for (let i = start; i < this.dictSorted.length; i++) {
      const word = this.dictSorted[i];
      if (!word.startsWith(p)) break;
      if (word.length - p.length < MIN_SUFFIX) continue;
      if (this.docCounts.has(word)) continue; // the document pass already scored it
      consider(word, TIER_DICT_MAX - (this.dictRank.get(word) ?? TIER_DICT_MAX), 'dictionary');
    }

    if (bestWord === null) return null;
    // Display casing: the document's own usage wins; dictionary words follow
    // the typed prefix. Suffix comes from the display form so interior casing
    // ("McKenna" → "cKenna" after "M") survives.
    const form = this.docForms.get(bestWord) ?? bestWord;
    const suffix = form.slice(prefix.length);
    if (suffix.length < MIN_SUFFIX) return null;
    return { word: form, suffix, source: bestSource };
  }
}

/** Index of the first element ≥ target. */
function lowerBound(sorted: string[], target: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
