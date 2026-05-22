import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { getStatus, revalidate } from '../aiValidate';

const router = Router();

/**
 * AI proxy. The API key is held server-side (OPENAI_API_KEY,
 * ANTHROPIC_API_KEY, GEMINI_API_KEY) and never sent to the client. The
 * client tells us which provider, which model, and what to ask — we
 * attach the secret and forward.
 *
 * This makes self-hosted multi-device setups simpler: the key lives in
 * one place, no localStorage to keep in sync, and devices behind a
 * shared OIDC login share the same model access.
 *
 * Three providers supported:
 *   - openai    → /v1/responses (text) and /v1/audio/speech (TTS)
 *   - anthropic → /v1/messages   (text). No TTS.
 *   - gemini    → /v1beta/models/{model}:generateContent (text). No TTS.
 */

const Provider = z.enum(['openai', 'anthropic', 'gemini']);

const TextBody = z.object({
  provider: Provider,
  model: z.string().min(1).max(120),
  input: z.string().min(1).max(200_000),
  /** Anthropic requires max_tokens; OpenAI ignores it; Gemini honours it. */
  maxTokens: z.number().int().min(1).max(64_000).optional(),
  /** Optional system prompt. */
  system: z.string().max(20_000).optional(),
  /**
   * When provided, the proxy asks the model to return JSON conforming to
   * the schema and validates the response before forwarding. Used by the
   * MCP-style fill features (character sheets, plot nodes).
   *
   * The schema is a JSON Schema object — same shape OpenAI's structured
   * outputs and Anthropic's tool inputs accept.
   */
  jsonSchema: z.record(z.any()).optional(),
});

function keyFor(provider: 'openai' | 'anthropic' | 'gemini'): string | undefined {
  if (provider === 'openai') return config.openaiKey;
  if (provider === 'anthropic') return config.anthropicKey;
  return config.geminiKey;
}

function envVarFor(provider: 'openai' | 'anthropic' | 'gemini'): string {
  if (provider === 'openai') return 'OPENAI_API_KEY';
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  return 'GEMINI_API_KEY';
}

/**
 * Public capabilities probe. Returns which providers are configured *and*
 * the result of the most recent key-validation pass. The settings UI uses
 * this to dim unavailable providers and warn when a key was rejected at
 * boot — the alternative ("I'll find out when I try") gives much worse UX.
 */
router.get('/config', (_req, res) => {
  const status = getStatus();
  res.json({
    providers: {
      openai:    { configured: status.openai.configured,    valid: status.openai.state === 'ok',    state: status.openai.state,    message: status.openai.message ?? null,    checkedAt: status.openai.checkedAt ?? null },
      anthropic: { configured: status.anthropic.configured, valid: status.anthropic.state === 'ok', state: status.anthropic.state, message: status.anthropic.message ?? null, checkedAt: status.anthropic.checkedAt ?? null },
      gemini:    { configured: status.gemini.configured,    valid: status.gemini.state === 'ok',    state: status.gemini.state,    message: status.gemini.message ?? null,    checkedAt: status.gemini.checkedAt ?? null },
    },
    defaultModel: config.aiModel,
    audioModel: config.audioModel,
    audioVoice: config.audioVoice,
  });
});

/**
 * Force a fresh key probe. Useful for the user to confirm a rotated key
 * works without restarting the container. Returns the new status.
 */
router.post('/config/revalidate', async (_req, res) => {
  await revalidate();
  res.json(getStatus());
});

router.post('/respond', async (req, res) => {
  const parsed = TextBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request body' } });
    return;
  }
  const { provider, model, input, maxTokens, system, jsonSchema } = parsed.data;
  const apiKey = keyFor(provider);
  if (!apiKey) {
    res.status(503).json({
      error: { message: `${provider} key not configured on server. Set ${envVarFor(provider)} and restart.` },
    });
    return;
  }

  try {
    if (provider === 'openai') {
      // For structured-output requests, pass a response_format hint. The
      // Responses API accepts a `text.format` of type=json_schema.
      const body: any = { model, input };
      if (jsonSchema) {
        body.text = {
          format: {
            type: 'json_schema',
            name: 'chronicle_fill',
            strict: true,
            schema: jsonSchema,
          },
        };
      }
      const upstream = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      const data = await upstream.json();
      if (!upstream.ok) {
        res.status(upstream.status).json(data);
        return;
      }
      res.json(data);
      return;
    }

    if (provider === 'anthropic') {
      // For JSON-schema requests we use Anthropic's tool-use mechanism: a
      // single tool whose input schema is the user's schema. We tell the
      // model to call the tool and we extract the tool_use.input.
      const aBody: any = {
        model,
        max_tokens: maxTokens ?? 4096,
        system: system || undefined,
        messages: [{ role: 'user', content: input }],
      };
      if (jsonSchema) {
        aBody.tools = [{
          name: 'chronicle_fill',
          description: 'Return the filled fields.',
          input_schema: jsonSchema,
        }];
        aBody.tool_choice = { type: 'tool', name: 'chronicle_fill' };
      }
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(aBody),
      });
      const data = await upstream.json();
      if (!upstream.ok) {
        const message = data?.error?.message || data?.message || `Anthropic error ${upstream.status}`;
        res.status(upstream.status).json({ error: { message } });
        return;
      }
      // Normalise. For plain text responses we collect the text blocks; for
      // tool_use responses we surface the input JSON serialized as text so
      // the client extractor can parse it uniformly.
      let text = '';
      if (Array.isArray(data?.content)) {
        const toolBlock = data.content.find((c: any) => c?.type === 'tool_use');
        if (toolBlock) {
          text = JSON.stringify(toolBlock.input);
        } else {
          text = data.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n\n');
        }
      }
      res.json({
        output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
        _raw: data,
      });
      return;
    }

    if (provider === 'gemini') {
      // Gemini's request shape: contents=[{role,parts:[{text}]}]. System
      // prompt rides on systemInstruction. JSON-schema requests use
      // generationConfig.responseMimeType + responseSchema.
      const gBody: any = {
        contents: [{ role: 'user', parts: [{ text: input }] }],
        generationConfig: {
          maxOutputTokens: maxTokens ?? 4096,
        },
      };
      if (system) {
        gBody.systemInstruction = { parts: [{ text: system }] };
      }
      if (jsonSchema) {
        gBody.generationConfig.responseMimeType = 'application/json';
        gBody.generationConfig.responseSchema = jsonSchema;
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gBody),
      });
      const data = await upstream.json();
      if (!upstream.ok) {
        const message = data?.error?.message || `Gemini error ${upstream.status}`;
        res.status(upstream.status).json({ error: { message } });
        return;
      }
      // candidates[0].content.parts[].text — concatenate.
      const text: string = Array.isArray(data?.candidates?.[0]?.content?.parts)
        ? data.candidates[0].content.parts.map((p: any) => p?.text || '').join('')
        : '';
      res.json({
        output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
        _raw: data,
      });
      return;
    }
  } catch (err) {
    console.error('AI request failed:', err);
    res.status(500).json({ error: { message: 'AI request failed' } });
  }
});

/** Text-to-speech. OpenAI only. */
const TtsBody = z.object({
  model: z.string().min(1).max(120).optional(),
  voice: z.string().min(1).max(40).optional(),
  text: z.string().min(1).max(8000),
});

router.post('/speak', async (req, res) => {
  const parsed = TtsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid TTS body' } });
    return;
  }
  if (!config.openaiKey) {
    res.status(503).json({ error: { message: 'OPENAI_API_KEY not configured on server.' } });
    return;
  }
  const model = parsed.data.model || config.audioModel;
  const voice = parsed.data.voice || config.audioVoice;
  const text = parsed.data.text;

  try {
    const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openaiKey}`,
      },
      body: JSON.stringify({ model, voice, input: text, response_format: 'mp3' }),
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      console.error('TTS upstream error:', upstream.status, body);
      res.status(upstream.status).json({
        error: { message: `TTS failed (${upstream.status})` },
      });
      return;
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buf.length.toString());
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  } catch (err) {
    console.error('TTS request failed:', err);
    res.status(500).json({ error: { message: 'TTS request failed' } });
  }
});

export default router;

