import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { definePlugin, PLUGIN_API_VERSION, type PluginContext } from '@chronicle/plugin-api';

/**
 * Chibi Assistant — the reference Chronicle plugin.
 *
 * Written the way any plugin is: plain TSX in a git repo, importing only the
 * host-provided modules (react, motion/react, @chronicle/plugin-api). The
 * Chronicle server compiles it with esbuild; the app evaluates it against its
 * own React instance. No build tooling needed on the author's side.
 *
 * It demonstrates three slots: `companion` (a floating overlay), `slashCommands`
 * (#!/chibi_rename), and persisted `state`.
 */

type ChibiMood = 'IDLE' | 'WRITING' | 'THINKING' | 'HAPPY' | 'TALKING' | 'ALERT' | 'TIRED';

interface ChibiState {
  petName?: string;
  totalInteractions?: number;
}

const cn = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

const Companion: React.FC<PluginContext> = (ctx) => {
  const { editor, state, services } = ctx;
  const [mood, setMood] = useState<ChibiMood>('IDLE');
  const [comment, setComment] = useState<string | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);

  const lastPos = useRef(0);
  const velocityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const happyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = () => (state.get() as ChibiState) || {};
  const petName = current().petName || 'ChronicleBot';
  const interactions = current().totalInteractions || 0;

  /** Local, zero-token mood heuristics over the recent text. */
  const runLocalHeuristics = useCallback(() => {
    if (!editor) return;
    const text = editor.getText().slice(-1000).toLowerCase();

    const quoteCount = (text.match(/"/g) || []).length;
    const dialogueDensity = quoteCount / Math.max(1, text.length / 50);
    const combat = ['blade', 'blood', 'sword', 'strike', 'kill', 'fight', 'enemy', 'shield'];
    const hasCombat = combat.some((w) => text.includes(w));
    const hour = new Date().getHours();
    const isLate = hour < 5 || hour > 23;

    if (isLate && mood === 'IDLE') {
      setMood('TIRED');
    } else if (hasCombat && mood === 'IDLE') {
      setComment('Whoa, getting intense!');
      setMood('ALERT');
      setTimeout(() => setComment(null), 3000);
    } else if (dialogueDensity > 0.5 && mood === 'IDLE') {
      setMood('TALKING');
      setTimeout(() => setMood('IDLE'), 5000);
    }
  }, [editor, mood]);

  /** Ask the host's AI service for a line of encouragement about the prose. */
  const askForFeedback = useCallback(async () => {
    if (isAiLoading || !editor) return;
    if (!services.ai.available) {
      setComment('AI is switched off on this instance.');
      setMood('IDLE');
      setTimeout(() => setComment(null), 4000);
      return;
    }

    setIsAiLoading(true);
    setMood('THINKING');
    setComment('Let me read this real quick...');

    try {
      const sample = editor.getText().slice(-10000);
      const reply = await services.ai.respond(
        `Read the following story excerpt. Give one short, supportive sentence of feedback. ` +
        `Mention one specific detail, character, or event you liked, to prove you read it. ` +
        `Keep it under 20 words.\n\nEXCERPT:\n${sample}`,
        `You are an encouraging and observant JRPG companion named ${petName}.`,
      );
      setComment(reply || "I've got nothing to say right now.");
      setMood('TALKING');
      if (happyTimer.current) clearTimeout(happyTimer.current);
      happyTimer.current = setTimeout(() => {
        setMood('IDLE');
        setComment(null);
      }, 8000);
    } catch {
      setComment("Muses aren't talking to me right now.");
      setMood('IDLE');
    } finally {
      setIsAiLoading(false);
    }
  }, [editor, isAiLoading, petName, services]);

  useEffect(() => {
    if (!editor) return;
    lastPos.current = editor.state.selection.from;

    const handleTransaction = () => {
      const pos = editor.state.selection.from;
      if (Math.abs(pos - lastPos.current) > 5) {
        if (!['WRITING', 'HAPPY', 'THINKING', 'TALKING', 'ALERT'].includes(mood)) setMood('WRITING');
        lastPos.current = pos;
        if (velocityTimer.current) clearTimeout(velocityTimer.current);
        velocityTimer.current = setTimeout(() => {
          if (mood === 'WRITING') {
            setMood('IDLE');
            runLocalHeuristics();
          }
        }, 3000);
      }
    };
    const onAiStart = () => setMood('THINKING');
    const onAiEnd = () => {
      setMood('HAPPY');
      if (happyTimer.current) clearTimeout(happyTimer.current);
      happyTimer.current = setTimeout(() => setMood('IDLE'), 5000);
    };

    editor.on('transaction', handleTransaction);
    window.addEventListener('chronicle:ai-start', onAiStart);
    window.addEventListener('chronicle:ai-end', onAiEnd);
    return () => {
      editor.off('transaction', handleTransaction);
      window.removeEventListener('chronicle:ai-start', onAiStart);
      window.removeEventListener('chronicle:ai-end', onAiEnd);
      if (velocityTimer.current) clearTimeout(velocityTimer.current);
      if (happyTimer.current) clearTimeout(happyTimer.current);
    };
  }, [editor, mood, runLocalHeuristics]);

  return (
    <div className="fixed bottom-8 right-8 z-50 flex flex-col items-center pointer-events-none">
      <style>{`
        @keyframes chibi-idle { from { background-position: 0px; } to { background-position: -1152px; } }
        @keyframes chibi-attack { from { background-position: 0px; } to { background-position: -1024px; } }
        @keyframes chibi-talking { from { background-position: 0px; } to { background-position: -1408px; } }
        @keyframes book-spin { from { background-position: 0px; } to { background-position: -640px; } }
        .chibi-sprite { width:128px; height:128px; image-rendering:pixelated; background-size:auto 128px; background-repeat:no-repeat; }
        .chibi-idle { background-image:url('/plugins/chibi/Idle.png'); animation:chibi-idle 1.2s steps(9) infinite; }
        .chibi-writing { background-image:url('/plugins/chibi/Attack.png'); animation:chibi-attack 0.6s steps(8) infinite; }
        .chibi-talking { background-image:url('/plugins/chibi/Dialogue.png'); animation:chibi-talking 1s steps(11) infinite; }
        .chibi-alert { background-image:url('/plugins/chibi/Dialogue.png'); animation:chibi-talking 0.5s steps(11) infinite; filter:sepia(1) saturate(5) hue-rotate(-50deg); }
        .chibi-tired { background-image:url('/plugins/chibi/Idle.png'); animation:chibi-idle 3s steps(9) infinite; opacity:0.6; }
        .writing-accessory { position:absolute; bottom:10px; right:-10px; width:64px; height:64px; background-image:url('/plugins/chibi/Book.png'); animation:book-spin 0.8s steps(10) infinite; background-size:auto 64px; image-rendering:pixelated; z-index:20; }
      `}</style>

      <AnimatePresence>
        {(mood === 'THINKING' || mood === 'HAPPY' || mood === 'WRITING' || mood === 'ALERT' || comment) && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 5, scale: 0.8 }}
            className="mb-3 px-4 py-2 bg-neutral-900 border border-white/10 rounded-2xl text-[11px] text-amber-400 font-mono shadow-2xl shadow-black/50 pointer-events-auto max-w-[200px] text-center"
          >
            {comment || (
              <>
                {mood === 'THINKING' && 'Consulting the muses...'}
                {mood === 'WRITING' && 'Frantic scribbling...'}
                {mood === 'HAPPY' && `Great work, ${petName}!`}
                {mood === 'ALERT' && 'WHOA! Did you see that?'}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        animate={{
          y: mood === 'WRITING' ? [0, -4, 0] : [0, -2, 0],
          scale: mood === 'HAPPY' ? [1, 1.1, 1] : 1,
        }}
        className="flex items-center justify-center pointer-events-auto cursor-pointer select-none group relative w-32 h-32"
        onClick={() => {
          if (mood === 'IDLE' || mood === 'TIRED') {
            void askForFeedback();
          } else {
            setMood('HAPPY');
            if (happyTimer.current) clearTimeout(happyTimer.current);
            happyTimer.current = setTimeout(() => setMood('IDLE'), 3000);
            state.set({ ...current(), totalInteractions: interactions + 1 });
          }
        }}
      >
        <div
          className={cn(
            'chibi-sprite',
            (mood === 'IDLE' || mood === 'HAPPY' || mood === 'THINKING') && 'chibi-idle',
            mood === 'WRITING' && 'chibi-writing',
            mood === 'TALKING' && 'chibi-talking',
            mood === 'ALERT' && 'chibi-alert',
            mood === 'TIRED' && 'chibi-tired',
          )}
        />
        {mood === 'WRITING' && <div className="writing-accessory" />}
        {interactions > 0 && mood !== 'WRITING' && (
          <div className="absolute top-4 right-4 bg-amber-500 text-[9px] font-black text-black px-1.5 py-0.5 rounded-full shadow-lg border border-black/20 z-20">
            Lv.{Math.floor(interactions / 10) + 1}
          </div>
        )}
      </motion.div>
    </div>
  );
};

export default definePlugin<ChibiState>({
  apiVersion: PLUGIN_API_VERSION,
  id: 'chronicle.chibi',
  name: 'Chibi Assistant',
  description: 'Pixel-art workspace companion. Reacts to your writing, and reads a passage back to you on request.',
  defaultState: { petName: 'ChronicleBot', totalInteractions: 0 },
  contributes: {
    companion: Companion,
    slashCommands: [
      {
        name: 'chibi_rename',
        description: 'Rename your companion — #!/chibi_rename <name>',
        run: (ctx, args) => {
          const name = args.join(' ').trim();
          if (!name) {
            ctx.services.toast('Usage: #!/chibi_rename <name>', 'error');
            return;
          }
          ctx.state.set({ ...(ctx.state.get() as ChibiState), petName: name });
          ctx.services.toast(`Companion renamed to ${name}.`);
        },
      },
    ],
  },
});
