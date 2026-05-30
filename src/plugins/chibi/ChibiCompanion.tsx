import React, { useEffect, useState, useRef, useCallback } from 'react';
import { PluginContext } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../../lib/utils';
import { getAiResponse } from '../../services/aiService';

type ChibiMood = 'IDLE' | 'WRITING' | 'THINKING' | 'HAPPY' | 'TALKING' | 'ALERT' | 'TIRED';

export const ChibiCompanion: React.FC<PluginContext> = ({
  editor,
  aiConfig,
  state,
  updateState,
}) => {
  const [mood, setMood] = useState<ChibiMood>('IDLE');
  const [comment, setComment] = useState<string | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);
  
  const lastPos = useRef(editor.state.selection.from);
  const velocityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const happyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local Heuristics Logic (Zero Tokens)
  const runLocalHeuristics = useCallback(() => {
    const text = editor.getText().slice(-1000); // Last 1k chars
    
    // 1. Dialogue Density
    const quoteCount = (text.match(/"/g) || []).length;
    const dialogueDensity = quoteCount / (text.length / 50); // Normalized
    
    // 2. Keyword Scanning
    const combatWords = ['blade', 'blood', 'sword', 'strike', 'kill', 'fight', 'enemy', 'shield'];
    const dramaWords = ['tears', 'heart', 'cry', 'love', 'whisper', 'goodbye', 'sad', 'pain'];
    
    const hasCombat = combatWords.some(w => text.toLowerCase().includes(w));
    const hasDrama = dramaWords.some(w => text.toLowerCase().includes(w));

    // 3. Time of Day (Free context)
    const hour = new Date().getHours();
    const isLate = hour < 5 || hour > 23;

    if (isLate && mood === 'IDLE') {
      setMood('TIRED');
    } else if (hasCombat && mood === 'IDLE') {
      setComment("Whoa, getting intense!");
      setMood('ALERT');
      setTimeout(() => setComment(null), 3000);
    } else if (dialogueDensity > 0.5 && mood === 'IDLE') {
      setMood('TALKING'); // Lean in animation
      setTimeout(() => setMood('IDLE'), 5000);
    }
  }, [editor, mood]);

  const askForFeedback = useCallback(async () => {
    if (isAiLoading || !aiConfig) return;
    
    setIsAiLoading(true);
    setMood('THINKING');
    setComment("Let me read this real quick...");

    try {
      // Use the new contextLimit from settings (default to 10k chars if missing)
      const limit = aiConfig.contextLimit || 10000;
      const fullText = editor.getText();
      const sample = fullText.slice(-limit); 

      const prompt = `You are a blunt but observant JRPG companion named ${state.petName || 'ChronicleBot'}. 
      Read the following story excerpt and give one honest, short sentence about what you think. 
      Don't be a generic assistant; be a reader. If it's exciting, say so. If it's slow, mention that. 
      Keep it under 15 words.
      
      EXCERPT:
      ${sample}`;

      const response = await getAiResponse(prompt, aiConfig);

      // Extract text from response (using same logic as EditorView)
      let bodyText = "";
      if (typeof response === 'string') bodyText = response;
      else if (Array.isArray(response.choices)) bodyText = response.choices[0]?.message?.content || "";
      else if (response.output?.[1]?.content?.[0]?.text) bodyText = response.output[1].content[0].text;

      setComment(bodyText || "I've got nothing to say right now.");
      setMood('TALKING');
      
      if (happyTimer.current) clearTimeout(happyTimer.current);
      happyTimer.current = setTimeout(() => {
        setMood('IDLE');
        setComment(null);
      }, 8000);

    } catch (err) {
      console.error("Chibi AI Error:", err);
      setComment("Muses aren't talking to me right now.");
      setMood('IDLE');
    } finally {
      setIsAiLoading(false);
    }
  }, [editor, state.petName, isAiLoading, aiConfig]);

  useEffect(() => {
    const handleTransaction = () => {
      const currentPos = editor.state.selection.from;
      if (currentPos !== lastPos.current) {
        if (mood !== 'WRITING' && mood !== 'HAPPY' && mood !== 'THINKING' && mood !== 'TALKING' && mood !== 'ALERT') {
          setMood('WRITING');
        }
        lastPos.current = currentPos;
        
        if (velocityTimer.current) clearTimeout(velocityTimer.current);
        velocityTimer.current = setTimeout(() => {
          if (mood === 'WRITING') {
            setMood('IDLE');
            runLocalHeuristics(); // Check mood after writing session
          }
        }, 3000);
      }
    };

    const handleAiStart = () => setMood('THINKING');
    const handleAiEnd = () => {
      setMood('HAPPY');
      if (happyTimer.current) clearTimeout(happyTimer.current);
      happyTimer.current = setTimeout(() => setMood('IDLE'), 5000);
    };

    editor.on('transaction', handleTransaction);
    window.addEventListener('chronicle:ai-start', handleAiStart);
    window.addEventListener('chronicle:ai-end', handleAiEnd);

    return () => {
      editor.off('transaction', handleTransaction);
      window.removeEventListener('chronicle:ai-start', handleAiStart);
      window.removeEventListener('chronicle:ai-end', handleAiEnd);
      if (velocityTimer.current) clearTimeout(velocityTimer.current);
      if (happyTimer.current) clearTimeout(happyTimer.current);
    };
  }, [editor, mood, runLocalHeuristics]);

  const petName = state.petName || 'ChronicleBot';

  return (
    <div className="fixed bottom-8 right-8 z-50 flex flex-col items-center pointer-events-none">
      <style>{`
        @keyframes chibi-idle {
          from { background-position: 0px; }
          to { background-position: -1152px; }
        }
        @keyframes chibi-writing {
          from { background-position: 0px; }
          to { background-position: -640px; }
        }
        @keyframes chibi-talking {
          from { background-position: 0px; }
          to { background-position: -1408px; }
        }
        @keyframes chibi-jump {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-20px); }
        }
        .chibi-sprite {
          width: 128px;
          height: 128px;
          image-rendering: pixelated;
          background-size: auto 128px;
        }
        .chibi-idle {
          background-image: url('/plugins/chibi/Idle.png');
          animation: chibi-idle 1.2s steps(9) infinite;
        }
        .chibi-writing {
          background-image: url('/plugins/chibi/Book.png');
          animation: chibi-writing 0.8s steps(10) infinite;
          width: 64px;
          height: 64px;
          background-size: auto 64px;
        }
        .chibi-talking {
          background-image: url('/plugins/chibi/Dialogue.png');
          animation: chibi-talking 1s steps(11) infinite;
        }
        .chibi-alert {
          background-image: url('/plugins/chibi/Dialogue.png');
          animation: chibi-talking 0.5s steps(11) infinite;
          filter: sepia(1) saturate(5) hue-rotate(-50deg);
        }
        .chibi-tired {
          background-image: url('/plugins/chibi/Idle.png');
          animation: chibi-idle 3s steps(9) infinite;
          opacity: 0.6;
        }
      `}</style>

      {/* Speech/Thought bubble container */}
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
                {mood === 'THINKING' && "Consulting the muses..."}
                {mood === 'WRITING' && "Frantic scribbling..."}
                {mood === 'HAPPY' && `Great work, ${petName}!`}
                {mood === 'ALERT' && "WHOA! Did you see that?"}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Render Frame with Spritesheet */}
      <motion.div
        animate={{
          y: mood === 'WRITING' ? [0, -4, 0] : [0, -2, 0],
          scale: mood === 'HAPPY' ? [1, 1.1, 1] : 1,
        }}
        className={cn(
          "flex items-center justify-center pointer-events-auto cursor-pointer select-none group relative",
          mood === 'WRITING' ? "w-16 h-16" : "w-32 h-32"
        )}
        onClick={() => {
          if (mood === 'IDLE' || mood === 'TIRED') askForFeedback();
          else {
            setMood('HAPPY');
            if (happyTimer.current) clearTimeout(happyTimer.current);
            happyTimer.current = setTimeout(() => setMood('IDLE'), 3000);
            updateState({ ...state, totalInteractions: (state.totalInteractions || 0) + 1 });
          }
        }}
      >
        <div className={cn(
          "chibi-sprite",
          (mood === 'IDLE' || mood === 'HAPPY' || mood === 'THINKING') && "chibi-idle",
          mood === 'WRITING' && "chibi-writing",
          mood === 'TALKING' && "chibi-talking",
          mood === 'ALERT' && "chibi-alert",
          mood === 'TIRED' && "chibi-tired"
        )} />

        {/* Interaction Badge */}
        {state.totalInteractions > 0 && mood !== 'WRITING' && (
          <div className="absolute top-4 right-4 bg-amber-500 text-[9px] font-black text-black px-1.5 py-0.5 rounded-full shadow-lg border border-black/20 z-20">
            Lv.{Math.floor(state.totalInteractions / 10) + 1}
          </div>
        )}
      </motion.div>
    </div>
  );
};
