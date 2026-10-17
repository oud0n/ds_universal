import React, { useRef, useEffect, useState } from 'react';
import { canvasColors, useResolvedTheme } from '../utils/theme';
import { useCompactLayout } from '../hooks/useCompactLayout';
import { Lap, SelectedCarSlot, Sector, CompareAxis } from '../types/telemetry';
import { Play, Pause, SkipBack, SkipForward, PlaySquare, Compass, Eye } from 'lucide-react';
import { findCarPoint } from '../utils/telemetrySearch';

interface ReplayWindowProps {
  cars: {
    slot: SelectedCarSlot;
    lap: Lap;
  }[];
  sectors: Sector[];
  currentTime: number;
  currentDistance: number;
  compareAxis: CompareAxis;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStepForward: () => void;
  onStepBack: () => void;
  onSeekDistance: (dist: number) => void;
  onSyncSectorStart: (sectorIndex: number) => void;
  // 同時スタートの動作 (base: 基準車に合わせる / all: 全車をそのセクター線にそろえる)
  sectorStartMode: 'base' | 'all';
  onChangeSectorStartMode: (mode: 'base' | 'all') => void;
  // 時刻をそろえているセクターの名前 (そのセクターの始まりでそろえる。そろえていなければ undefined)
  alignedSectorName?: string;
  // そろえられなかった比較車両の数 (そのセクター線を通過していない周など)
  alignFailedCount: number;
  // 基準車がそのセクター線を通っていない (どの車もそろえられない)
  alignBaseMissing?: boolean;
  onClearAlignedSector: () => void;
}

export const ReplayWindow: React.FC<ReplayWindowProps> = ({
  cars,
  sectors,
  currentTime,
  currentDistance,
  compareAxis,
  isPlaying,
  onTogglePlay,
  onStepForward,
  onStepBack,
  onSeekDistance,
  onSyncSectorStart,
  sectorStartMode,
  onChangeSectorStartMode,
  alignedSectorName,
  alignFailedCount,
  alignBaseMissing,
  onClearAlignedSector
}) => {
  // テーマを切り替えたら canvas を描き直す
  const theme = useResolvedTheme();
  // スマートフォン向けの配置では、ツールバーを 1 行にして横にスクロールさせ、見出しを省く
  const compact = useCompactLayout();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [followCar, setFollowCar] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(3.0); // クローズアップ倍率

  const baseCar = cars[0];

  // 表示領域の大きさが変わったら描き直す (スマートフォンを回したとき・ルーラーが出たときなど)
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setResizeTick(t => t + 1));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // テーマの色 (テーマを切り替えたら描き直す)
    const C = canvasColors();

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 400;
    const height = canvas.parentElement?.clientHeight || 300;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.scale(dpr, dpr);

    // 背景 (ダークサーキット)
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, width, height);

    if (cars.length === 0 || !baseCar) {
      ctx.fillStyle = C.axis;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('再生データがありません', width / 2, height / 2);
      return;
    }

    // 基準車の現在位置と向き (O(log N) 二分探索)
    const basePts = baseCar.lap.points;
    const curBasePt = findCarPoint(basePts, compareAxis, currentDistance, currentTime) || basePts[0];

    const centerLat = curBasePt.latitude;
    const centerLon = curBasePt.longitude;
    const cosLat = Math.cos((centerLat * Math.PI) / 180);

    // 画面スケール (1度あたりのピクセル数)
    // 緯度1度 ≈ 111km -> 1km ≈ 0.009度
    // クローズアップスケール: 約300m四方を表示
    const scale = (Math.min(width, height) / 0.003) * zoomLevel;

    const toScreen = (lat: number, lon: number) => {
      const x = width / 2 + (lon - centerLon) * cosLat * scale;
      const y = height / 2 - (lat - centerLat) * scale;
      return { x, y };
    };

    // 軌跡のうち画面に入る部分だけを描く。画面の外に出たら線を切り、戻るときは画面の外の点から引き直す
    // (画面に入っている点だけを 1 本につなぐと、出る直前の点と戻ってきた点が直線で結ばれ、コースを横切る線が出るため)
    const traceVisible = (pts: typeof basePts, margin: number) => {
      ctx.beginPath();
      let drawing = false;
      let prev: { x: number; y: number } | null = null;
      for (const p of pts) {
        const cur = toScreen(p.latitude, p.longitude);
        const inside = cur.x >= -margin && cur.x <= width + margin && cur.y >= -margin && cur.y <= height + margin;
        if (inside) {
          if (!drawing) {
            // 画面の外の 1 つ前の点から入る (画面の端で線が途切れないように)
            if (prev) ctx.moveTo(prev.x, prev.y);
            else ctx.moveTo(cur.x, cur.y);
            drawing = true;
          }
          ctx.lineTo(cur.x, cur.y);
        } else if (drawing) {
          // 画面の外の最初の点まで引いて切る
          ctx.lineTo(cur.x, cur.y);
          drawing = false;
        }
        prev = cur;
      }
      ctx.stroke();
    };

    // 1. 周辺トラック (アスファルト幅)
    ctx.strokeStyle = C.track;
    ctx.lineWidth = 32;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    traceVisible(basePts, 50);

    // コース境界白線
    ctx.strokeStyle = C.trackEdge;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 2. 各車両の走行ライン
    cars.forEach(car => {
      const pts = car.lap.points;
      ctx.strokeStyle = car.slot.colorHex + '80'; // 透過
      ctx.lineWidth = 2;
      traceVisible(pts, 40);
    });

    // 3. 各車両のリアルタイムアニメーション描画 (車両ボディ & 進行方向)
    cars.forEach(car => {
      const pts = car.lap.points;
      if (pts.length === 0) return;

      // 距離基準: 基準車と同じ距離 / 時間基準: 同じ経過時間
      const pt = findCarPoint(pts, compareAxis, currentDistance, currentTime) || pts[0];

      const pos = toScreen(pt.latitude, pt.longitude);
      const headingRad = ((pt.heading - 90) * Math.PI) / 180;

      // 車両アイコン (レーシングカー形状)
      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.rotate(headingRad);

      // 車両影
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(-10, -5, 20, 10);

      // 車両ボディ
      ctx.fillStyle = car.slot.colorHex;
      ctx.beginPath();
      // フロントノーズ
      ctx.moveTo(12, 0);
      ctx.lineTo(8, -6);
      ctx.lineTo(-10, -6);
      ctx.lineTo(-12, -4);
      ctx.lineTo(-12, 4);
      ctx.lineTo(-10, 6);
      ctx.lineTo(8, 6);
      ctx.closePath();
      ctx.fill();

      // ウィンドシールド
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, -4, 5, 8);

      // リアウィング
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-12, -7, 2, 14);

      // ヘッドライト
      ctx.fillStyle = '#fef08a';
      ctx.fillRect(11, -5, 2, 2);
      ctx.fillRect(11, 3, 2, 2);

      ctx.restore();

      // 車両ラベル・速度タグ
      ctx.fillStyle = C.strong;
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${pt.speed.toFixed(0)} km/h`, pos.x, pos.y - 14);
    });

    // 4. クリップ位置・距離インジケーター
    ctx.fillStyle = C.label;
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`Dist: ${currentDistance.toFixed(3)} km`, 10, height - 12);
    ctx.fillText(`Time: ${currentTime.toFixed(2)} s`, 10, height - 24);
  }, [cars, baseCar, currentDistance, currentTime, compareAxis, zoomLevel, followCar, theme, resizeTick]);

  return (
    <div className="flex flex-col h-full bg-surface-2 rounded-lg border border-line-2 overflow-hidden select-none shadow-lg">
      {/* ツールバー */}
      <div className={compact ? 'flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2 py-1 bg-surface-3 border-b border-line-2 text-xs shrink-0' : 'flex items-center justify-between px-3 py-1.5 bg-surface-3 border-b border-line-2 text-xs'}>
        <div className={compact ? 'flex flex-wrap items-center gap-x-2 gap-y-1' : 'flex items-center gap-2'}>
          {!compact && (
            <span className="font-bold text-slate-200 flex items-center gap-1.5">
              <PlaySquare size={14} className="text-amber-400" />
              アニメーション再生
            </span>
          )}

          {/* セクター同時スタートボタン */}
          {sectors.length > 0 && (
            <div className={compact ? 'flex flex-wrap items-center gap-1' : 'flex items-center gap-1 ml-2'}>
              <span className="text-[10px] text-slate-400 font-medium">{compact ? '同時:' : '同時スタート:'}</span>
              <div className="flex gap-1">
                {sectors.map((sec, idx) => (
                  <button
                    key={sec.id}
                    onClick={() => onSyncSectorStart(idx)}
                    title={sectorStartMode === 'all'
                      ? `全車が S${idx + 1} の始まり (${idx === 0 ? '計測線' : `${sectors[idx - 1].name || `S${idx}`} の線`}) を同時に通るよう時刻をそろえて、そこから一斉スタート (時間基準)`
                      : `S${idx + 1} の始まり (${idx === 0 ? '計測線' : `${sectors[idx - 1].name || `S${idx}`} の線`}) から一斉スタート (基準車の位置に合わせる)`}
                    className="px-1.5 py-0.5 rounded bg-surface-4 hover:bg-amber-600 hover:text-white text-slate-300 text-[10px] font-bold border border-line-4 transition-all"
                  >
                    {`S${idx + 1}`}
                  </button>
                ))}
              </div>
              {/* 動作の切り替え: 基準車に合わせる / 全車をセクター線にそろえる */}
              <div className="flex bg-surface-1 rounded p-0.5 border border-line-3 ml-1">
                {(['base', 'all'] as const).map(mode => (
                  <button
                    key={mode}
                    onClick={() => onChangeSectorStartMode(mode)}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-all ${
                      sectorStartMode === mode ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                    title={mode === 'base' ? '基準車 (Car 1) の位置に合わせる' : '全車がそのセクター線を同時に通るようにそろえる'}
                  >
                    {mode === 'base' ? (compact ? 'Car 1' : 'Car 1 に合わせる') : (compact ? '全車' : '全車をそろえる')}
                  </button>
                ))}
              </div>
              {alignedSectorName && (
                <button
                  onClick={onClearAlignedSector}
                  title="セクターにそろえるのをやめる"
                  className="ml-1 px-1.5 py-0.5 rounded border border-amber-600/60 text-[10px] text-amber-300 hover:text-fg hover:bg-amber-700/40"
                >
                  {alignBaseMissing
                    ? `${alignedSectorName}: ${compact ? 'そろえられません' : '基準車がこの線を通っていないため、そろえられません'}`
                    : `${alignedSectorName} ${compact ? 'そろえ中' : 'にそろえ中'}${alignFailedCount > 0 ? `（${compact ? `${alignFailedCount} 台不可` : `${alignFailedCount} 台はそろえられません`}）` : ''}`} ✕
                </button>
              )}
            </div>
          )}
        </div>

        {/* ズーム */}
        <div className="flex items-center gap-1">
          {!compact && <span className="text-[10px] text-slate-400">拡大率:</span>}
          {[2, 3, 5].map(z => (
            <button
              key={z}
              onClick={() => setZoomLevel(z)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                zoomLevel === z ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400 hover:bg-surface-4'
              }`}
            >
              {z}x
            </button>
          ))}
        </div>
      </div>

      {/* Canvas */}
      <div className="relative flex-1 w-full h-full min-h-[200px]">
        <canvas ref={canvasRef} className="w-full h-full block" />
      </div>
    </div>
  );
};
