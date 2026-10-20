/**
 * 開いている走行と同じフォルダの動画 (動画の画面で、まだ動画がないときに出す。2026-10-20)。
 * 押すと、その動画を走行に付けて開く (runs.json にも書く)
 */
import React, { useState } from 'react';
import { Video } from 'lucide-react';
import { useT } from '../utils/i18n';
import { addVideoToOpenRun, getOpenRun } from '../services/runOpener';

export const RunFolderVideos: React.FC = () => {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const run = getOpenRun();
  if (!run) return null;
  const videos = run.item.folderVideos.filter(v => !/\.lrv$/i.test(v.path));
  if (videos.length === 0) return null;
  const name = (p: string) => p.slice(run.item.folder.length + 1);
  const open = async (path: string, size: number, mtimeMs: number) => {
    setBusy(path);
    try {
      await addVideoToOpenRun({ name: name(path), size, url: run.store.videoUrl(path), path, lastModified: mtimeMs });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="w-full max-w-sm mt-5 text-left" data-testid="run-folder-videos">
      <div className="text-xs font-bold text-slate-300 mb-1.5 px-0.5">{t('この走行のフォルダの動画', 'Videos in this run\'s folder')}</div>
      <div className="space-y-1.5">
        {videos.map(v => (
          <button
            key={v.path}
            onClick={() => void open(v.path, v.size, v.mtimeMs)}
            disabled={!!busy || !v.local}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg bg-surface-2 hover:bg-surface-3 border border-line-2 text-xs text-slate-200 disabled:opacity-50 cursor-pointer"
          >
            <Video size={14} className="text-sky-400 shrink-0" />
            <span className="flex-1 min-w-0 truncate text-left">{name(v.path)}</span>
            <span className="text-slate-500 shrink-0">{v.local ? `${(v.size / 1e9).toFixed(1)} GB` : t('iCloud にだけある', 'iCloud only')}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
