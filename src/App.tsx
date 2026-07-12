import { useState, useEffect, useCallback, useMemo } from 'react';
import { Sidebar } from './components/Sidebar';
import { EditorView } from './components/EditorView';
import type { TenseShiftHit } from './lib/TenseShift';
import type { GrammarMark } from './lib/Grammar';
import { LibraryView } from './components/LibraryView';
import { GlobalSettings } from './components/GlobalSettings';
import { PluginProvider } from './plugins/PluginManager';
import { manuscriptService } from './services/manuscriptService';
import { startSync } from './services/syncService';
import {
  AiConfig,
  loadAiConfig,
  saveAiConfig,
  clearAiConfig,
  defaultAiConfig,
  type AiProvider,
} from './services/aiConfig';
import {
  fetchAiServerConfig,
  revalidateAiKeys,
  type ProviderStatus,
} from './services/aiService';
import { cn } from './lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { Chapter, ManuscriptMetadata, UserProfile, Manuscript, Character, PlotNode, PlotEdge, ExportSettings, DEFAULT_EXPORT_SETTINGS } from './types';
import { countWords } from './lib/wordCount';
import type { Editor } from '@tiptap/react';

export default function App() {
  const [currentManuscriptId, setCurrentManuscriptId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    return localStorage.getItem('chronicle_theme') === 'dark';
  });
  const [manuscriptFont, setManuscriptFont] = useState(() => {
    return localStorage.getItem('chronicle_manuscript_font') || 'Verdana';
  });
  const [isAutocompleteEnabled, setIsAutocompleteEnabled] = useState(() => {
    return localStorage.getItem('chronicle_autocomplete') !== 'false';
  });
  const [isTenseCheckEnabled, setIsTenseCheckEnabled] = useState(() => {
    return localStorage.getItem('chronicle_tense_check') === 'true';
  });
  const [isGrammarCheckEnabled, setIsGrammarCheckEnabled] = useState(() => {
    return localStorage.getItem('chronicle_grammar_check') === 'true';
  });
  const [isAutoCorrectEnabled, setIsAutoCorrectEnabled] = useState(() => {
    return localStorage.getItem('chronicle_autocorrect') !== 'false';
  });
  const [isIssuesPanelEnabled, setIsIssuesPanelEnabled] = useState(() => {
    return localStorage.getItem('chronicle_issues_panel') === 'true';
  });
  const [tenseHits, setTenseHits] = useState<TenseShiftHit[]>([]);
  const [grammarMarks, setGrammarMarks] = useState<GrammarMark[]>([]);
  const [isThesaurusEnabled, setIsThesaurusEnabled] = useState(() => {
    return localStorage.getItem('chronicle_thesaurus') !== 'false';
  });
  const [isZenModeEnabled, setIsZenModeEnabled] = useState(() => {
    return localStorage.getItem('chronicle_zen_mode') === 'true';
  });
  const [isFirstLineIndentEnabled, setIsFirstLineIndentEnabled] = useState(() => {
    // Default ON — Standard Manuscript Format convention.
    return localStorage.getItem('chronicle_first_line_indent') !== 'false';
  });
  const [isAiEnabled, setIsAiEnabled] = useState(() => {
    // Default OFF — opt-in. Users who want AI flip it on in Settings.
    return localStorage.getItem('chronicle_ai_enabled') === 'true';
  });
  // Per-format export preferences (HTML theme, Hugo markdown front matter,
  // EPUB rights/cover). Merged over defaults so a stored partial from an older
  // build still yields a complete, well-shaped settings object.
  const [exportSettings, setExportSettings] = useState<ExportSettings>(() => {
    try {
      const raw = localStorage.getItem('chronicle_export_settings');
      if (!raw) return DEFAULT_EXPORT_SETTINGS;
      const parsed = JSON.parse(raw);
      return {
        html: { ...DEFAULT_EXPORT_SETTINGS.html, ...parsed.html },
        markdown: { ...DEFAULT_EXPORT_SETTINGS.markdown, ...parsed.markdown },
        epub: { ...DEFAULT_EXPORT_SETTINGS.epub, ...parsed.epub },
      };
    } catch {
      return DEFAULT_EXPORT_SETTINGS;
    }
  });

  /**
   * Touch-controls mode: 'auto' follows the device's pointer type, 'on'/'off'
   * are manual overrides for when detection is wrong (some Android browsers,
   * hybrid devices). Drives the `touch-ui` class on <html>, which all
   * touch-specific styling and the editor's selection toolbar key off.
   */
  const [touchControlsMode, setTouchControlsMode] = useState<'auto' | 'on' | 'off'>(() => {
    const v = localStorage.getItem('chronicle_touch_controls');
    return v === 'on' || v === 'off' ? v : 'auto';
  });
  const [coarsePointer, setCoarsePointer] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(pointer: coarse)');
    const onChange = (e: MediaQueryListEvent) => setCoarsePointer(e.matches);
    // addEventListener is the modern API; older Safari used addListener.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, []);
  const isTouchUI =
    touchControlsMode === 'on' || (touchControlsMode === 'auto' && coarsePointer);
  useEffect(() => {
    localStorage.setItem('chronicle_touch_controls', touchControlsMode);
  }, [touchControlsMode]);
  useEffect(() => {
    document.documentElement.classList.toggle('touch-ui', isTouchUI);
  }, [isTouchUI]);

  const [isAiBubbleMenuEnabled, setIsAiBubbleMenuEnabled] = useState(() => {
    return localStorage.getItem('chronicle_ai_bubble_menu') === 'true';
  });

  /**
   * The single source of truth for AI: provider, key, current model, and
   * the user's custom-model lists. Null until the user fills in the wizard
   * (or, before they do, with `isAiEnabled=false` we never call the proxy
   * anyway). Persisted in localStorage by saveAiConfig().
   */
  const [aiConfig, setAiConfigState] = useState<AiConfig | null>(() => loadAiConfig());
  const updateAiConfig = useCallback((next: AiConfig | null) => {
    setAiConfigState(next);
    if (next) saveAiConfig(next);
    else clearAiConfig();
  }, []);

  /**
   * Server probe: which AI providers does the backend have keys for? Falls
   * back to undefined while in flight; the Settings panel treats that as
   * "assume available" (no warning UI). Updated on mount and refreshable
   * via Settings → Re-check.
   */
  const [serverAiProviders, setServerAiProviders] = useState<Partial<Record<AiProvider, ProviderStatus>> | undefined>(undefined);
  const [serverAiAvailable, setServerAiAvailable] = useState<boolean | undefined>(undefined);
  // AI_UI=off on the server strips every AI surface from the UI (a "purist"
  // deployment). Seeded from the last server answer so an AI_UI=off install
  // doesn't flash AI UI while /api/ai/config is in flight, and doesn't fail
  // open if that one request hiccups. First-ever visit defaults to visible.
  const [isAiUiHidden, setIsAiUiHidden] = useState(() => {
    return localStorage.getItem('chronicle_ai_ui_hidden') === 'true';
  });

  const loadAiServerConfig = useCallback(async () => {
    const cfg = await fetchAiServerConfig();
    if (!cfg) return;
    // `=== false` (not `!uiEnabled`): older servers omit the field entirely,
    // and they must keep defaulting to visible.
    const hidden = cfg.uiEnabled === false;
    setIsAiUiHidden(hidden);
    localStorage.setItem('chronicle_ai_ui_hidden', String(hidden));
    setServerAiProviders(cfg.providers);
    // "AI available" = at least one provider is configured AND its key
    // either passed validation or hasn't been checked yet.
    const usable = (Object.values(cfg.providers) as ProviderStatus[]).some(
      (p) => p.configured && (p.state === 'ok' || p.state === 'unchecked'),
    );
    setServerAiAvailable(usable);
  }, []);

  useEffect(() => {
    void loadAiServerConfig();
  }, [loadAiServerConfig]);

  const handleRevalidateAi = useCallback(async () => {
    await revalidateAiKeys();
    await loadAiServerConfig();
  }, [loadAiServerConfig]);

  // AI outline output — renders inside the sidebar's Outline pane rather
  // than the editor's overlay. Persisted to localStorage so the author can
  // refer back to it across sessions while working on the same manuscript.
  const [aiOutlineMarkdown, setAiOutlineMarkdown] = useState<string>(() => {
    return localStorage.getItem('chronicle_ai_outline') || '';
  });
  const [isAiOutlineLoading, setIsAiOutlineLoading] = useState(false);

  const [userProfile, setUserProfile] = useState<UserProfile>(() => {
    const saved = localStorage.getItem('chronicle_user_profile');
    if (saved) return JSON.parse(saved);
    return { name: '', address: '', phone: '', email: '' };
  });

  const [metadata, setMetadata] = useState<ManuscriptMetadata | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [currentChapterId, setCurrentChapterId] = useState<string>('');

  // Outline-pane state: characters, plot nodes, plot edges.
  // Persisted per-manuscript in localStorage for now — proper sync support
  // is a follow-up. Keyed by manuscript id so switching books shows the
  // right set.
  const [characters, setCharacters] = useState<Character[]>([]);
  const [plotNodes, setPlotNodes] = useState<PlotNode[]>([]);
  const [plotEdges, setPlotEdges] = useState<PlotEdge[]>([]);

  // Live editor instance for the open chapter. CommentsPanel walks this
  // doc to extract marks; we receive it via a callback from EditorView.
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);

  // Global settings visibility
  const [isGlobalSettingsOpen, setIsGlobalSettingsOpen] = useState(false);

  // Signal that bumps whenever a remote sync delivers fresh data. The
  // LibraryView watches this to reload its manuscript list, and the editor
  // re-fetches the current manuscript if it's affected.
  const [remoteRevision, setRemoteRevision] = useState(0);

  // Start the background sync loop on mount. Pull every 30s plus on focus
  // and network reconnect. When something changes, bump remoteRevision so
  // any open view refreshes itself from the (now-updated) server state.
  useEffect(() => {
    const stop = startSync({
      onPull: (resp) => {
        const touched =
          resp.pull.manuscripts.length +
          resp.pull.chapters.length +
          (resp.pull.profile ? 1 : 0);
        if (touched > 0) setRemoteRevision((n) => n + 1);
      },
    });
    return stop;
  }, []);

  // Load manuscript from server
  useEffect(() => {
    if (!currentManuscriptId) {
      setMetadata(null);
      setChapters([]);
      setCurrentChapterId('');
      setCharacters([]);
      setPlotNodes([]);
      setPlotEdges([]);
      return;
    }

    const load = async () => {
      try {
        const manuscript = await manuscriptService.get(currentManuscriptId);
        setMetadata(manuscript.metadata);
        setChapters(manuscript.chapters);
        setCurrentChapterId(manuscript.chapters[0]?.id || 'title-page');
      } catch (error) {
        console.error(error);
        alert('Failed to load manuscript');
        setCurrentManuscriptId(null);
      }
    };
    load();

    // Hydrate outline-pane state from localStorage. (Sync schema for these
    // entities is a follow-up; for now they're device-local.)
    try {
      const c = localStorage.getItem(`chronicle_chars_${currentManuscriptId}`);
      setCharacters(c ? JSON.parse(c) : []);
    } catch { setCharacters([]); }
    try {
      const n = localStorage.getItem(`chronicle_plotnodes_${currentManuscriptId}`);
      setPlotNodes(n ? JSON.parse(n) : []);
    } catch { setPlotNodes([]); }
    try {
      const e = localStorage.getItem(`chronicle_plotedges_${currentManuscriptId}`);
      setPlotEdges(e ? JSON.parse(e) : []);
    } catch { setPlotEdges([]); }

    // Reset the AI outline when switching books — the outline is per-manuscript,
    // not per-session.
    setAiOutlineMarkdown('');
    setIsAiOutlineLoading(false);
    // NOTE: deliberately not depending on remoteRevision. Reloading the
    // currently-open manuscript on every sync tick would clobber in-progress
    // edits the user hasn't auto-saved yet. The library view does react to
    // remoteRevision so adds/deletes from other devices show up there.
  }, [currentManuscriptId]);

  // Auto-save manuscript to server
  useEffect(() => {
    if (!currentManuscriptId || !metadata || chapters.length === 0) return;

    const timer = setTimeout(async () => {
      try {
        const manuscript: Manuscript = { metadata, chapters };
        await manuscriptService.update(currentManuscriptId, manuscript);
        console.log('Manuscript auto-saved');
      } catch (error) {
        console.error('Auto-save failed:', error);
      }
    }, 2000);

    return () => clearTimeout(timer);
  }, [metadata, chapters, currentManuscriptId]);

  // Prefill contact name from author if empty
  useEffect(() => {
    if (metadata && !metadata.contactName && metadata.author && metadata.author !== 'Uncredited Author') {
      setMetadata(prev => prev ? ({ ...prev, contactName: prev.author }) : null);
    }
  }, [metadata?.author]);

  // Sync profile name to metadata author if needed
  useEffect(() => {
    if (metadata?.author === 'Uncredited Author' && userProfile.name) {
      setMetadata(prev => prev ? ({ ...prev, author: userProfile.name }) : null);
    }
  }, [userProfile.name, metadata?.author]);

  useEffect(() => {
    localStorage.setItem('chronicle_user_profile', JSON.stringify(userProfile));
  }, [userProfile]);

  useEffect(() => {
    localStorage.setItem('chronicle_manuscript_font', manuscriptFont);
    const root = window.document.documentElement;
    root.style.setProperty('--manuscript-font', manuscriptFont);
  }, [manuscriptFont]);

  useEffect(() => {
    localStorage.setItem('chronicle_autocomplete', isAutocompleteEnabled.toString());
  }, [isAutocompleteEnabled]);

  useEffect(() => {
    localStorage.setItem('chronicle_tense_check', isTenseCheckEnabled.toString());
  }, [isTenseCheckEnabled]);

  useEffect(() => {
    localStorage.setItem('chronicle_grammar_check', isGrammarCheckEnabled.toString());
  }, [isGrammarCheckEnabled]);

  useEffect(() => {
    localStorage.setItem('chronicle_autocorrect', isAutoCorrectEnabled.toString());
  }, [isAutoCorrectEnabled]);

  useEffect(() => {
    localStorage.setItem('chronicle_issues_panel', isIssuesPanelEnabled.toString());
  }, [isIssuesPanelEnabled]);

  // Findings are position-keyed to the open chapter's editor; clear on switch.
  useEffect(() => {
    setTenseHits([]);
    setGrammarMarks([]);
  }, [currentChapterId, currentManuscriptId]);

  useEffect(() => {
    localStorage.setItem('chronicle_thesaurus', isThesaurusEnabled.toString());
  }, [isThesaurusEnabled]);

  useEffect(() => {
    localStorage.setItem('chronicle_zen_mode', isZenModeEnabled.toString());
  }, [isZenModeEnabled]);

  useEffect(() => {
    localStorage.setItem('chronicle_first_line_indent', isFirstLineIndentEnabled.toString());
  }, [isFirstLineIndentEnabled]);

  useEffect(() => {
    localStorage.setItem('chronicle_ai_enabled', isAiEnabled.toString());
  }, [isAiEnabled]);

  useEffect(() => {
    localStorage.setItem('chronicle_export_settings', JSON.stringify(exportSettings));
  }, [exportSettings]);

  useEffect(() => {
    localStorage.setItem('chronicle_ai_bubble_menu', isAiBubbleMenuEnabled.toString());
  }, [isAiBubbleMenuEnabled]);

  // Outline-pane persistence. Stored per-manuscript so each book has its
  // own cast and plot graph. Only write when a manuscript is open so we
  // don't accidentally clobber another book's state with empty arrays.
  useEffect(() => {
    if (!currentManuscriptId) return;
    localStorage.setItem(`chronicle_chars_${currentManuscriptId}`, JSON.stringify(characters));
  }, [characters, currentManuscriptId]);

  useEffect(() => {
    if (!currentManuscriptId) return;
    localStorage.setItem(`chronicle_plotnodes_${currentManuscriptId}`, JSON.stringify(plotNodes));
  }, [plotNodes, currentManuscriptId]);

  useEffect(() => {
    if (!currentManuscriptId) return;
    localStorage.setItem(`chronicle_plotedges_${currentManuscriptId}`, JSON.stringify(plotEdges));
  }, [plotEdges, currentManuscriptId]);

  // CRUD callbacks. Each generates a fresh id, timestamps the change, and
  // updates the array. Updates use object merge for partial patches.
  const handleAddCharacter = useCallback(() => {
    const id = `char_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const palette = ['#5B8DEF', '#E07A5F', '#8AA47B', '#C8A2C8', '#F4A261', '#2A9D8F', '#E9C46A', '#9C6644', '#577590', '#D5896F'];
    setCharacters((prev) => [...prev, {
      id,
      name: '',
      lastModified: Date.now(),
      color: palette[prev.length % palette.length],
    }]);
  }, []);

  const handleUpdateCharacter = useCallback((id: string, patch: Partial<Character>) => {
    setCharacters((prev) => prev.map((c) => c.id === id ? { ...c, ...patch, lastModified: Date.now() } : c));
  }, []);

  const handleDeleteCharacter = useCallback((id: string) => {
    setCharacters((prev) => prev.filter((c) => c.id !== id));
    // Cascade: remove character from any plot nodes that referenced them.
    setPlotNodes((prev) => prev.map((n) =>
      n.characterIds?.includes(id)
        ? { ...n, characterIds: n.characterIds.filter((x) => x !== id), lastModified: Date.now() }
        : n,
    ));
  }, []);

  const handleAddPlotNode = useCallback((kind: 'event' | 'comment') => {
    const id = `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setPlotNodes((prev) => [...prev, {
      id,
      type: kind,
      title: '',
      // Stagger new nodes diagonally so they don't pile up on top of each other.
      x: 40 + (prev.length % 8) * 30,
      y: 40 + (prev.length % 8) * 30,
      lastModified: Date.now(),
    }]);
  }, []);

  const handleUpdatePlotNode = useCallback((id: string, patch: Partial<PlotNode>) => {
    setPlotNodes((prev) => prev.map((n) => n.id === id ? { ...n, ...patch, lastModified: Date.now() } : n));
  }, []);

  const handleDeletePlotNode = useCallback((id: string) => {
    setPlotNodes((prev) => prev.filter((n) => n.id !== id));
    // Cascade: drop any edges that touched this node.
    setPlotEdges((prev) => prev.filter((e) => e.from !== id && e.to !== id));
  }, []);

  const handleAddPlotEdge = useCallback((from: string, to: string) => {
    if (from === to) return;
    setPlotEdges((prev) => {
      // De-dupe: skip if the same edge already exists.
      if (prev.some((e) => e.from === from && e.to === to)) return prev;
      return [...prev, {
        id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        from, to,
        lastModified: Date.now(),
      }];
    });
  }, []);

  const handleDeletePlotEdge = useCallback((id: string) => {
    setPlotEdges((prev) => prev.filter((e) => e.id !== id));
  }, []);

  useEffect(() => {
    if (aiOutlineMarkdown) {
      localStorage.setItem('chronicle_ai_outline', aiOutlineMarkdown);
    } else {
      localStorage.removeItem('chronicle_ai_outline');
    }
  }, [aiOutlineMarkdown]);

  useEffect(() => {
    localStorage.setItem('chronicle_theme', isDarkMode ? 'dark' : 'light');
    const root = window.document.documentElement;
    if (isDarkMode) root.classList.add('dark');
    else root.classList.remove('dark');
  }, [isDarkMode]);

  const handleCreateNew = async () => {
    const id = Math.random().toString(36).substr(2, 9);
    const newManuscript: Manuscript = {
      metadata: {
        id,
        title: '',
        author: userProfile.name || 'Uncredited Author',
        lastModified: Date.now(),
      },
      chapters: [
        {
          id: '1',
          title: 'Chapter 1',
          content: '',
          lastModified: Date.now(),
        }
      ]
    };

    try {
      await manuscriptService.create(newManuscript);
      setCurrentManuscriptId(id);
    } catch (error) {
      console.error(error);
      alert('Failed to create manuscript');
    }
  };

  const handleImportManuscript = async (manuscript: Manuscript) => {
    // Fill in author from profile if not set
    if (!manuscript.metadata.author) {
      manuscript.metadata.author = userProfile.name || 'Uncredited Author';
    }

    try {
      await manuscriptService.create(manuscript);
      setCurrentManuscriptId(manuscript.metadata.id);
    } catch (error) {
      console.error(error);
      alert('Failed to import manuscript');
    }
  };

  const handleUpdateChapterContent = useCallback((title: string, content: string) => {
    if (currentChapterId === 'title-page') {
      setMetadata(prev => prev ? ({
        ...prev,
        title: title || 'Untitled Manuscript',
        author: content || 'Uncredited Author',
        lastModified: Date.now()
      }) : null);
      return;
    }
    setChapters(prev => prev.map(c => 
      c.id === currentChapterId 
        ? { ...c, content, title: title || 'Untitled Chapter', lastModified: Date.now() } 
        : c
    ));
    setMetadata(prev => prev ? ({ ...prev, lastModified: Date.now() }) : null);
  }, [currentChapterId]);

  const handleUpdateSynopsis = useCallback((synopsis: string) => {
    setMetadata(prev => prev ? ({ ...prev, synopsis, lastModified: Date.now() }) : null);
  }, []);

  const handleAddChapter = useCallback(() => {
    const newChapter: Chapter = {
      id: Math.random().toString(36).substr(2, 9),
      title: 'Untitled Chapter',
      content: '<p>Start writing...</p>',
      lastModified: Date.now(),
    };
    setChapters(prev => [...prev, newChapter]);
    setCurrentChapterId(newChapter.id);
  }, []);

  const handleSelectChapter = useCallback((id: string) => {
    setCurrentChapterId(id);
    setIsSidebarOpen(false);
  }, []);

  const handleDuplicateChapter = useCallback((id: string) => {
    const chapterToDuplicate = chapters.find(c => c.id === id);
    if (!chapterToDuplicate) return;

    const newChapter: Chapter = {
      ...chapterToDuplicate,
      id: Math.random().toString(36).substr(2, 9),
      title: `${chapterToDuplicate.title} (Copy)`,
      lastModified: Date.now(),
    };

    setChapters(prev => {
      const index = prev.findIndex(c => c.id === id);
      const nextChapters = [...prev];
      nextChapters.splice(index + 1, 0, newChapter);
      return nextChapters;
    });
    setCurrentChapterId(newChapter.id);
  }, [chapters]);

  const handleReorderChapters = useCallback((newChapters: Chapter[]) => {
    setChapters(newChapters);
  }, []);

  const handleDeleteChapter = useCallback((id: string) => {
    setChapters(prev => {
      if (prev.length <= 1) return prev;
      const filtered = prev.filter(c => c.id !== id);
      if (currentChapterId === id) setCurrentChapterId(filtered[0].id);
      return filtered;
    });
  }, [currentChapterId]);

  /**
   * Manuscript-wide word count, recomputed when chapter content changes.
   * Same numbers the sidebar shows in its totals row, so the Library view's
   * "X Words" badge stays in sync with what authors see while editing.
   *
   * We mirror it into metadata.wordCount so the Library view (which only
   * loads metadata, not full chapter content) can display it without a
   * second fetch.
   */
  const totalWordCount = useMemo(
    () => chapters.reduce((sum, c) => sum + countWords(c.content), 0),
    [chapters],
  );

  useEffect(() => {
    setMetadata(prev =>
      prev && prev.wordCount !== totalWordCount
        ? { ...prev, wordCount: totalWordCount }
        : prev,
    );
  }, [totalWordCount]);

  const handleDeleteManuscript = useCallback(async () => {
    if (!currentManuscriptId) return;
    try {
      await manuscriptService.delete(currentManuscriptId);
      setCurrentManuscriptId(null);
    } catch (error) {
      console.error(error);
      alert('Failed to delete manuscript');
    }
  }, [currentManuscriptId]);

  if (!currentManuscriptId || !metadata) {
    // Global Settings is a full page, not an overlay: when it's open it takes
    // over the library view entirely (closing returns to the library).
    if (isGlobalSettingsOpen) {
      return (
        <PluginProvider syncSignal={remoteRevision} aiConfig={aiConfig}>
          <GlobalSettings
            onClose={() => setIsGlobalSettingsOpen(false)}
            isDarkMode={isDarkMode}
            onToggleTheme={() => setIsDarkMode(!isDarkMode)}
            userProfile={userProfile}
            onUpdateUserProfile={(newUserProfile) => setUserProfile(prev => ({ ...prev, ...newUserProfile }))}
            isAiEnabled={isAiEnabled}
            onToggleAiEnabled={() => {
              const turningOn = !isAiEnabled;
              setIsAiEnabled(turningOn);
              if (turningOn && !aiConfig) {
                updateAiConfig(defaultAiConfig());
              }
            }}
            aiConfig={aiConfig}
            onUpdateAiConfig={updateAiConfig}
            isAiBubbleMenuEnabled={isAiBubbleMenuEnabled}
            onToggleAiBubbleMenu={() => setIsAiBubbleMenuEnabled(!isAiBubbleMenuEnabled)}
            isAiUiHidden={isAiUiHidden}
            serverAiProviders={serverAiProviders}
            onRevalidateAi={handleRevalidateAi}
            exportSettings={exportSettings}
            onUpdateExportSettings={setExportSettings}
          />
        </PluginProvider>
      );
    }
    return (
      <PluginProvider syncSignal={remoteRevision} aiConfig={aiConfig}>
        <LibraryView
          onSelectManuscript={setCurrentManuscriptId}
          onCreateNew={handleCreateNew}
          onImportManuscript={handleImportManuscript}
          onOpenSettings={() => setIsGlobalSettingsOpen(true)}
          isDarkMode={isDarkMode}
          refreshSignal={remoteRevision}
        />
      </PluginProvider>
    );
  }

  const isTitlePage = currentChapterId === 'title-page';
  const currentChapter = isTitlePage 
    ? { id: 'title-page', title: metadata.title, content: metadata.author, lastModified: metadata.lastModified }
    : (chapters.find(c => c.id === currentChapterId) || chapters[0]);

  return (
    <PluginProvider syncSignal={remoteRevision} aiConfig={aiConfig}>
      <div className={cn(
        "relative flex w-full min-h-screen-dvh selection:bg-black/10 dark:selection:bg-white/10",
        isDarkMode ? "bg-manuscript-dark" : "bg-manuscript-light"
      )}>
        <Sidebar 
          isOpen={isSidebarOpen} 
          onToggle={() => setIsSidebarOpen(!isSidebarOpen)} 
          isDarkMode={isDarkMode}
          onToggleTheme={() => setIsDarkMode(!isDarkMode)}
          chapters={chapters}
          currentChapterId={currentChapterId}
          onSelectChapter={handleSelectChapter}
          onAddChapter={handleAddChapter}
          onDeleteChapter={handleDeleteChapter}
          onDuplicateChapter={handleDuplicateChapter}
          onReorderChapters={handleReorderChapters}
          manuscriptFont={manuscriptFont}
          onChangeFont={setManuscriptFont}
          isThesaurusEnabled={isThesaurusEnabled}
          onToggleThesaurus={() => setIsThesaurusEnabled(!isThesaurusEnabled)}
          isZenModeEnabled={isZenModeEnabled}
          onToggleZenMode={() => setIsZenModeEnabled(!isZenModeEnabled)}
          isFirstLineIndentEnabled={isFirstLineIndentEnabled}
          onToggleFirstLineIndent={() => setIsFirstLineIndentEnabled(!isFirstLineIndentEnabled)}
          isAiEnabled={isAiEnabled}
          onToggleAiEnabled={() => {
            const turningOn = !isAiEnabled;
            setIsAiEnabled(turningOn);
            // Seed a default config so the editor doesn't see `isAiEnabled
            // && !!aiConfig` flip false on the first toggle. The user can
            // then change provider/model in Settings without first having
            // to fill anything in.
            if (turningOn && !aiConfig) {
              updateAiConfig(defaultAiConfig());
            }
          }}
          aiConfig={aiConfig}
          onUpdateAiConfig={updateAiConfig}
          serverAiProviders={serverAiProviders}
          onRevalidateAi={handleRevalidateAi}
          isAiBubbleMenuEnabled={isAiBubbleMenuEnabled}
          onToggleAiBubbleMenu={() => setIsAiBubbleMenuEnabled(!isAiBubbleMenuEnabled)}
          isAiUiHidden={isAiUiHidden}
          touchControlsMode={touchControlsMode}
          onChangeTouchControls={setTouchControlsMode}
          metadata={metadata}
          onUpdateSynopsis={handleUpdateSynopsis}
          currentChapterContent={currentChapter.content}
          isAutocompleteEnabled={isAutocompleteEnabled}
          onToggleAutocomplete={() => setIsAutocompleteEnabled(!isAutocompleteEnabled)}
          isTenseCheckEnabled={isTenseCheckEnabled}
          onToggleTenseCheck={() => setIsTenseCheckEnabled(!isTenseCheckEnabled)}
          isGrammarCheckEnabled={isGrammarCheckEnabled}
          onToggleGrammarCheck={() => setIsGrammarCheckEnabled(!isGrammarCheckEnabled)}
          isAutoCorrectEnabled={isAutoCorrectEnabled}
          onToggleAutoCorrect={() => setIsAutoCorrectEnabled(!isAutoCorrectEnabled)}
          isIssuesPanelEnabled={isIssuesPanelEnabled}
          onToggleIssuesPanel={() => setIsIssuesPanelEnabled(!isIssuesPanelEnabled)}
          tenseHits={tenseHits}
          grammarMarks={grammarMarks}
          onUpdateMetadata={(newMetadata) => setMetadata(prev => prev ? ({ ...prev, ...newMetadata }) : null)}
          userProfile={userProfile}
          onUpdateUserProfile={(newUserProfile) => setUserProfile(prev => ({ ...prev, ...newUserProfile }))}
          onDeleteManuscript={handleDeleteManuscript}
          onReturnToLibrary={() => setCurrentManuscriptId(null)}
          exportSettings={exportSettings}
          aiOutlineMarkdown={aiOutlineMarkdown}
          isAiOutlineLoading={isAiOutlineLoading}
          onClearAiOutline={() => setAiOutlineMarkdown('')}
          editor={activeEditor}
          characters={characters}
          plotNodes={plotNodes}
          plotEdges={plotEdges}
          onAddCharacter={handleAddCharacter}
          onUpdateCharacter={handleUpdateCharacter}
          onDeleteCharacter={handleDeleteCharacter}
          onAddPlotNode={handleAddPlotNode}
          onUpdatePlotNode={handleUpdatePlotNode}
          onDeletePlotNode={handleDeletePlotNode}
          onAddPlotEdge={handleAddPlotEdge}
          onDeletePlotEdge={handleDeletePlotEdge}
        />
        
        <main className="flex-1">
          <motion.div
            key={currentChapterId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.0 }}
            className="relative"
          >
            <div className="fixed inset-0 pointer-events-none opacity-[0.03] dark:opacity-[0.05]">
              <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/natural-paper.png')] dark:invert" />
            </div>

            <EditorView 
              isDarkMode={isDarkMode} 
              onToggleTheme={() => setIsDarkMode(!isDarkMode)} 
              manuscriptId={currentManuscriptId!}
              chapterId={currentChapter.id}
              isTitlePage={isTitlePage}
              coverArt={metadata.coverArt}
              isSidebarOpen={isSidebarOpen}              isThesaurusEnabled={isThesaurusEnabled}
              isZenModeEnabled={isZenModeEnabled}
              isAutocompleteEnabled={isAutocompleteEnabled}
              isTenseCheckEnabled={isTenseCheckEnabled}
              isGrammarCheckEnabled={isGrammarCheckEnabled}
              isAutoCorrectEnabled={isAutoCorrectEnabled}
              onTenseShifts={setTenseHits}
              onGrammarMarks={setGrammarMarks}
              isFirstLineIndentEnabled={isFirstLineIndentEnabled}
              isAiEnabled={isAiEnabled && !!aiConfig && !isAiUiHidden}
              isAiBubbleMenuEnabled={isAiBubbleMenuEnabled}
              isTouchUI={isTouchUI}
              aiConfig={aiConfig}
              manuscriptFont={manuscriptFont}
              sceneBreakStyle={metadata.sceneBreakStyle || 'classic'}
              customSceneBreakSvg={metadata.customSceneBreakSvg}
              title={currentChapter.title}
              content={currentChapter.content}
              lastModified={currentChapter.lastModified}
              onUpdate={handleUpdateChapterContent}
              onAiOutlineResult={(md) => {
                setAiOutlineMarkdown(md);
                // Pop the sidebar open so the new outline is visible. If the
                // author already had it open we leave their view alone.
                if (!isSidebarOpen) setIsSidebarOpen(true);
              }}
              onAiOutlineLoadingChange={setIsAiOutlineLoading}
              onEditorReady={setActiveEditor}
            />
          </motion.div>
        </main>

        {isSidebarOpen && (
          <div 
            className="fixed inset-0 bg-black/10 backdrop-blur-sm z-40"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}
      </div>
    </PluginProvider>
  );
}

