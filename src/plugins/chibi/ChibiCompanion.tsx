import React, { useEffect, useState, useRef } from 'react';
import { PluginContext } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../../lib/utils';

type ChibiMood = 'IDLE' | 'WRITING' | 'THINKING' | 'HAPPY';

export const ChibiCompanion: React.FC<PluginContext> = ({
  editor,
  state,
  updateState,
  invokePortalCommand
}) => {
  const [mood, setMood] = useState<ChibiMood>('IDLE');
  const lastPos = useRef(editor.state.selection.from);
  const velocityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const happyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleTransaction = () => {
      const currentPos = editor.state.selection.from;
      
      // Only trigger WRITING if the cursor actually moved (typing or deleting)
      if (currentPos !== lastPos.current) {
        if (mood !== 'WRITING' && mood !== 'HAPPY' && mood !== 'THINKING') {
          setMood('WRITING');
        }
        lastPos.current = currentPos;

        // Reset velocity monitoring window
        if (velocityTimer.current) clearTimeout(velocityTimer.current);
        velocityTimer.current = setTimeout(() => {
          setMood(prev => prev === 'WRITING' ? 'IDLE' : prev);
        }, 3000); // 3 seconds of stillness triggers return to idle
      }
    };

    // Track AI activity via global events
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
  }, [editor, mood]);

  const petName = state.petName || 'ChronicleBot';

  return (
    <div className="fixed bottom-8 right-8 z-50 flex flex-col items-center pointer-events-none">
      {/* Speech/Thought bubble container */}
      <AnimatePresence>
        {(mood === 'THINKING' || mood === 'HAPPY' || mood === 'WRITING') && (
          <motion.div 
            initial={{ opacity: 0, y: 10, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 5, scale: 0.8 }}
            className="mb-3 px-3 py-1.5 bg-neutral-900 border border-white/10 rounded-xl text-[10px] text-amber-400 font-mono shadow-2xl shadow-black/50 pointer-events-auto"
          >
            {mood === 'THINKING' && "Consulting the muses..."}
            {mood === 'WRITING' && "Frantic scribbling..."}
            {mood === 'HAPPY' && `Great work, ${petName}!`}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Render Frame with Crisp Pixel Rendering */}
      <motion.div
        animate={{
          y: mood === 'WRITING' ? [0, -6, 0] : [0, -3, 0],
          scale: mood === 'HAPPY' ? [1, 1.2, 1] : 1,
          rotate: mood === 'HAPPY' ? [0, 10, -10, 0] : 0,
        }}
        transition={{
          y: {
            repeat: Infinity,
            duration: mood === 'WRITING' ? 0.3 : 2,
            ease: "easeInOut"
          },
          scale: { duration: 0.5 },
          rotate: { duration: 0.5 }
        }}
        className="w-16 h-16 bg-neutral-950 border-2 border-white/5 rounded-2xl flex items-center justify-center shadow-2xl pointer-events-auto cursor-pointer select-none group relative overflow-hidden"
        onClick={() => {
          setMood('HAPPY');
          if (happyTimer.current) clearTimeout(happyTimer.current);
          happyTimer.current = setTimeout(() => setMood('IDLE'), 3000);
          updateState({ ...state, totalInteractions: (state.totalInteractions || 0) + 1 });
        }}
      >
        {/* Animated Background Pulse */}
        <div className={cn(
          "absolute inset-0 opacity-0 group-hover:opacity-20 transition-opacity duration-500",
          mood === 'HAPPY' ? "bg-amber-400 opacity-20" : "bg-white"
        )} />

        {/* Visual Sprite Placeholder */}
        <span className="text-3xl relative z-10 filter drop-shadow-lg">
          {mood === 'IDLE' && '😴'}
          {mood === 'WRITING' && '✍️'}
          {mood === 'THINKING' && '🧐'}
          {mood === 'HAPPY' && '😺'}
        </span>

        {/* Interaction Badge */}
        {state.totalInteractions > 0 && (
          <div className="absolute top-1 right-1 bg-amber-500 text-[8px] font-black text-black px-1 rounded-sm min-w-[12px] text-center shadow-sm">
            {state.totalInteractions}
          </div>
        )}
      </motion.div>
    </div>
  );
};
