import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/utils';

interface PopoutWindowProps {
  /** An already-open child window (opened in a user gesture to dodge popup blockers). */
  targetWindow: Window;
  /** Document title for the popped-out window. */
  title: string;
  isDarkMode: boolean;
  /** Called when the OS window is closed directly (or on cleanup). */
  onClose: () => void;
  children: React.ReactNode;
}

// Manuscript background colors — mirror the `bg-manuscript-*` tokens so the
// window chrome behind the mount matches before/around the themed content.
const BG_DARK = '#232220';
const BG_LIGHT = '#F4F1EA';

/**
 * Renders `children` into a separate browser window via a React portal.
 *
 * Because it's a portal (one React tree, not a second root), all props, state,
 * and callbacks flow live between the main window and the popout with no
 * cross-window syncing. The window handle is opened by the caller in a click
 * handler and passed in as `targetWindow`.
 *
 * Setup is idempotent (guarded by a marker id) so React StrictMode's
 * double-invoked effects in dev don't duplicate the styles or the mount node,
 * and the window's lifecycle (open/close) is owned by the caller — this
 * component never closes it, it only reports when the user closes it.
 */
export const PopoutWindow: React.FC<PopoutWindowProps> = ({
  targetWindow,
  title,
  isDarkMode,
  onClose,
  children,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  // One-time (per window) setup: copy styles, build a mount node, watch for close.
  useEffect(() => {
    const doc = targetWindow.document;
    doc.title = title;

    let container = doc.getElementById('chronicle-popout-root') as HTMLDivElement | null;
    if (!container) {
      // Copy the opener's compiled stylesheets + font imports into the new
      // document. Cloning live nodes covers both dev (Vite injects <style>) and
      // prod (a hashed <link>), so we never hardcode an asset path.
      document.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
        doc.head.appendChild(node.cloneNode(true));
      });
      doc.body.style.margin = '0';
      container = doc.createElement('div');
      container.id = 'chronicle-popout-root';
      container.style.height = '100vh';
      doc.body.appendChild(container);
    }
    containerRef.current = container;
    setReady(true);

    // The window can be closed from the OS chrome; poll + beforeunload cover it.
    const poll = window.setInterval(() => {
      if (targetWindow.closed) {
        window.clearInterval(poll);
        onClose();
      }
    }, 500);
    const handleUnload = () => onClose();
    targetWindow.addEventListener('beforeunload', handleUnload);

    return () => {
      window.clearInterval(poll);
      targetWindow.removeEventListener('beforeunload', handleUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetWindow]);

  // Keep the popout's theme in lockstep with the main window.
  useEffect(() => {
    const root = targetWindow.document.documentElement;
    if (isDarkMode) root.classList.add('dark');
    else root.classList.remove('dark');
    root.style.backgroundColor = isDarkMode ? BG_DARK : BG_LIGHT;
  }, [targetWindow, isDarkMode]);

  if (!ready || !containerRef.current) return null;

  return createPortal(
    <div
      className={cn(
        'h-screen w-screen overflow-hidden flex flex-col p-4 sm:p-6',
        isDarkMode ? 'bg-manuscript-dark text-white' : 'bg-manuscript-light text-black',
      )}
    >
      {children}
    </div>,
    containerRef.current,
  );
};
