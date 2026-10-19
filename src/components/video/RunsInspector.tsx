import React, { useEffect, useRef, useState } from 'react';
import { X, MapPin } from 'lucide-react';
import type { Session } from '../../types/telemetry';
import type { PlayableMedia } from '../../services/playableMedia';
import { deriveRuns, runOfSession, Run } from '../../services/runs';
import { analyseSessions } from '../../services/pairAnalysis';
import { videoSyncManager, VideoTrack } from '../../services/videoSyncManager';
import { useT } from '../../utils/i18n';

/**
 * 走行の確認 (docs/video_sets_design.md の 8)。走行ごとに、ログと動画、動画の時刻の出どころ、同じ走行の判定、時計の補正を出し、
 * 動画を外す・別のログへ移す・主のログを変えることができる。地図にログの軌跡を重ね、取り違えが分かるようにする
 */

export type SyncLevel = 'green' | 'yellow' | 'red';

/** 枠の同期の印。緑: GPS・手で合わせた (0.1 秒以内)、黄: 撮影日時 (±1 秒)、赤: 時刻が分からない */
export function syncBadgeOf(track: VideoTrack & { isPlaced?: boolean }, t: (ja: string, en: string) => string): { level: SyncLevel; label: string; title: string } {
  if (track.isPlaced === false) return { level: 'red', label: t('未確認', 'Unverified'), title: t('動画の時刻が分かりません。走行の確認で、ログに付けてください', 'The video time is unknown. Attach it to a log in the run inspector') };
  switch (track.clock.source) {
    case 'gps': return { level: 'green', label: 'GPS', title: t('動画自身の GPS の時刻で合わせています (0.1 秒以内)', 'Timed by the video\'s own GPS (within 0.1 s)') };
    case 'manual': return { level: 'green', label: t('合わせ', 'Synced'), title: t('手で合わせた時刻です', 'Synced by hand') };
    default: return { level: 'yellow', label: t('撮影日時 ±1秒', 'File time ±1 s'), title: t('ファイルの撮影日時で合わせています (±1 秒)。同期ピンや「現フレームで同期」で合わせると確かになります', 'Timed by the file\'s creation time (±1 s). Sync it with a pin or "sync to current frame" for accuracy') };
  }
}

export const BADGE_CLASS: Record<SyncLevel, string> = {
  green: 'bg-emerald-900/80 border-emerald-600 text-emerald-200',
  yellow: 'bg-amber-900/80 border-amber-600 text-amber-200',
  red: 'bg-red-900/80 border-red-600 text-red-200'
};

const LOG_COLORS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#a855f7'];

/** 走行のログの軌跡を重ねた小さな地図 */
const RunMap: React.FC<{ sessions: Session[] }> = ({ sessions }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const pts = sessions.map(s => s.points.filter((p, i) => i % Math.max(1, Math.floor(s.points.length / 3000)) === 0 && Number.isFinite(p.latitude) && !(p.latitude === 0 && p.longitude === 0)));
    const all = pts.flat();
    if (all.length === 0) return;
    const lat0 = Math.min(...all.map(p => p.latitude)), lat1 = Math.max(...all.map(p => p.latitude));
    const lon0 = Math.min(...all.map(p => p.longitude)), lon1 = Math.max(...all.map(p => p.longitude));
    const k = Math.cos(((lat0 + lat1) / 2) * Math.PI / 180);
    const w = (lon1 - lon0) * k || 1e-6, h = lat1 - lat0 || 1e-6;
    const scale = Math.min((c.width - 16) / w, (c.height - 16) / h);
    const ox = (c.width - w * scale) / 2, oy = (c.height - h * scale) / 2;
    pts.forEach((list, i) => {
      ctx.strokeStyle = LOG_COLORS[i % LOG_COLORS.length];
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = i === 0 ? 2.5 : 1.2;
      ctx.beginPath();
      list.forEach((p, j) => {
        const x = ox + (p.longitude - lon0) * k * scale, y = c.height - (oy + (p.latitude - lat0) * scale);
        if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }, [sessions]);
  return <canvas ref={ref} width={260} height={180} className="bg-surface-0 rounded border border-line-2 shrink-0" />;
};

interface RunsInspectorProps {
  sessions: Session[];
  media: PlayableMedia[];
  /** 主のログにしたとき (そのログを Car 1 にする) */
  onChooseLog?: (sessionId: string) => void;
  onClose: () => void;
}

export const RunsInspector: React.FC<RunsInspectorProps> = ({ sessions, media, onChooseLog, onClose }) => {
  const t = useT();
  const [runs, setRuns] = useState<Run[] | null>(null);
  useEffect(() => {
    let alive = true;
    setRuns(null);
    deriveRuns(sessions, analyseSessions).then(r => { if (alive) setRuns(r); });
    return () => { alive = false; };
  }, [sessions]);

  const mediaOfRun = (run: Run) => media.filter(m => run.logs.some(l => l.session.id === m.tracks[0].matchedSessionId));
  const unassigned = runs ? media.filter(m => !runOfSession(runs, m.tracks[0].matchedSessionId)) : [];
  const logSelect = (m: PlayableMedia) => (
    <select
      value={m.tracks[0].matchedSessionId ?? ''}
      onChange={e => videoSyncManager.chooseSession(m.id, e.target.value)}
      className="bg-surface-3 border border-line-3 text-[11px] text-slate-200 rounded px-1 py-0.5 max-w-[200px] truncate"
      title={t('この動画を出すログ。別の走行のログを選ぶと、その走行へ移します', 'The log this video is shown with. Choosing a log of another run moves the video there')}
    >
      <option value="" disabled>{t('ログを選ぶ', 'Choose a log')}</option>
      {sessions.map(s => <option key={s.id} value={s.id}>{s.sessionName} ({s.samplingRate} Hz)</option>)}
    </select>
  );
  const videoRow = (m: PlayableMedia, inRun: boolean) => {
    const b = syncBadgeOf(m.tracks[0], t);
    return (
      <div key={m.id} className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="font-mono text-slate-200 truncate max-w-[200px]">{m.label}</span>
        <span className={`px-1.5 py-px rounded border text-[10px] ${BADGE_CLASS[b.level]}`} title={b.title}>{b.label}</span>
        {logSelect(m)}
        {inRun && (
          <button
            onClick={() => videoSyncManager.setMatchedSession(m.id, null)}
            className="px-1.5 py-px rounded border border-line-3 text-slate-400 hover:text-slate-100"
            title={t('この動画を走行から外します (未割り当てに移ります)', 'Detach this video from the run (it moves to unassigned)')}
          >
            {t('外す', 'Detach')}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="absolute inset-0 z-50 bg-black/60 flex items-start justify-center p-3 overflow-y-auto" onClick={onClose}>
      <div className="bg-surface-1 border border-line-2 rounded-lg shadow-xl w-full max-w-3xl p-3 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-100 flex items-center gap-1.5"><MapPin size={14} className="text-red-400" />{t('走行の確認', 'Runs')}</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-100" title={t('閉じる', 'Close')}><X size={14} /></button>
        </div>
        <p className="text-[11px] text-slate-400">
          {t('同じ車の走行と確かめられたログをまとめて出します。地図の線がずれていれば、別の車のログか、動画を付けたログが違います。', 'Logs confirmed to be the same car are grouped. If the lines on the map do not overlap, a log is from another car or a video is attached to the wrong log.')}
        </p>
        {!runs && <div className="text-xs text-slate-400">{t('ログを比べています…', 'Comparing logs…')}</div>}
        {runs?.map(run => {
          const vids = mediaOfRun(run);
          const first = run.logs[0].session;
          return (
            <div key={run.id} className="border border-line-2 rounded p-2 flex flex-col sm:flex-row gap-3">
              <RunMap sessions={run.logs.map(l => l.session)} />
              <div className="flex-1 min-w-0 space-y-2">
                <div className="text-xs font-bold text-slate-200">{first.date} {first.sessionName}</div>
                <div className="space-y-1">
                  {run.logs.map((l, i) => {
                    const shownBy = vids.filter(m => m.tracks[0].matchedSessionId === l.session.id).length;
                    return (
                      <div key={l.session.id} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: LOG_COLORS[i % LOG_COLORS.length] }} />
                        <span className="text-slate-200 truncate max-w-[180px]">{l.session.sessionName}</span>
                        <span className="text-slate-500">{l.session.samplingRate} Hz</span>
                        <span className="text-slate-500">{t('時計の補正', 'Clock')} {(l.session.clockOffsetSec ?? 0) >= 0 ? '+' : ''}{(l.session.clockOffsetSec ?? 0).toFixed(3)} s</span>
                        {l.analysis && (
                          <span className="text-slate-500" title={t('最初のログと位置を比べた結果', 'Position comparison with the first log')}>
                            {t('位置の差', 'gap')} {l.analysis.medianDistanceM} m・{t('ずれ', 'offset')} {l.analysis.offsetSec >= 0 ? '+' : ''}{l.analysis.offsetSec.toFixed(3)} s
                          </span>
                        )}
                        {vids.length > 0 && shownBy < vids.length && (
                          <button
                            onClick={() => { vids.forEach(m => videoSyncManager.chooseSession(m.id, l.session.id)); onChooseLog?.(l.session.id); }}
                            className="px-1.5 py-px rounded border border-line-3 text-slate-400 hover:text-slate-100"
                            title={t('この走行の動画を、このログに出します (このログを Car 1 にします)', 'Show this run\'s videos with this log (makes it Car 1)')}
                          >
                            {t('主のログにする', 'Make primary')}
                          </button>
                        )}
                        {vids.length > 0 && shownBy === vids.length && <span className="text-emerald-400 text-[10px]">{t('主のログ', 'Primary')}</span>}
                      </div>
                    );
                  })}
                </div>
                <div className="space-y-1 border-t border-line-2 pt-1.5">
                  {vids.length === 0 && <div className="text-[11px] text-slate-500">{t('この走行の動画はありません', 'No videos in this run')}</div>}
                  {vids.map(m => videoRow(m, true))}
                </div>
              </div>
            </div>
          );
        })}
        {runs && unassigned.length > 0 && (
          <div className="border border-dashed border-line-3 rounded p-2 space-y-1">
            <div className="text-xs font-bold text-slate-300">{t('未割り当ての動画', 'Unassigned videos')}</div>
            <p className="text-[11px] text-slate-500">{t('ログを選ぶと、その走行に入ります', 'Choose a log to put the video in that run')}</p>
            {unassigned.map(m => videoRow(m, false))}
          </div>
        )}
      </div>
    </div>
  );
};
