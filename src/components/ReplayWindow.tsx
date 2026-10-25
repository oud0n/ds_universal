import React, { useRef, useEffect, useState } from 'react';
import { canvasColors, useResolvedTheme } from '../utils/theme';
import { useCompactLayout } from '../hooks/useCompactLayout';
import { Lap, SelectedCarSlot, Sector, CompareAxis } from '../types/telemetry';
import { Play, Pause, SkipBack, SkipForward, PlaySquare, Compass, Eye } from 'lucide-react';
import { findCarPoint } from '../utils/telemetrySearch';
import { getPointGrid, pointsInBounds } from '../utils/pointGrid';
import { prepareCanvas, useDevicePixelRatio } from '../utils/canvasLayer';
import { tr, useLang, useT } from '../utils/i18n';
import { SectorStartBar } from './SectorStartBar';

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
  const t = useT();
  // 言語を切り替えたら canvas の文字も描き直す
  const lang = useLang();
  // 解像度の違うディスプレイへ移したら描き直す
  const dpr = useDevicePixelRatio();
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
    // テーマの色 (テーマを切り替えたら描き直す)
    const C = canvasColors();

    // 隠しているとき (たたんだウインドウ・切り替えで見えていないパネル) は描かない。見えたら大きさの変化で描き直す
    const width = canvas.parentElement?.clientWidth ?? 0;
    const height = canvas.parentElement?.clientHeight ?? 0;
    if (width === 0 || height === 0) return;
    // 車両を追いかけて毎コマ描き直すので、canvas は大きさが変わったときだけ作り直す
    const ctx = prepareCanvas(canvas, width, height);
    if (!ctx) return;

    // 背景 (ダークサーキット)
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, width, height);

    if (cars.length === 0 || !baseCar) {
      ctx.fillStyle = C.axis;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(tr('再生データがありません', 'Nothing to play'), width / 2, height / 2);
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

    // 軌跡のうち画面の近くの部分だけを描く。点の索引で画面の近くの点だけを調べる (点の多いログで毎コマ全部の点を見ると重いため)。
    // 続いた点の並びごとに線を引き、前後の 1 点まで含めて画面の端まで届かせる
    // (離れた並びを 1 本につなぐと、出る直前の点と戻ってきた点が直線で結ばれ、コースを横切る線が出るため)
    const traceVisible = (pts: typeof basePts, margin: number) => {
      const halfLat = (height / 2 + margin) / scale;
      const halfLon = (width / 2 + margin) / (cosLat * scale);
      const idx = pointsInBounds(getPointGrid(pts), centerLat - halfLat, centerLat + halfLat, centerLon - halfLon, centerLon + halfLon);
      ctx.beginPath();
      let k = 0;
      while (k < idx.length) {
        let end = k;
        while (end + 1 < idx.length && idx[end + 1] === idx[end] + 1) end++;
        const from = Math.max(0, idx[k] - 1);
        const to = Math.min(pts.length - 1, idx[end] + 1);
        const start = toScreen(pts[from].latitude, pts[from].longitude);
        ctx.moveTo(start.x, start.y);
        for (let i = from + 1; i <= to; i++) {
          const cur = toScreen(pts[i].latitude, pts[i].longitude);
          ctx.lineTo(cur.x, cur.y);
        }
        k = end + 1;
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
    // 速さの文字を書いた位置 (近くを走る車の文字が重なって読めなくならないよう、重なるときは上へずらす)
    const labelSpots: Array<{ x: number; y: number }> = [];
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

      // 車両ラベル・速度タグ。2 台以上のときは車の色で書き、重なるときは上へずらす
      let labelY = pos.y - 14;
      while (labelSpots.some(p => Math.abs(p.x - pos.x) < 64 && Math.abs(p.y - labelY) < 12)) labelY -= 12;
      labelSpots.push({ x: pos.x, y: labelY });
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = C.bg;
      ctx.strokeText(`${pt.speed.toFixed(0)} km/h`, pos.x, labelY);
      ctx.fillStyle = cars.length > 1 ? car.slot.colorHex : C.strong;
      ctx.fillText(`${pt.speed.toFixed(0)} km/h`, pos.x, labelY);
    });

    // 4. クリップ位置・距離インジケーター
    ctx.fillStyle = C.label;
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`Dist: ${currentDistance.toFixed(3)} km`, 10, height - 12);
    ctx.fillText(`Time: ${currentTime.toFixed(2)} s`, 10, height - 24);
  }, [cars, baseCar, currentDistance, currentTime, compareAxis, zoomLevel, followCar, theme, resizeTick, dpr, lang]);

  return (
    <div className="flex flex-col h-full bg-surface-2 rounded-lg border border-line-2 overflow-hidden select-none shadow-lg">
      {/* ツールバー */}
      {/* 狭いときはボタン単位で折り返す (文字の途中で折れないよう nowrap) */}
      <div className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 bg-surface-3 border-b border-line-2 text-xs whitespace-nowrap shrink-0 ${compact ? 'px-2 py-1' : 'px-3 py-1.5'}`}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {!compact && (
            <span className="font-bold text-slate-200 flex items-center gap-1.5">
              <PlaySquare size={14} className="text-amber-400" />
              {t('アニメーション再生', 'Animation')}
            </span>
          )}

          {/* セクター同時スタートボタン */}
          <SectorStartBar
            compact={compact}
            sectors={sectors}
            onSyncSectorStart={onSyncSectorStart}
            sectorStartMode={sectorStartMode}
            onChangeSectorStartMode={onChangeSectorStartMode}
            alignedSectorName={alignedSectorName}
            alignFailedCount={alignFailedCount}
            alignBaseMissing={alignBaseMissing}
            onClearAlignedSector={onClearAlignedSector}
          />
        </div>

        {/* ズーム */}
        <div className="flex items-center gap-1">
          {!compact && <span className="text-[10px] text-slate-400">{t('拡大率:', 'Zoom:')}</span>}
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
      <div className={`relative flex-1 w-full h-full ${compact ? 'min-h-0' : 'min-h-[200px]'}`}>
        <canvas ref={canvasRef} className="w-full h-full block" />
      </div>
    </div>
  );
};
