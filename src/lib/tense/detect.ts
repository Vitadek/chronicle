// Local, deterministic tense-shift detector.
//
// Narrative prose normally holds one tense (past, sometimes present). An
// accidental drift — a lone present-tense sentence in a past-tense paragraph —
// is a common, hard-to-self-spot error. This module finds those drifts using
// compromise's contextual part-of-speech tagging (NOT regex), which is what
// lets it tell a past-tense verb ("creaked") from an -ed adjective
// ("forgotten") or a plural noun from a present-tense verb.
//
// It is pure (no DOM / ProseMirror): give it a paragraph string, get back
// per-sentence tenses + the spans that deviate from the paragraph's dominant
// tense. The ProseMirror layer (lib/TenseShift.ts) maps those char spans to
// document positions and paints squiggles. Dialogue is excluded — characters
// may speak in any tense without it being an error.

// compromise (~0.5 MB) is loaded lazily so it only ships to the client when the
// tense checker is actually switched on — keeping the default page load lean.
type Nlp = (text: string) => unknown;
let _nlp: Nlp | null = null;

/** Dynamically import the POS engine. Call (and await) before analyzing. */
export async function loadTenseEngine(): Promise<void> {
  if (_nlp) return;
  const mod = (await import('compromise')) as unknown as { default?: Nlp } & Nlp;
  _nlp = (mod.default || mod) as Nlp;
}

/** Whether the engine has been loaded yet. */
export function isTenseEngineReady(): boolean {
  return _nlp !== null;
}

export type Tense = 'past' | 'present' | 'future' | 'unknown';

export interface SentenceSpan {
  /** Char offset into the paragraph text (inclusive). */
  start: number;
  /** Char offset into the paragraph text (exclusive). */
  end: number;
  text: string;
  tense: Tense;
}

export interface TenseShift extends SentenceSpan {
  /** The paragraph's dominant tense this sentence drifts away from. */
  expected: Tense;
}

export interface ParagraphAnalysis {
  /** The narrative tense the paragraph is mostly written in, or null if unclear. */
  dominant: Tense | null;
  sentences: SentenceSpan[];
  /** Sentences whose tense deviates from a clear dominant. */
  shifts: TenseShift[];
}

// Finite auxiliaries / copulas carry the clause's tense, so we trust their
// lemma over a participle's surface tag (e.g. "has eaten" is present perfect:
// the tense is `has`, not the past participle `eaten`).
const PAST_AUX = new Set(['was', 'were', 'had', 'did']);
const PRESENT_AUX = new Set(['is', 'are', 'am', 'has', 'have', 'do', 'does', 'being']);

interface Term {
  text: string;
  normal?: string;
  tags: Set<string>;
}

/**
 * Classify a single sentence's narrative tense by voting over its finite verbs.
 * Non-finite forms (gerunds, infinitives, bare participles) are skipped because
 * their tense is governed by an auxiliary we count instead.
 */
export function classifySentence(text: string): Tense {
  if (!_nlp) return 'unknown'; // engine not loaded yet; caller should await loadTenseEngine()
  const doc = _nlp(text);
  let past = 0;
  let present = 0;
  let future = 0;

  // compromise exposes parsed terms via doc.docs: sentence[] -> term[].
  const sentences = (doc as unknown as { docs: Term[][] }).docs;
  for (const sentence of sentences) {
    for (const term of sentence) {
      const tags = term.tags;
      if (!tags.has('Verb') && !tags.has('Copula')) continue;
      const norm = (term.normal || term.text || '').toLowerCase();

      if (tags.has('Modal')) {
        if (norm === 'will' || norm === 'shall') future++;
        // Other modals (would/could/might/...) are tense-ambiguous: skip.
        continue;
      }
      // Auxiliary/copula lemma is the most reliable finiteness signal.
      if (PAST_AUX.has(norm)) { past++; continue; }
      if (PRESENT_AUX.has(norm)) { present++; continue; }
      // Non-finite forms are governed by an aux we already counted.
      if (tags.has('Infinitive') || tags.has('Gerund') || tags.has('Participle')) continue;
      if (tags.has('PastTense')) { past++; continue; }
      if (tags.has('PresentTense')) { present++; continue; }
    }
  }

  if (future > past && future > present) return 'future';
  if (past > present) return 'past';
  if (present > past) return 'present';
  return 'unknown';
}

/**
 * Replace dialogue (text inside double-quote pairs, straight or curly) with
 * spaces, preserving length so downstream char offsets stay valid. The quote
 * characters themselves are kept.
 */
export function maskDialogue(text: string): string {
  const arr = text.split('');
  let openAt = -1;
  let closeCh = '';
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (openAt === -1) {
      if (c === '"') { openAt = i; closeCh = '"'; }
      else if (c === '“') { openAt = i; closeCh = '”'; } // “ … ”
    } else if (c === closeCh) {
      for (let j = openAt + 1; j < i; j++) {
        if (arr[j] !== '\n') arr[j] = ' ';
      }
      openAt = -1;
    }
  }
  return arr.join('');
}

/** Split into sentences, tracking char offsets into the original string. */
export function splitSentences(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '.' || c === '!' || c === '?') {
      let j = i + 1;
      // Absorb trailing terminal punctuation and closing quotes/brackets.
      while (j < n && /[.!?'"”’)]/.test(text[j])) j++;
      if (j >= n || /\s/.test(text[j])) {
        const seg = text.slice(start, j);
        if (seg.trim()) out.push({ start, end: j, text: seg });
        while (j < n && /\s/.test(text[j])) j++;
        start = j;
        i = j;
        continue;
      }
    }
    i++;
  }
  if (start < n) {
    const seg = text.slice(start, n);
    if (seg.trim()) out.push({ start, end: n, text: seg });
  }
  return out;
}

/**
 * Analyze a paragraph: classify each sentence and flag the ones that drift from
 * the paragraph's dominant narrative tense. To avoid noise we only flag when
 * there are >= 2 narrative (past/present) sentences AND one tense is a strict
 * majority — an all-present paragraph inside a past-tense work (a deliberate
 * aside) is left alone; a lone present sentence among past ones is caught.
 */
export function analyzeParagraph(text: string): ParagraphAnalysis {
  const masked = maskDialogue(text);
  const sentences: SentenceSpan[] = splitSentences(masked).map((s) => ({
    start: s.start,
    end: s.end,
    text: text.slice(s.start, s.end),
    tense: classifySentence(masked.slice(s.start, s.end)),
  }));

  let past = 0;
  let present = 0;
  for (const s of sentences) {
    if (s.tense === 'past') past++;
    else if (s.tense === 'present') present++;
  }
  const total = past + present;
  const dominant: Tense | null = total >= 1 ? (past >= present ? 'past' : 'present') : null;

  const shifts: TenseShift[] = [];
  if (dominant && total >= 2 && Math.max(past, present) > total / 2) {
    for (const s of sentences) {
      if ((s.tense === 'past' || s.tense === 'present') && s.tense !== dominant) {
        shifts.push({ ...s, expected: dominant });
      }
    }
  }

  return { dominant, sentences, shifts };
}
