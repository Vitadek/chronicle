import { Router } from 'express';

/**
 * Grammar proxy → self-hosted LanguageTool (the engine LibreOffice uses).
 *
 * Keeps LanguageTool internal (never exposed to clients directly) and returns a
 * compact, client-shaped hit list. Both the web app and the mobile editor call
 * POST /api/grammar/check with { text } and get { hits: [{start,end,kind,message}] },
 * offsets being char indices into the submitted text.
 */
const router = Router();

const LT_URL = (process.env.LANGUAGETOOL_URL || 'http://languagetool:8010').replace(/\/+$/, '');
const LT_LANG = process.env.LANGUAGETOOL_LANG || 'en-US';

interface LtMatch {
  offset: number;
  length: number;
  message: string;
  rule?: { issueType?: string; category?: { id?: string } };
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
      // issueType: misspelling | grammar | typographical | style | ...
      kind: m.rule?.issueType || m.rule?.category?.id || 'grammar',
      message: m.message,
    }));
    res.json({ hits });
  } catch {
    res.status(502).json({ hits: [], error: 'languagetool error' });
  }
});

export default router;
