import { Router } from 'express';
import { config } from '../config';

/**
 * Grammar proxy → self-hosted LanguageTool (the engine LibreOffice uses).
 *
 * Keeps LanguageTool internal (never exposed to clients directly) and returns a
 * compact, client-shaped hit list. Both the web app and the mobile editor call
 * POST /api/grammar/check with { text } and get { hits: [{start,end,kind,message}] },
 * offsets being char indices into the submitted text.
 */
const router = Router();

const LT_URL = config.grammar.languagetoolUrl;
const LT_LANG = config.grammar.languagetoolLang;

interface LtMatch {
  offset: number;
  length: number;
  message: string;
  rule?: { issueType?: string; category?: { id?: string } };
  replacements?: { value: string }[];
}

/**
 * LanguageTool's own classification, with one correction.
 *
 * LT reports CONFUSED_WORDS hits (quiet/quite, their/there, lead/led) with
 * `issueType: "misspelling"` even though the flagged word is spelled perfectly.
 * Passing that through told authors their word didn't exist, and — because
 * "misspelling" is the kind the custom dictionary filters on — invited them to
 * "add to dictionary", which would whitelist a common English word and silence
 * the rule everywhere. These are word-CHOICE suggestions (and, on older or
 * deliberate diction, often false positives), so they get their own kind:
 * advisory, dictionary-proof, still carrying LT's replacement.
 */
function kindFor(m: LtMatch): string {
  if (m.rule?.category?.id === 'CONFUSED_WORDS') return 'confusion';
  // issueType: misspelling | grammar | typographical | style | ...
  return m.rule?.issueType || m.rule?.category?.id || 'grammar';
}

router.post('/check', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) {
    res.json({ hits: [] });
    return;
  }
  try {
    const params = new URLSearchParams();
    params.set('language', LT_LANG);
    params.set('text', text);
    const r = await fetch(`${LT_URL}/v2/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!r.ok) {
      res.status(502).json({ hits: [], error: 'languagetool unavailable' });
      return;
    }
    const data = (await r.json()) as { matches?: LtMatch[] };
    const hits = (data.matches || []).map((m) => ({
      start: m.offset,
      end: m.offset + m.length,
      kind: kindFor(m),
      message: m.message,
      // Dictionary corrections (capped — LT can return dozens for a bad typo).
      // The Proofread view renders these as one-click spelling fixes.
      replacements: (m.replacements ?? []).slice(0, 5).map((r) => r.value),
    }));
    res.json({ hits });
  } catch {
    res.status(502).json({ hits: [], error: 'languagetool error' });
  }
});

export default router;
