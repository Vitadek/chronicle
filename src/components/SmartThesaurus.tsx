import React, { useState, useEffect, useCallback } from 'react';
import { Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Search, X, ChevronRight, Copy, Check, Bold, Italic, Underline, Sparkles, Volume2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

// A small offline "Creative Writer's Thesaurus" for common weak words
const OFFLINE_THESAURUS: Record<string, string[]> = {
  "said": ["whispered", "shouted", "muttered", "declared", "retorted", "gasped", "breathed", "confided"],
  "went": ["trudged", "sauntered", "dashed", "marched", "strolled", "crept", "hurried", "wandered"],
  "happy": ["elated", "jubilant", "radiant", "content", "delighted", "ecstatic", "beaming", "cheerful"],
  "sad": ["melancholy", "somber", "despairing", "wistful", "glum", "heartbroken", "dejected", "forlorn"],
  "big": ["monolithic", "towering", "vast", "immense", "colossal", "cavernous", "gargantuan", "massive"],
  "small": ["minuscule", "diminutive", "compact", "slight", "modest", "puny", "dwarfed", "minute"],
  "dark": ["shadowy", "obsidian", "murky", "inkwell", "gloomy", "pitch", "somber", "dim"],
  "light": ["luminescent", "radiant", "brilliant", "shimmering", "glowing", "dazzling", "phosphorescent"],
  "looked": ["gazed", "peered", "glanced", "scanned", "observed", "stared", "inspected", "spied"],
  "walked": ["ambled", "paced", "hiked", "trotted", "limped", "strutted", "meandered", "shuffled"],
  "cold": ["frigid", "biting", "frosty", "icy", "piercing", "chilly", "arctic", "wintry"],
  "hot": ["sweltering", "scorching", "blistering", "torrid", "stifling", "humid", "baking", "parched"],
  "very": ["exceptionally", "profoundly", "decidedly", "remarkably", "acutely", "exceedingly"],
  "beautiful": ["exquisite", "stunning", "arresting", "ethereal", "radiant", "breathtaking"],
  "scary": ["spine-chilling", "macabre", "ominous", "ghastly", "haunting", "forbidding"],
  "angry": ["infuriated", "livid", "incensed", "seething", "apoplectic", "choleric"],
  "quiet": ["hushed", "muted", "serene", "tranquil", "noiseless", "stilly"]
};

interface SmartThesaurusProps {
  editor: Editor | null;
  isDarkMode: boolean;
  pluginKey: string;
  /** Show AI Review and AI Listen buttons in the toolbar. */
  showAi?: boolean;
  /** Called when the user clicks the AI Review button in the bubble toolbar. */
  onAiReview?: () => void;
  /** Called when the user clicks the AI Listen button in the bubble toolbar. */
  onAiListen?: () => void;
  /** Whether thesaurus button is shown (existing setting). */
  showThesaurus?: boolean;
}

export const SmartThesaurus: React.FC<SmartThesaurusProps> = ({ editor, isDarkMode, pluginKey, showAi, onAiReview, onAiListen, showThesaurus = true }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [synonyms, setSynonyms] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleLookup = useCallback(async () => {
    if (!editor) return;
    
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, ' ');
    if (!text || text.trim().length === 0) return;

    setSelectedText(text.trim());
    setIsOpen(true);
    setSynonyms([]);
    
    const cleanText = text.trim().toLowerCase();
    
    if (OFFLINE_THESAURUS[cleanText]) {
      setSynonyms(OFFLINE_THESAURUS[cleanText]);
    } else {
      setSynonyms(["No common synonyms found offline."]);
    }
  }, [editor]);

  const handleReplace = (replacement: string) => {
    if (!editor) return;
    editor.chain().focus().insertContent(replacement).run();
    setIsOpen(false);
  };

  const handleCopy = (word: string, index: number) => {
    navigator.clipboard.writeText(word);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  if (!editor) return null;

  return (
    <>
      <BubbleMenu 
        editor={editor} 
        pluginKey={pluginKey}
        shouldShow={({ state, from, to }) => {
          return from !== to && state.doc.textBetween(from, to).trim().length > 0;
        }}
      >
        <motion.div 
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className={cn(
            // Explicit text color: icons inside inherit currentColor for their
            // stroke, and the default page color isn't reliable (the bubble
            // portals out of the editor in some layouts). Force a near-black
            // ink in light mode, cream in dark mode.
            "flex items-center gap-0.5 p-1 rounded-full border shadow-2xl backdrop-blur-md",
            isDarkMode
              ? "bg-[#232220]/95 border-white/10 text-[#F1EDE4]"
              : "bg-white/95 border-black/10 text-[#1A1A1A]"
          )}
        >
          <div className="flex items-center">
            <button
              onClick={() => editor.chain().focus().toggleBold().run()}
              className={cn(
                "p-2 rounded-full transition-colors",
                editor.isActive('bold') 
                  ? (isDarkMode ? "bg-white/10 text-white" : "bg-black/5 text-black") 
                  : "hover:bg-black/5 dark:hover:bg-white/5 opacity-60 hover:opacity-100"
              )}
            >
              <Bold className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleItalic().run()}
              className={cn(
                "p-2 rounded-full transition-colors",
                editor.isActive('italic') 
                  ? (isDarkMode ? "bg-white/10 text-white" : "bg-black/5 text-black") 
                  : "hover:bg-black/5 dark:hover:bg-white/5 opacity-60 hover:opacity-100"
              )}
            >
              <Italic className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleUnderline().run()}
              className={cn(
                "p-2 rounded-full transition-colors",
                editor.isActive('underline') 
                  ? (isDarkMode ? "bg-white/10 text-white" : "bg-black/5 text-black") 
                  : "hover:bg-black/5 dark:hover:bg-white/5 opacity-60 hover:opacity-100"
              )}
            >
              <Underline className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="w-px h-4 bg-current opacity-10 mx-1" />

          {showThesaurus && (
            <button
              onClick={handleLookup}
              className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors opacity-60 hover:opacity-100"
              title="Thesaurus"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          )}

          {showAi && onAiReview && (
            <button
              onClick={() => onAiReview()}
              className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors opacity-60 hover:opacity-100"
              title="AI Review the selection"
            >
              <Sparkles className="w-3.5 h-3.5" />
            </button>
          )}

          {showAi && onAiListen && (
            <button
              onClick={() => onAiListen()}
              className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors opacity-60 hover:opacity-100"
              title="Listen to the selection"
            >
              <Volume2 className="w-3.5 h-3.5" />
            </button>
          )}
        </motion.div>
      </BubbleMenu>

      <AnimatePresence>
        {isOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/20 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className={cn(
                "w-full max-w-sm rounded-3xl border shadow-2xl overflow-hidden",
                isDarkMode ? "bg-[#232220] border-white/10 text-white" : "bg-[#F4F1EA] border-black/10 text-black"
              )}
            >
              <div className="p-6 border-b border-current/5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2 opacity-40">
                    <Search className="w-4 h-4" />
                    <span className="text-[10px] uppercase tracking-widest font-bold">Thesaurus</span>
                  </div>
                  <button 
                    onClick={() => setIsOpen(false)}
                    className="p-2 rounded-full hover:bg-current/5 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div>
                  <h3 className="text-2xl font-serif italic mb-1">"{selectedText}"</h3>
                </div>
              </div>

              <div className="p-4 max-h-[300px] overflow-y-auto">
                <div className="grid grid-cols-1 gap-2">
                  {synonyms.map((word, i) => (
                    <div 
                      key={i}
                      className="group flex items-center justify-between p-3 rounded-xl hover:bg-current/5 transition-all cursor-pointer"
                      onClick={() => handleReplace(word)}
                    >
                      <div className="flex items-center gap-3">
                        <ChevronRight className="w-3 h-3 opacity-0 group-hover:opacity-100 -ml-2 transition-all" />
                        <span className="font-medium text-sm">{word}</span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopy(word, i);
                        }}
                        className="p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-current/10"
                      >
                        {copiedIndex === i ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-4 bg-current/5 flex items-center justify-center">
                <span className="text-[9px] uppercase tracking-widest opacity-30 font-bold">
                  Click a word to replace in text
                </span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
};
