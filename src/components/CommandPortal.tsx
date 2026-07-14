import React, { useState, useEffect, forwardRef, useImperativeHandle, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Terminal, MessageSquare, Quote, Sparkles, Wand2, MapPin, MessageCircle, Volume2 } from 'lucide-react';
import { cn } from '../lib/utils';

export const CommandPortal = forwardRef((props: any, ref) => {
  const [commandText, setCommandText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // AI agent menu can be hidden via Settings → AI Agent. When disabled, the
  // AI rows don't render and `#!/ai_*` paths become inert keystrokes.
  const isAiEnabled = props.isAiEnabled !== false;
  
  useEffect(() => {
    // Sharp focus on mount
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 10);
    return () => clearTimeout(timer);
  }, []);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === 'Escape') {
        return true;
      }
      return false;
    },
    onUpdate: () => {},
  }));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const parts = commandText.trim().split(/\s+/);
      const rawCmd = parts[0].toLowerCase();
      const args = parts.slice(1);
      
      const cmd = rawCmd.startsWith('/') ? rawCmd.slice(1) : rawCmd;

      if (cmd === 'comment') {
        props.command({ command: 'comment', args });
      } else if (cmd === 'epigraph') {
        props.command({ command: 'epigraph', args });
      } else if (isAiEnabled && cmd.includes('ai_listen')) {
        props.command({ command: 'ai_listen', args });
      } else if (isAiEnabled && cmd.includes('ai_outline/whereami')) {
        props.command({ command: 'ai_outline_whereami', args });
      } else if (isAiEnabled && cmd.includes('ai_outline')) {
        props.command({ command: 'ai_outline', args });
      } else if (isAiEnabled && cmd.includes('ai_review/make_comments')) {
        props.command({ command: 'ai_review_make_comments', args });
      } else if (isAiEnabled && cmd.includes('ai_review')) {
        props.command({ command: 'ai_review', args });
      } else {
        // Fallback for generic/plugin commands
        props.command({ command: cmd, args });
      }
    }
  };

  const cleanCmd = commandText.trim().toLowerCase();
  const isCommentCmd = cleanCmd === '/comment' || cleanCmd === 'comment';
  const isEpigraphCmd = cleanCmd === '/epigraph' || cleanCmd === 'epigraph';
  const isAiReviewCmd = isAiEnabled && cleanCmd.includes('ai_review') && !cleanCmd.includes('make_comments');
  const isAiOutlineCmd = isAiEnabled && cleanCmd.includes('ai_outline') && !cleanCmd.includes('whereami');
  const isAiOutlineWhereCmd = isAiEnabled && cleanCmd.includes('ai_outline/whereami');
  const isAiReviewCommentsCmd = isAiEnabled && cleanCmd.includes('ai_review/make_comments');
  const isAiListenCmd = isAiEnabled && cleanCmd.includes('ai_listen');

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: -10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: -10 }}
        className="z-[100] bg-[#1A1918] text-[#F1EDE4] border border-[#F1EDE4]/10 rounded-lg shadow-2xl overflow-hidden min-w-[240px] font-sans"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/15 bg-white/[0.02]">
          <div className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5 opacity-50" />
            <span className="text-[9px] uppercase tracking-[0.2em] font-bold opacity-30">Manuscript CLI</span>
          </div>
          <div className="text-[8px] px-1.5 py-0.5 rounded bg-white/10 opacity-40 font-mono">V1.0</div>
        </div>
        
        <div className="p-3">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/40 border border-white/15 mb-3 group focus-within:border-white/20 transition-colors">
            <span className="text-[#F1EDE4]/20 text-xs font-mono font-bold tracking-tighter shrink-0 select-none">#!</span>
            <input
              ref={inputRef}
              type="text"
              value={commandText}
              onChange={(e) => setCommandText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Command..."
              className="bg-transparent border-none outline-none text-xs font-mono flex-1 text-[#F1EDE4] placeholder:opacity-10"
            />
          </div>
          
          <div className="space-y-1">
            <div className={cn("flex items-center justify-between px-3 py-2 rounded-lg transition-all", isCommentCmd ? "bg-[#F1EDE4] text-black shadow-lg scale-[1.02]" : "opacity-30")}>
              <div className="flex items-center gap-3">
                <MessageSquare className="w-3.5 h-3.5" />
                <span className="text-[10px] uppercase font-bold tracking-widest">/COMMENT</span>
              </div>
            </div>

            <div className={cn("flex items-center justify-between px-3 py-2 rounded-lg transition-all", isEpigraphCmd ? "bg-[#F1EDE4] text-black shadow-lg scale-[1.02]" : "opacity-30")}>
              <div className="flex items-center gap-3">
                <Quote className="w-3.5 h-3.5" />
                <span className="text-[10px] uppercase font-bold tracking-widest">/EPIGRAPH</span>
              </div>
            </div>

            {isAiEnabled && (
              <>
                <div className={cn("flex items-center justify-between px-3 py-2 rounded-lg transition-all", isAiReviewCmd ? "bg-[#F1EDE4] text-black shadow-lg scale-[1.02]" : "opacity-30")}>
                  <div className="flex items-center gap-3">
                    <Sparkles className="w-3.5 h-3.5" />
                    <span className="text-[10px] uppercase font-bold tracking-widest">/AI_REVIEW</span>
                  </div>
                </div>

                <div className={cn("flex items-center justify-between px-3 py-2 rounded-lg transition-all", isAiOutlineCmd ? "bg-[#F1EDE4] text-black shadow-lg scale-[1.02]" : "opacity-30")}>
                  <div className="flex items-center gap-3">
                    <Wand2 className="w-3.5 h-3.5" />
                    <span className="text-[10px] uppercase font-bold tracking-widest">/AI_OUTLINE</span>
                  </div>
                </div>

                <div className={cn("flex items-center justify-between px-3 py-2 rounded-lg transition-all", isAiOutlineWhereCmd ? "bg-[#F1EDE4] text-black shadow-lg scale-[1.02]" : "opacity-30")}>
                  <div className="flex items-center gap-3">
                    <MapPin className="w-3.5 h-3.5" />
                    <span className="text-[10px] uppercase font-bold tracking-widest">/WHEREAMI</span>
                  </div>
                </div>

                <div className={cn("flex items-center justify-between px-3 py-2 rounded-lg transition-all", isAiReviewCommentsCmd ? "bg-[#F1EDE4] text-black shadow-lg scale-[1.02]" : "opacity-30")}>
                  <div className="flex items-center gap-3">
                    <MessageCircle className="w-3.5 h-3.5" />
                    <span className="text-[10px] uppercase font-bold tracking-widest">/MAKE_COMMENTS</span>
                  </div>
                </div>

                <div className={cn("flex items-center justify-between px-3 py-2 rounded-lg transition-all", isAiListenCmd ? "bg-[#F1EDE4] text-black shadow-lg scale-[1.02]" : "opacity-30")}>
                  <div className="flex items-center gap-3">
                    <Volume2 className="w-3.5 h-3.5" />
                    <span className="text-[10px] uppercase font-bold tracking-widest">/AI_LISTEN</span>
                  </div>
                </div>
              </>
            )}
            
            {!isCommentCmd && !isEpigraphCmd && !isAiReviewCmd && !isAiOutlineCmd && !isAiOutlineWhereCmd && !isAiReviewCommentsCmd && !isAiListenCmd && commandText.length > 0 && (
              <div className="px-3 py-2 text-[9px] opacity-20 italic">No command found</div>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
});
