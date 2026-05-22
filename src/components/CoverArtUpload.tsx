import React, { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Upload, Trash2, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { uploadCover, deleteCover, loadCoverBlobUrl, clearCoverCache } from '../services/coverService';

interface CoverArtUploadProps {
  manuscriptId: string;
  coverArt?: string;
  onChange: (filename: string | undefined) => void;
  isDarkMode: boolean;
}

/**
 * Cover-art picker. Three states:
 *   - empty: dashed drop zone with an upload button
 *   - loaded: thumbnail with Replace and Remove actions
 *   - uploading: spinner
 *
 * Allowed types: image/png, image/jpeg, image/webp. The server re-validates
 * via magic bytes, so a misnamed file will fail server-side rather than
 * being trusted to be what it claims.
 */
const ACCEPT = 'image/png,image/jpeg,image/webp';
const MAX_BYTES = 8 * 1024 * 1024;

export function CoverArtUpload({ manuscriptId, coverArt, onChange, isDarkMode }: CoverArtUploadProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve the stored filename into a blob URL we can render. Re-runs
  // whenever the filename changes (e.g. after a replace upload).
  useEffect(() => {
    let cancelled = false;
    if (!coverArt) {
      setThumbUrl(null);
      return;
    }
    loadCoverBlobUrl(coverArt).then((url) => {
      if (!cancelled) setThumbUrl(url);
    });
    return () => { cancelled = true; };
  }, [coverArt]);

  const handleFile = async (file: File) => {
    setError(null);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Please choose a PNG, JPEG, or WebP file.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('Image is larger than 8 MB.');
      return;
    }
    setBusy(true);
    try {
      // Invalidate any cached blob URL for the previous cover so the next
      // read fetches the replacement bytes rather than the stale image.
      if (coverArt) clearCoverCache(coverArt);
      const filename = await uploadCover(manuscriptId, file);
      onChange(filename);
    } catch (err: any) {
      setError(err?.message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    try {
      if (coverArt) clearCoverCache(coverArt);
      await deleteCover(manuscriptId);
      onChange(undefined);
    } catch (err: any) {
      setError(err?.message || 'Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <label className="block text-[10px] uppercase tracking-widest font-bold opacity-30">Cover Art</label>

      {thumbUrl ? (
        <div className={cn(
          "flex gap-3 p-3 rounded-xl border",
          isDarkMode ? "border-white/10 bg-white/[0.02]" : "border-black/10 bg-black/[0.02]",
        )}>
          <img
            src={thumbUrl}
            alt="Cover art"
            className="w-16 h-24 object-cover rounded-md shadow-md shrink-0"
          />
          <div className="flex flex-col justify-between flex-1 min-w-0">
            <div className="text-[9px] opacity-50 font-mono truncate" title={coverArt}>{coverArt}</div>
            <div className="flex gap-2">
              <button
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[9px] font-bold uppercase tracking-widest transition-all",
                  isDarkMode ? "bg-white/5 hover:bg-white/10 text-white/80" : "bg-black/5 hover:bg-black/10 text-black/80",
                )}
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                Replace
              </button>
              <button
                onClick={handleRemove}
                disabled={busy}
                className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[9px] font-bold uppercase tracking-widest text-red-500/80 hover:text-red-500 hover:bg-red-500/5 border border-red-500/10 transition-all"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className={cn(
            "w-full flex flex-col items-center justify-center gap-2 py-6 rounded-xl border-2 border-dashed transition-all hover:bg-black/5 dark:hover:bg-white/5",
            isDarkMode ? "border-white/10 text-white/40" : "border-black/10 text-black/40",
          )}
        >
          {busy ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <ImageIcon className="w-5 h-5 opacity-60" />
          )}
          <span className="text-[10px] uppercase tracking-widest font-bold">
            {busy ? 'Uploading...' : 'Upload Cover Art'}
          </span>
          <span className="text-[9px] opacity-60">PNG · JPEG · WebP · max 8 MB</span>
        </button>
      )}

      {error && (
        <p className="text-[10px] text-red-500 px-1">{error}</p>
      )}

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          // Reset so picking the same file twice re-triggers onChange.
          e.target.value = '';
        }}
      />
    </div>
  );
}
