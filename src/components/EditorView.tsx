import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { EditorContent, ReactRenderer } from '@tiptap/react';
import { useChronicleEditor, UseChronicleEditorProps } from '../hooks/useChronicleEditor';
import { SmartThesaurus } from './SmartThesaurus';
import { CommandPortal } from './CommandPortal';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { MessageSquare, Check, X, Sparkles, Loader2 } from 'lucide-react';
import { getAiResponse, getAiSpeech } from '../services/aiService';
import type { AiConfig } from '../services/aiConfig';
import { newAudioToken, registerAudioToken } from '../lib/Audio';
import { loadCoverBlobUrl } from '../services/coverService';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ActivePluginHost, usePlugins } from '../plugins/PluginManager';
import tippy, { delegate } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import 'tippy.js/animations/shift-away.css';

interface EditorViewProps {
  isDarkMode: boolean;
  onToggleTheme: () => void;
  manuscriptId: string;
  isTitlePage?: boolean;
  /** Cover image filename to display at the top of the title page. */
  coverArt?: string;
  isAutocompleteEnabled?: boolean;
  isThesaurusEnabled?: boolean;
  isZenModeEnabled?: boolean;
  /** Whether body paragraphs render with a first-line indent. SMF default. */
  isFirstLineIndentEnabled?: boolean;
  /** When false the AI agent menu (#!) is suppressed in the command portal. */
  isAiEnabled?: boolean;
  /** When true, AI Review and AI Listen show up in the selection bubble toolbar. */
  isAiBubbleMenuEnabled?: boolean;
  /** Touch UI: swap the floating selection bubble for a docked bottom bar. */
  isTouchUI?: boolean;
  /** Full AI config (provider + key + model). Null when AI isn't set up. */
  aiConfig?: AiConfig | null;
  isSidebarOpen: boolean;
  sceneBreakStyle: 'classic' | 'dots' | 'ornamental' | 'custom';
  customSceneBreakSvg?: string;
  lastModified: number;
  manuscriptFont: string;
  title: string;
  content: string;
  onUpdate: (title: string, content: string) => void;
  /**
   * Called when the AI Outline command produces a result. The parent stashes
   * the markdown so it can be rendered inside the sidebar Outline pane and
   * persists across overlay close.
   */
  onAiOutlineResult?: (markdown: string) => void;
  /** Called when an outline run starts so the Outline pane can show a spinner. */
  onAiOutlineLoadingChange?: (loading: boolean) => void;
  /** Hands the live TipTap editor up to the parent so the sidebar's
   *  Comments panel can read marks and apply edits in-place. */
  onEditorReady?: (editor: any) => void;
  className?: string;
}

export const EditorView: React.FC<EditorViewProps> = ({ 
  isDarkMode, 
  onToggleTheme, 
  manuscriptId,
  isTitlePage,
  coverArt,
  isAutocompleteEnabled,
  isThesaurusEnabled,
  isZenModeEnabled,
  isFirstLineIndentEnabled = true,
  isAiEnabled = true,
  isAiBubbleMenuEnabled = false,
  isTouchUI = false,
  aiConfig,
  isSidebarOpen,
  sceneBreakStyle,
  customSceneBreakSvg,
  lastModified,
  manuscriptFont,
  title,
  content, 
  onUpdate,
  onAiOutlineResult,
  onAiOutlineLoadingChange,
  onEditorReady,
  className 
}) => {
  const [isZenTriggered, setIsZenTriggered] = useState(false);
  const [isManualZen, setIsManualZen] = useState(false);
  const [lastActivity, setLastActivity] = useState(Date.now());
  const [wordCountAtWake, setWordCountAtWake] = useState(0);
  const [commentingAt, setCommentingAt] = useState<{ from: number; to: number; text: string } | null>(null);
  const [commentDraft, setCommentDraft] = useState('');

  const { getPluginContext, enabledPlugins } = usePlugins();

  // Listen for double-clicks on comment markers (dispatched from src/lib/Comment.ts)
  useEffect(() => {
    const handleEditComment = (e: any) => {
      const { from, to, comment, text } = e.detail;
      setCommentingAt({ from, to, text });
      setCommentDraft(comment || '');
    };
    window.addEventListener('edit-comment', handleEditComment);
    return () => window.removeEventListener('edit-comment', handleEditComment);
  }, []);

  const [aiResult, setAiResult] = useState<{ title: string; body: string } | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);
  // Title-page cover art — resolved lazily because the cover endpoint is
  // auth-gated so we can't put the filename directly into <img src=...>.
  const [titleCoverUrl, setTitleCoverUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!isTitlePage || !coverArt) {
      setTitleCoverUrl(null);
      return;
    }
    loadCoverBlobUrl(coverArt).then((url) => {
      if (!cancelled) setTitleCoverUrl(url);
    });
    return () => { cancelled = true; };
  }, [isTitlePage, coverArt]);

  const handleAiAction = async (command: string) => {
    if (!editor) return;
    if (!isAiEnabled) {
      // AI agent disabled in Settings — silently no-op so the keystroke
      // doesn't feel broken; the command portal already hides AI rows when
      // disabled, so this branch is only reached if a user types a path
      // directly without seeing the menu.
      return;
    }
    if (!aiConfig) {
      // AI is enabled but the user hasn't set provider/key/model yet.
      setAiResult({
        title: 'AI not configured',
        body: 'Open Settings → AI Agent and choose a provider, paste an API key, and pick a model before running AI commands.',
      });
      return;
    }

    // -------- TTS branch (separate from the text-generation pipeline) --------
    //
    // /ai_listen reads the user's selection (or the current paragraph if the
    // selection is collapsed) and posts it to /api/ai/speak. The resulting
    // audio blob is registered with a session-scoped token, and an AudioMark
    // is applied to the same text range so the play widget renders next to
    // it like a comment marker.
    if (command === 'ai_listen') {
      const { state } = editor;
      let { from, to } = state.selection;
      if (from === to) {
        // No selection — fall back to the current paragraph.
        const $pos = state.doc.resolve(from);
        from = $pos.start();
        to = $pos.end();
      }
      const text = state.doc.textBetween(from, to, '\n').trim();
      if (!text) {
        setAiResult({ title: 'Nothing to read', body: 'Place the cursor in a paragraph (or select some text) before running /ai_listen.' });
        return;
      }
      setIsAiLoading(true);
      try {
        const blobUrl = await getAiSpeech(text, aiConfig);
        const token = newAudioToken();
        registerAudioToken(token, blobUrl);
        // Apply the audio mark across the chosen range.
        editor.chain().focus().setTextSelection({ from, to }).setMark('audio', { token }).run();
        // Auto-play the first take so the user gets immediate feedback.
        try {
          const a = new Audio(blobUrl);
          a.play().catch(() => {});
        } catch { /* ignore */ }
      } catch (err: any) {
        setAiResult({
          title: 'Audio Failed',
          body: typeof err?.message === 'string' ? err.message : 'TTS request failed.',
        });
      } finally {
        setIsAiLoading(false);
      }
      return;
    }

    // -------- Text-generation branch --------
    // Outline goes to the sidebar pane, not the overlay. The overlay is
    // reserved for one-shot responses the author reads and dismisses; an
    // outline is a reference they keep returning to while writing.
    const isOutlineCommand = command === 'ai_outline';

    if (isOutlineCommand) {
      onAiOutlineLoadingChange?.(true);
    } else {
      setIsAiLoading(true);
    }

    window.dispatchEvent(new CustomEvent('chronicle:ai-start'));

    try {
      const fullDoc = editor.getText();
      const { $from } = editor.state.selection;
      const currentParagraph = $from.parent.textContent;

      let prompt = "";
      let title = "";

      /**
       * AI behaviour contract (shared across all four commands):
       *
       *  - Review and Comments are STRICTLY OBSERVATIONAL. They describe what
       *    the prose is doing and how it lands, never what the user "should"
       *    do differently. No rewrites, no edits, no "you could try…".
       *  - Outline is structural — it lays out beats or summarizes what's on
       *    the page. It does not propose new scenes or rewrites.
       *  - Story Arc Analysis is positional — where the manuscript sits in a
       *    standard narrative arc. It does not advise on next steps.
       *
       * The "DO NOT" lines are deliberately blunt and repeated because models
       * default to being helpful by suggesting improvements; we override that
       * default explicitly. We also include positive framings so the model
       * has a clear target to aim at rather than just a list of refusals.
       */
      const SHARED_RULES = `
  RULES (strict):
  - Do NOT suggest any changes, edits, rewrites, or alternative wordings.
  - Do NOT offer "revised versions," "polished versions," or example rewrites.
  - Do NOT use phrases like "you could," "consider," "try," "I would suggest," "you might want to," or "to improve."
  - Do NOT propose new scenes, lines, or content.
  - If asked to evaluate, only describe what is present and how it reads.
  - Quote short phrases from the text when illustrating a point — never replace them with your own wording.
  `.trim();

      switch (command) {
        case 'ai_review':
          title = "AI Prose Review";
          prompt = `You are reviewing a manuscript excerpt. Describe what the prose is doing — its rhythm, tone, imagery, pacing, point of view, and how the active paragraph functions in context. Treat this as a reader's report, not an editor's notes.

  ${SHARED_RULES}

  Additional rules for this mode:
  - Pure observation only. No recommendations, no "stronger if…" framings.
  - Sections to cover, each in 2-4 sentences:
  1. Voice and tone
  2. Flow and rhythm
  3. Imagery and sensory work
  4. How the active paragraph reads in context
  - End with a short note on what the paragraph appears to be doing for the story — again as observation, not advice.

  FULL MANUSCRIPT:
  ${fullDoc.substring(0, 5000)}${fullDoc.length > 5000 ? '\n[...manuscript continues...]' : ''}

  ACTIVE PARAGRAPH:
  ${currentParagraph}`;
          break;

        case 'ai_outline':
          title = "Plot Outline";
          prompt = `Produce a structured outline of what is already written in the manuscript below. This is a descriptive outline of existing material, not a plan for future material.

  ${SHARED_RULES}

  Additional rules for this mode:
  - Outline ONLY what is on the page. Do not invent or propose scenes that aren't written.
  - Use the following structure:
  - **Premise**: one or two sentences capturing what the manuscript is about so far.
  - **Beats**: a numbered list of the major story beats present in the text, in order. Each beat: one short sentence.
  - **Characters introduced**: bulleted list with one-line descriptions drawn from the text.
  - **Open threads**: bulleted list of questions or tensions the text has raised but not yet resolved. (Just naming them, not advising how to resolve them.)

  MANUSCRIPT:
  ${fullDoc}`;
          break;

        case 'ai_outline_whereami':
          title = "Story Arc Analysis";
          prompt = `Locate the manuscript within a standard narrative arc. This is a positional analysis, not advice.

  ${SHARED_RULES}

  Additional rules for this mode:
  - Identify which phase the manuscript currently sits in: Exposition / Inciting Incident / Rising Action / Midpoint / Crisis / Climax / Falling Action / Resolution.
  - Explain your reasoning by pointing to specific moments in the text.
  - Optionally note which phase elements (if any) appear to still be active or already complete.
  - Do NOT advise what should happen next.

  MANUSCRIPT:
  ${fullDoc}`;
          break;

        case 'ai_review_make_comments':
          title = "Reader Comments";
          prompt = `Read the manuscript below as a thoughtful reader and leave comments on how passages SOUND and FEEL. These are reader reactions, not editorial notes.

  ${SHARED_RULES}

  Additional rules for this mode:
  - Comments are about the EXPERIENCE of reading: what a passage evokes, what mood it sets, what attention it pulls, what questions it raises.
  - Do NOT flag grammar, punctuation, tense, plot holes, or inconsistencies. That is editing — different job.
  - Do NOT propose alternative phrasings, rewrites, or "stronger" versions of anything.
  - Do NOT say a passage is "weak," "needs work," "would benefit from…" or similar. Describe; do not prescribe.
  - Format each comment as:

  > [short quoted phrase from the text, ≤12 words]

  One or two sentences describing how this lands as a reader — the feel, the resonance, the texture. No "you should" anywhere.

  - Aim for 5-10 comments spread across the manuscript.

  MANUSCRIPT:
  ${fullDoc}`;
          break;
      }

      const response = await getAiResponse(prompt, aiConfig);

      /**
       * The OpenAI Responses API wraps its output in a typed array:
       *   { output: [ { type: 'reasoning', ... }, { type: 'message', content: [{ type: 'output_text', text: '...' }] } ] }
       *
       * Walk the array looking for a message block's output_text. Fall back
       * to older Chat Completions shape and then raw JSON so nothing is silent.
       */
      const extractText = (data: any): string => {
        if (!data) return "No response received.";

        // Responses API: data.output is an array of typed blocks
        if (Array.isArray(data.output)) {
          for (const block of data.output) {
            if (block.type === 'message' && Array.isArray(block.content)) {
              for (const chunk of block.content) {
                if (chunk.type === 'output_text' && typeof chunk.text === 'string') {
                  return chunk.text;
                }
              }
            }
          }
        }

        // Chat Completions API: data.choices[0].message.content
        if (Array.isArray(data.choices) && data.choices[0]?.message?.content) {
          return data.choices[0].message.content;
        }

        // Already a plain string
        if (typeof data === 'string') return data;

        // Last resort — show raw so it's obvious something changed in the API
        return JSON.stringify(data, null, 2);
      };

      const bodyText = extractText(response);
      if (isOutlineCommand) {
        onAiOutlineResult?.(bodyText);
      } else {
        setAiResult({ title, body: bodyText });
      }
    } catch (error: any) {
      let errorMessage = error.message || "An unexpected error occurred.";

      // Friendly message for quota issues
      if (typeof errorMessage === 'string' && errorMessage.toLowerCase().includes("quota")) {
        errorMessage = "OpenAI Quota Exceeded: Your API key has run out of credits or reached its limit. Please check your OpenAI billing dashboard.";
      }

      // For outline failures, surface in the overlay since the sidebar pane
      // doesn't have an error UI of its own.
      setAiResult({ 
        title: isOutlineCommand ? "Outline Failed" : "AI Action Failed", 
        body: typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage)
      });
    } finally {
      if (isOutlineCommand) {
        onAiOutlineLoadingChange?.(false);
      } else {
        setIsAiLoading(false);
      }
      window.dispatchEvent(new CustomEvent('chronicle:ai-end'));
    }
  };

  // The CommandPortal closure is created once when the editor mounts and
  // captured inside the CommandLine extension. We can't rebuild extensions
  // on toggle (TipTap doesn't reload them), so we read isAiEnabled from a
  // ref that's always current.
  const isAiEnabledRef = useRef(isAiEnabled);
  useEffect(() => {
    isAiEnabledRef.current = isAiEnabled;
  }, [isAiEnabled]);

  const commandLineOptions = useMemo(() => ({
    render: () => {
      let component: any;
      let popup: any;

      return {
        onStart: (props: any) => {
          component = new ReactRenderer(CommandPortal, {
            props: {
              ...props,
              // Read live so toggling AI off/on takes effect immediately.
              isAiEnabled: isAiEnabledRef.current,
              command: async ({ command, args }: { command: string, args: string[] }) => {
                const { editor, range } = props;

                // Check for Plugin Commands first
                for (const pluginId of Array.from(enabledPlugins)) {
                  const manifest = PLUGIN_REGISTRY.find(p => p.id === pluginId);
                  if (manifest?.portalCommands?.[command]) {
                    popup[0].hide();
                    editor.commands.deleteRange(range);
                    const context = getPluginContext(pluginId, editor, manuscriptId);
                    await manifest.portalCommands[command](context, args);
                    return;
                  }
                }

                if (command === 'comment') {
                  // Hide popup immediately
                  popup[0].hide();

                  // Get paragraph content before clearing the command
                  const { $from } = editor.state.selection;
                  // We extract the current selection's parent text
                  const rawText = $from.parent.textContent;
                  // Clean #!/comment or #!command from the reference text
                  const parentContent = rawText.replace(/#!(\/)?comment/gi, '').trim();

                  // The range for the comment is the whole parent block minus the command
                  const from = $from.start();
                  const to = $from.end();

                  // Clean up the command characters in the editor
                  editor.commands.deleteRange(range);

                  // Open commentary UI
                  setCommentingAt({ from, to, text: parentContent || "this paragraph" });
                  setCommentDraft('');
                } else if (command === 'epigraph') {
                  popup[0].hide();
                  editor.chain()
                    .focus()
                    .deleteRange(range)
                    .setEpigraph()
                    .run();
                } else if (command.startsWith('ai_')) {
                  popup[0].hide();
                  editor.commands.deleteRange(range);
                  handleAiAction(command);
                }
              }
            },
            editor: props.editor,
          });

          popup = tippy('body', {
            getReferenceClientRect: props.clientRect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-start',
            zIndex: 100,
          });
        },
        onUpdate(props: any) {
          component.updateProps({
            ...props,
            isAiEnabled: isAiEnabledRef.current,
            command: async ({ command, args }: { command: string, args: string[] }) => {
              const { editor, range } = props;

              // Check for Plugin Commands first
              for (const pluginId of Array.from(enabledPlugins)) {
                const manifest = PLUGIN_REGISTRY.find(p => p.id === pluginId);
                if (manifest?.portalCommands?.[command]) {
                  popup[0].hide();
                  editor.commands.deleteRange(range);
                  const context = getPluginContext(pluginId, editor, manuscriptId);
                  await manifest.portalCommands[command](context, args);
                  return;
                }
              }

              if (command === 'comment') {
                popup[0].hide();

                const { $from } = editor.state.selection;
                const rawText = $from.parent.textContent;
                const parentContent = rawText.replace(/#!(\/)?comment/gi, '').trim();
                const from = $from.start();
                const to = $from.end();

                editor.commands.deleteRange(range);
                setCommentingAt({ from, to, text: parentContent || "this paragraph" });
                setCommentDraft('');
              } else if (command === 'epigraph') {
                popup[0].hide();
                editor.chain()
                  .focus()
                  .deleteRange(range)
                  .setEpigraph()
                  .run();
              } else if (command.startsWith('ai_')) {
                popup[0].hide();
                editor.commands.deleteRange(range);
                handleAiAction(command);
              }
            }
          });
          popup[0].setProps({
            getReferenceClientRect: props.clientRect,
          });
        },
        onKeyDown(props: any) {
          if (props.event.key === 'Escape') {
            popup[0].hide();
            return true;
          }
          return component.ref?.onKeyDown(props);
        },
        onExit() {
          popup[0].destroy();
          component.destroy();
        },
      };
    },
  }), []);

  const titleEditor = useChronicleEditor({
    content: `<h1>${title}</h1>`,
    placeholder: isTitlePage ? 'Manuscript Title' : 'Chapter Title',
    className: cn('novel-title-editor focus:outline-none mb-12', isTitlePage && 'text-center text-4xl sm:text-6xl'),
    isAutocompleteEnabled,
    onUpdate: (html) => {
      const text = html.replace(/<[^>]*>?/gm, '').trim();
      onUpdate(text, content);
      setLastActivity(Date.now());
    }
  });

  const editor = useChronicleEditor({
    content: isTitlePage ? (content.includes('<p>') ? content : `<p>${content}</p>`) : content,
    placeholder: isTitlePage ? 'Author Name' : 'Once upon a time in...',
    className: cn('novel-editor-content focus:outline-none', !isTitlePage && 'min-h-[500px]', isTitlePage && 'text-center text-2xl'),
    isAutocompleteEnabled,
    commandLineOptions,
    onUpdate: (html) => {
      onUpdate(title, isTitlePage ? html.replace(/<[^>]*>?/gm, '').trim() : html);
      setLastActivity(Date.now());
    }
  });

  // Bubble the editor up to App so the sidebar's Comments panel can read
  // and edit its marks. Cleanup on unmount clears the ref so a defunct
  // editor doesn't linger.
  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  const words = (titleEditor?.storage.characterCount.words() || 0) + (editor?.storage.characterCount.words() || 0);

  // Zenith Trigger Effect: Only trigger after 3 words have been typed
  useEffect(() => {
    if (words - wordCountAtWake >= 3 && !isZenTriggered && words > 0) {
      setIsZenTriggered(true);
    }
  }, [words, wordCountAtWake, isZenTriggered]);

  // Bring back UI on interactions (Click/Tap)
  useEffect(() => {
    const wakeUp = (e: MouseEvent | TouchEvent | Event) => {
      // Ignore clicks if they are inside a Tippy popup or on a comment widget
      const target = e.target as HTMLElement;
      if (!target || typeof target.closest !== 'function') return;

      const isInsideTippy = target.closest('[data-tippy-root]');
      const isCommentWidget = target.closest('.comment-icon-widget');

      if (isInsideTippy || isCommentWidget) {
        return;
      }

      setLastActivity(Date.now());
      if (isZenTriggered) {
        setTimeout(() => {
          setIsZenTriggered(false);
          setWordCountAtWake(words);
        }, 50);
      }
    };

    window.addEventListener('mousedown', wakeUp as any, true);
    window.addEventListener('touchstart', wakeUp as any, true);
    window.addEventListener('scroll', wakeUp as any, true);

    return () => {
      window.removeEventListener('mousedown', wakeUp as any, true);
      window.removeEventListener('touchstart', wakeUp as any, true);
      window.removeEventListener('scroll', wakeUp as any, true);
    };
  }, [isZenTriggered, words]);

  useEffect(() => {
    if (!editor) return;

    // TTS audio widgets are still using Tippy delegation.
    // Comment icons handle their own dblclick events in src/lib/Comment.ts
    // to avoid the top-left positioning glitch.
    const instance = delegate('body', {
      target: '.audio-icon-widget',
      trigger: 'mouseenter click',
      interactive: true,
      zIndex: 9999,
      offset: [0, 10],
      content: (reference) => {
        // ... audio widget logic stays the same if needed ...
        return document.createElement('div'); // Simplified placeholder
      },
      placement: 'top',
      theme: 'manuscript',
      animation: 'shift-away',
      appendTo: () => document.body,
    });

    return () => {
      if (instance) {
        if (Array.isArray(instance)) {
          instance.forEach(i => i.destroy());
        } else if (typeof (instance as any).destroy === 'function') {
          (instance as any).destroy();
        }
      }
    };
  }, [editor]);

  // Sync content on chapter switch
  useEffect(() => {
    if (editor) {
      if (isTitlePage) {
        const currentText = editor.getText().trim();
        if (currentText !== content.trim()) {
          editor.commands.setContent(`<p>${content}</p>`);
        }
      } else if (content !== editor.getHTML()) {
        editor.commands.setContent(content);
      }
    }
  }, [content, editor, isTitlePage]);

  useEffect(() => {
    if (titleEditor) {
      const currentText = titleEditor.getText().trim();
      const targetText = title.trim();
      
      if (currentText !== targetText) {
        titleEditor.commands.setContent(`<h1>${title}</h1>`);
      }
    }
  }, [title, titleEditor, isTitlePage]);

  useEffect(() => {
    const timer = setInterval(() => {
      // If idle for 10s, wake up and reset word count to prevent immediate re-trigger
      if (Date.now() - lastActivity > 10000 && isZenTriggered) {
        setIsZenTriggered(false);
        setWordCountAtWake(words);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [lastActivity, isZenTriggered, words]);


  const isZenActive = isZenModeEnabled && isZenTriggered;

  useEffect(() => {
    if (isZenActive) {
      document.body.classList.add('zen-active');
    } else {
      document.body.classList.remove('zen-active');
    }
  }, [isZenActive]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsManualZen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className={cn(
      "flex flex-col items-center w-full min-h-screen transition-all duration-1000",
      `scene-break-${sceneBreakStyle}`,
      className
    )}>
      <style>
        {`
          :root {
            --scene-break-style: "${sceneBreakStyle}";
            --custom-scene-break-svg: url("${customSceneBreakSvg || ''}");
          }
        `}
      </style>
      {/* Meta Tag: Last Write Wins Tracker */}
      <div 
        className="fixed top-2 right-8 z-[60] text-[9px] font-mono pointer-events-none select-none opacity-[0.1] hover:opacity-100 transition-opacity flex flex-col items-end"
      >
        <span className="tracking-widest">TS_{lastModified}</span>
        <span className="opacity-50 uppercase">{new Date(lastModified).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
      </div>

      <div 
        className="w-full flex-1 transition-all duration-700 manuscript-content-box"
      >
        <div className={cn(
          "novel-editor w-full h-full max-w-5xl mx-auto px-6 sm:px-10 md:px-0",
          isTitlePage ? "py-64" : "py-32",
          isFirstLineIndentEnabled && "indent"
        )}>
          {/* Title page hero: shows the uploaded cover art above the
              title fields. Sized to feel like a book cover, with a soft
              shadow. Falls back to nothing when no cover is uploaded. */}
          {isTitlePage && titleCoverUrl && (
            <div className="mb-16 flex justify-center" data-outline="cover">
              <img
                src={titleCoverUrl}
                alt="Manuscript cover"
                className="rounded-2xl shadow-2xl max-h-[60vh] max-w-[18rem] object-contain"
              />
            </div>
          )}
          <div data-outline="title">
            <EditorContent 
              editor={titleEditor} 
              className="w-full"
            />
            {(isThesaurusEnabled || (isAiBubbleMenuEnabled && isAiEnabled)) && (
              <SmartThesaurus
                editor={titleEditor}
                isDarkMode={isDarkMode}
                pluginKey="titleThesaurus"
                isTouchUI={isTouchUI}
                showThesaurus={isThesaurusEnabled}
                showAi={isAiBubbleMenuEnabled && isAiEnabled}
                onAiReview={() => handleAiAction('ai_review')}
                onAiListen={() => handleAiAction('ai_listen')}
              />
            )}
          </div>
          {isTitlePage && (
            <div className="my-12 opacity-20 font-serif italic text-xl text-center">by</div>
          )}
          <div data-outline="content">
            <EditorContent 
              editor={editor} 
              className="w-full"
            />
            {(isThesaurusEnabled || (isAiBubbleMenuEnabled && isAiEnabled)) && (
              <SmartThesaurus
                editor={editor}
                isDarkMode={isDarkMode}
                pluginKey="contentThesaurus"
                isTouchUI={isTouchUI}
                showThesaurus={isThesaurusEnabled}
                showAi={isAiBubbleMenuEnabled && isAiEnabled}
                onAiReview={() => handleAiAction('ai_review')}
                onAiListen={() => handleAiAction('ai_listen')}
              />
            )}

            {/* Plugin Layer */}
            {editor && !isTitlePage && (
              <ActivePluginHost editor={editor} manuscriptId={manuscriptId} aiConfig={aiConfig} />
            )}

            {/* Inline Comment Entry UI */}
            <AnimatePresence>
              {commentingAt && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  className="mt-8 p-6 rounded-2xl bg-[#1A1918] border border-white/10 shadow-[0_32px_64px_-16px_rgba(0,0,0,0.5)] z-[70] max-w-xl mx-auto overflow-hidden relative"
                >
                  {/* Decorative background glow */}
                  <div className="absolute top-0 left-0 w-32 h-32 bg-white/5 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2 pointer-events-none" />
                  
                  <div className="relative z-10">
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-white/5 border border-white/10">
                          <MessageSquare className="w-4 h-4 text-[#F1EDE4]" />
                        </div>
                        <div>
                          <h4 className="text-[10px] uppercase tracking-[0.2em] font-bold text-[#F1EDE4] opacity-40">Prose Commentary</h4>
                          <p className="text-[9px] opacity-20 italic">Annotating current paragraph</p>
                        </div>
                      </div>
                      <button 
                        onClick={() => setCommentingAt(null)}
                        className="p-1.5 rounded-full hover:bg-white/5 transition-colors opacity-30 hover:opacity-100"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <textarea
                      autoFocus
                      value={commentDraft}
                      onChange={(e) => setCommentDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.ctrlKey) {
                          e.preventDefault();
                          const { from, to } = commentingAt;
                          editor?.chain()
                            .focus()
                            .setTextSelection({ from, to })
                            .setMark('comment', { comment: commentDraft })
                            .setTextSelection(to)
                            .run();
                          setCommentingAt(null);
                        }
                        if (e.key === 'Escape') {
                          setCommentingAt(null);
                        }
                      }}
                      placeholder="Capture your thoughts..."
                      className="w-full bg-white/[0.03] border border-white/5 rounded-xl p-4 text-sm text-[#F1EDE4] placeholder:opacity-20 focus:outline-none focus:border-white/20 min-h-[160px] mb-6 transition-all duration-300 font-serif resize-none leading-relaxed"
                    />

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-1.5 opacity-20">
                          <kbd className="px-1 py-0.5 rounded bg-white/10 text-[8px] font-mono border border-white/5">CTRL</kbd>
                          <span className="text-[8px] font-bold">+</span>
                          <kbd className="px-1 py-0.5 rounded bg-white/10 text-[8px] font-mono border border-white/5">ENTER</kbd>
                        </div>
                        <span className="text-[8px] opacity-20 uppercase tracking-widest font-bold">To confirm</span>
                      </div>

                      <div className="flex items-center gap-3">
                        <button 
                          onClick={() => {
                            const { from, to } = commentingAt;
                            editor?.chain()
                              .focus()
                              .setTextSelection({ from, to })
                              .unsetMark('comment')
                              .setTextSelection(to)
                              .run();
                            setCommentingAt(null);
                          }}
                          className="px-4 py-2 rounded-xl text-[10px] uppercase font-bold tracking-widest text-red-500/60 hover:text-red-500 transition-colors"
                        >
                          Remove
                        </button>
                        <button 
                          onClick={() => setCommentingAt(null)}
                          className="px-4 py-2 rounded-xl text-[10px] uppercase font-bold tracking-widest opacity-40 hover:opacity-100 transition-opacity"
                        >
                          Cancel
                        </button>
                        <button 
                          onClick={() => {
                            const { from, to } = commentingAt;
                            editor?.chain()
                              .focus()
                              .setTextSelection({ from, to })
                              .setMark('comment', { comment: commentDraft })
                              .setTextSelection(to)
                              .run();
                            setCommentingAt(null);
                          }}
                          className="flex items-center gap-2 px-6 py-2 rounded-xl bg-[#F1EDE4] text-black text-[10px] uppercase font-bold tracking-widest hover:bg-white hover:scale-[1.02] active:scale-[0.98] transition-all"
                        >
                          <Check className="w-3.5 h-3.5" />
                          Save Annotation
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* AI Result Overlay */}
      <AnimatePresence>
        {(isAiLoading || aiResult) && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-[#1A1918] border border-white/10 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl"
            >
              <div className="px-8 py-6 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-white/5">
                    <Sparkles className="w-4 h-4 text-[#F1EDE4]" />
                  </div>
                  <h3 className="text-sm font-bold uppercase tracking-widest text-[#F1EDE4]">
                    {isAiLoading ? "Consulting AI Agent..." : aiResult?.title}
                  </h3>
                </div>
                {!isAiLoading && (
                  <button 
                    onClick={() => setAiResult(null)}
                    className="p-1 rounded-full hover:bg-white/5 transition-colors"
                  >
                    <X className="w-4 h-4 text-white/40" />
                  </button>
                )}
              </div>
              
              <div className="p-8 max-h-[60vh] overflow-y-auto">
                {isAiLoading ? (
                  <div className="flex flex-col items-center justify-center py-12 space-y-4">
                    <Loader2 className="w-8 h-8 animate-spin text-white/20" />
                    <p className="text-xs uppercase tracking-widest font-bold opacity-20">Analyzing Manuscript...</p>
                  </div>
                ) : (
                  <MarkdownRenderer
                    text={aiResult?.body ?? ''}
                    theme="dark"
                    className="font-roboto text-sm leading-relaxed"
                  />
                )}
              </div>

              {!isAiLoading && (
                <div className="px-8 py-6 bg-black/20 flex justify-end">
                  <button 
                    onClick={() => setAiResult(null)}
                    className="px-6 py-2 rounded-xl bg-[#F1EDE4] text-black text-[10px] uppercase font-bold tracking-widest hover:bg-white transition-all shadow-lg"
                  >
                    Back to Writing
                  </button>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
};

