import React, { useRef, useEffect, useState } from 'react';
import { Lap, SelectedCarSlot, Sector } from '../types/telemetry';
import { Play, Pause, SkipBack, SkipForward, PlaySquare, Compass, Eye } from 'lucide-react';

interface ReplayWindowProps {
  cars: {
    slot: SelectedCarSlot;
    lap: Lap;
  }[];
  sectors: Sector[];
  currentTime: number;
  currentDistance: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStepForward: () => void;
  onStepBack: () => void;
  onSeekDistance: (dist: number) => void;
  onSyncSectorStart: (sectorIndex: number) => void;
}

export const ReplayWindow: React.FC<ReplayWindowProps> = ({
  cars,
  sectors,
  currentTime,
  currentDistance,
  isPlaying,
  onTogglePlay,
  onStepForward,
  onStepBack,
  onSeekDistance,
  onSyncSectorStart
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [followCar, setFollowCar] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(3.0); // クローズアップ倍率

  const baseCar = cars[0];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 400;
    const height = canvas.parentElement?.clientHeight || 300;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.scale(dpr, dpr);

    // 背景 (ダークサーキット)
    ctx.fillStyle = '#0f121a';
    ctx.fillRect(0, 0, width, height);

    if (cars.length === 0 || !baseCar) {
      ctx.fillStyle = '#64748b';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('再生データがありません', width / 2, height / 2);
      return;
    }

    // 基準車の現在位置と向き
    const basePts = baseCar.lap.points;
    const curBasePt = basePts.reduce((prev, curr) => {
      return Math.abs(curr.distance - currentDistance) < Math.abs(prev.distance - currentDistance)
        ? curr
        : prev;
    }, basePts[0]);

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

    // 1. 周辺トラック (アスファルト幅)
    ctx.strokeStyle = '#22283a';
    ctx.lineWidth = 32;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    let started = false;
    for (const p of basePts) {
      const { x, y } = toScreen(p.latitude, p.longitude);
      if (x >= -50 && x <= width + 50 && y >= -50 && y <= height + 50) {
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
    }
    ctx.stroke();

    // コース境界白線
    ctx.strokeStyle = '#384259';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 2. 各車両の走行ライン
    cars.forEach(car => {
      const pts = car.lap.points;
      ctx.strokeStyle = car.slot.colorHex + '80'; // 透過
      ctx.lineWidth = 2;
      ctx.beginPath();
      let trackStarted = false;

      for (const p of pts) {
        const { x, y } = toScreen(p.latitude, p.longitude);
        if (x >= -40 && x <= width + 40 && y >= -40 && y <= height + 40) {
          if (!trackStarted) {
            ctx.moveTo(x, y);
            trackStarted = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
    });

    // 3. 各車両のリアルタイムアニメーション描画 (車両ボディ & 進行方向)
    cars.forEach(car => {
      const pts = car.lap.points;
      if (pts.length === 0) return;

      const pt = pts.reduce((prev, curr) => {
        return Math.abs(curr.distance - currentDistance) < Math.abs(prev.distance - currentDistance)
          ? curr
          : prev;
      }, pts[0]);

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
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${pt.speed.toFixed(0)} km/h`, pos.x, pos.y - 14);
    });

    // 4. クリップ位置・距離インジケーター
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`Dist: ${currentDistance.toFixed(3)} km`, 10, height - 12);
    ctx.fillText(`Time: ${currentTime.toFixed(2)} s`, 10, height - 24);
  }, [cars, baseCar, currentDistance, currentTime, zoomLevel, followCar]);

  return (
    <div className="flex flex-col h-full bg-[#161922] rounded-lg border border-[#262c3d] overflow-hidden select-none shadow-lg">
      {/* ツールバー */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1b202d] border-b border-[#2a3245] text-xs">
        <div className="flex items-center gap-2">
          <span className="font-bold text-slate-200 flex items-center gap-1.5">
            <PlaySquare size={14} className="text-amber-400" />
            アニメーション再生
          </span>

          {/* セクター同時スタートボタン */}
          {sectors.length > 0 && (
            <div className="flex items-center gap-1 ml-2">
              <span className="text-[10px] text-slate-400 font-medium">同時スタート:</span>
              <div className="flex gap-1">
                {sectors.map((sec, idx) => (
                  <button
                    key={sec.id}
                    onClick={() => onSyncSectorStart(idx)}
                    title={`${sec.name} から全車一斉スタート`}
                    className="px-1.5 py-0.5 rounded bg-[#232a3d] hover:bg-amber-600 hover:text-white text-slate-300 text-[10px] font-bold border border-[#343e59] transition-all"
                  >
                    {sec.name || `S${idx + 1}`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ズーム */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-slate-400">拡大率:</span>
          {[2, 3, 5].map(z => (
            <button
              key={z}
              onClick={() => setZoomLevel(z)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                zoomLevel === z ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400 hover:bg-[#252c3e]'
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
