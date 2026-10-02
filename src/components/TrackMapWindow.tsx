import React, { useRef, useEffect, useState, useMemo } from 'react';
import { Lap, SelectedCarSlot, Sector, ControlLine } from '../types/telemetry';
import { Map, ZoomIn, ZoomOut, RotateCcw, Eye, Palette } from 'lucide-react';

interface TrackMapWindowProps {
  cars: {
    slot: SelectedCarSlot;
    lap: Lap;
  }[];
  controlLine?: ControlLine;
  sectors: Sector[];
  pathPolylines?: Array<Array<[number, number]>>;
  currentDistance: number;
  onSeekDistance: (distKm: number) => void;
}

export const TrackMapWindow: React.FC<TrackMapWindowProps> = ({
  cars,
  controlLine,
  sectors,
  pathPolylines,
  currentDistance,
  onSeekDistance
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [colorMode, setColorMode] = useState<'car' | 'speed' | 'accel'>('car');
  const [zoom, setZoom] = useState(1.0);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // 基準車
  const baseCar = cars[0];

  // 全座標のバウンディングボックス計算
  const bounds = useMemo(() => {
    let minLat = 90;
    let maxLat = -90;
    let minLon = 180;
    let maxLon = -180;

    const includePoint = (lat: number, lon: number) => {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    };

    // コースポリライン
    if (pathPolylines && pathPolylines.length > 0) {
      for (const poly of pathPolylines) {
        for (const [lon, lat] of poly) {
          includePoint(lat, lon);
        }
      }
    }

    // 車両ポイント
    for (const car of cars) {
      for (const p of car.lap.points) {
        includePoint(p.latitude, p.longitude);
      }
    }

    if (minLat === 90) {
      return { minLat: 35.37, maxLat: 35.38, minLon: 138.92, maxLon: 138.93 };
    }

    // パディング
    const latSpan = maxLat - minLat || 0.005;
    const lonSpan = maxLon - minLon || 0.005;

    return {
      minLat: minLat - latSpan * 0.08,
      maxLat: maxLat + latSpan * 0.08,
      minLon: minLon - lonSpan * 0.08,
      maxLon: maxLon + lonSpan * 0.08
    };
  }, [cars, pathPolylines]);

  // Canvas描画
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 400;
    const height = canvas.parentElement?.clientHeight || 400;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.scale(dpr, dpr);

    // 背景
    ctx.fillStyle = '#11141d';
    ctx.fillRect(0, 0, width, height);

    if (cars.length === 0 && (!pathPolylines || pathPolylines.length === 0)) {
      ctx.fillStyle = '#64748b';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('コースデータがありません', width / 2, height / 2);
      return;
    }

    // アスペクト比維持の座標変換
    const latMid = (bounds.minLat + bounds.maxLat) / 2;
    const lonMid = (bounds.minLon + bounds.maxLon) / 2;
    const cosLat = Math.cos((latMid * Math.PI) / 180);

    const geoWidth = (bounds.maxLon - bounds.minLon) * cosLat;
    const geoHeight = bounds.maxLat - bounds.minLat;

    const scaleX = (width * 0.85) / geoWidth;
    const scaleY = (height * 0.85) / geoHeight;
    const baseScale = Math.min(scaleX, scaleY) * zoom;

    const toScreen = (lat: number, lon: number) => {
      const x = width / 2 + (lon - lonMid) * cosLat * baseScale + panOffset.x;
      const y = height / 2 - (lat - latMid) * baseScale + panOffset.y;
      return { x, y };
    };

    // 1. コース形状ポリライン (.pth) の描画
    if (pathPolylines && pathPolylines.length > 0) {
      ctx.strokeStyle = '#273147';
      ctx.lineWidth = 14;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // 道路の下地 (アスファルト風)
      for (const poly of pathPolylines) {
        if (poly.length < 2) continue;
        ctx.beginPath();
        const start = toScreen(poly[0][1], poly[0][0]);
        ctx.moveTo(start.x, start.y);
        for (let i = 1; i < poly.length; i++) {
          const pt = toScreen(poly[i][1], poly[i][0]);
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();
      }

      // コース境界線
      ctx.strokeStyle = '#3b4866';
      ctx.lineWidth = 1.5;
      for (const poly of pathPolylines) {
        if (poly.length < 2) continue;
        ctx.beginPath();
        const start = toScreen(poly[0][1], poly[0][0]);
        ctx.moveTo(start.x, start.y);
        for (let i = 1; i < poly.length; i++) {
          const pt = toScreen(poly[i][1], poly[i][0]);
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();
      }
    }

    // 2. コントロールライン (スタート/フィニッシュ)
    if (controlLine) {
      const pA = toScreen(controlLine.latA, controlLine.lonA);
      const pB = toScreen(controlLine.latB, controlLine.lonB);

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.stroke();

      // チェッカー柄またはラベル
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('FINISH', (pA.x + pB.x) / 2, (pA.y + pB.y) / 2 - 6);
    }

    // 3. セクターゲート (S1, S2, S3...)
    sectors.forEach((sec, idx) => {
      const pA = toScreen(sec.latA, sec.lonA);
      const pB = toScreen(sec.latB, sec.lonB);

      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#facc15';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(sec.name || `S${idx + 1}`, (pA.x + pB.x) / 2, (pA.y + pB.y) / 2 - 5);
    });

    // 4. 車両の走行ライン (GPSトラック)
    cars.forEach(car => {
      const pts = car.lap.points;
      if (pts.length < 2) return;

      if (colorMode === 'car') {
        ctx.strokeStyle = car.slot.colorHex;
        ctx.lineWidth = car.slot.slot === 0 ? 3 : 2;
        ctx.beginPath();
        const start = toScreen(pts[0].latitude, pts[0].longitude);
        ctx.moveTo(start.x, start.y);
        for (let i = 1; i < pts.length; i++) {
          const pt = toScreen(pts[i].latitude, pts[i].longitude);
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();
      } else if (colorMode === 'speed') {
        // 車速ヒートマップ (低速: 青 〜 中速: 緑/黄 〜 高速: 赤)
        const maxSpd = car.lap.topSpeed || 150;
        const minSpd = car.lap.bottomSpeed || 40;
        const spdRange = Math.max(1, maxSpd - minSpd);

        ctx.lineWidth = 3;
        for (let i = 0; i < pts.length - 1; i++) {
          const p1 = toScreen(pts[i].latitude, pts[i].longitude);
          const p2 = toScreen(pts[i + 1].latitude, pts[i + 1].longitude);

          const ratio = Math.max(0, Math.min(1, (pts[i].speed - minSpd) / spdRange));
          // HSL: 240(Blue) -> 120(Green) -> 0(Red)
          const hue = (1 - ratio) * 240;
          ctx.strokeStyle = `hsl(${hue}, 100%, 50%)`;

          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }
      } else if (colorMode === 'accel') {
        // 加減速ヒートマップ (+加速: シアン, -減速: 赤/オレンジ)
        ctx.lineWidth = 3;
        for (let i = 0; i < pts.length - 1; i++) {
          const p1 = toScreen(pts[i].latitude, pts[i].longitude);
          const p2 = toScreen(pts[i + 1].latitude, pts[i + 1].longitude);

          const g = pts[i].accelG;
          if (g < -0.15) {
            // 減速 (赤)
            const alpha = Math.min(1, Math.abs(g) / 1.0);
            ctx.strokeStyle = `rgba(239, 68, 68, ${0.4 + alpha * 0.6})`;
          } else if (g > 0.1) {
            // 加速 (青/シアン)
            const alpha = Math.min(1, g / 0.5);
            ctx.strokeStyle = `rgba(6, 182, 212, ${0.4 + alpha * 0.6})`;
          } else {
            ctx.strokeStyle = '#64748b';
          }

          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }
      }
    });

    // 5. 各車両の現在位置マーカー
    cars.forEach(car => {
      const pts = car.lap.points;
      if (pts.length === 0) return;

      // 現在距離に最も近いポイントを探す
      const curPt = pts.reduce((prev, curr) => {
        return Math.abs(curr.distance - currentDistance) < Math.abs(prev.distance - currentDistance)
          ? curr
          : prev;
      }, pts[0]);

      const pos = toScreen(curPt.latitude, curPt.longitude);

      // 5. 各車両の進行方向を向いたレーシングカーアイコン描画
      ctx.save();
      ctx.translate(pos.x, pos.y);

      // 地理的Heading (0°:北/画面上, 90°:東/画面右, 180°:南/画面下, 270°:西/画面左)
      const headingRad = (curPt.heading * Math.PI) / 180;
      ctx.rotate(headingRad);

      // 車両シャドウ・グロー
      ctx.shadowColor = car.slot.colorHex;
      ctx.shadowBlur = 10;

      // レーシングカー型ポリゴン描画 (先端が前・画面上向き)
      ctx.fillStyle = car.slot.colorHex;
      ctx.beginPath();
      ctx.moveTo(0, -11); // ノーズ先端
      ctx.lineTo(4.5, -4); // 右フロントフェンダー
      ctx.lineTo(4, 6);   // 右サイド
      ctx.lineTo(7, 8);   // 右リアウィング端
      ctx.lineTo(7, 10);
      ctx.lineTo(0, 7.5); // リア中央イン
      ctx.lineTo(-7, 10); // 左リアウィング端
      ctx.lineTo(-7, 8);
      ctx.lineTo(-4, 6);  // 左サイド
      ctx.lineTo(-4.5, -4); // 左フロントフェンダー
      ctx.closePath();
      ctx.fill();

      // ウィンドシールド (コックピット白抜き)
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(2.5, -1);
      ctx.lineTo(2, 3);
      ctx.lineTo(-2, 3);
      ctx.lineTo(-2.5, -1);
      ctx.closePath();
      ctx.fill();

      // スロット番号表示 (1..4)
      ctx.fillStyle = '#0f1117';
      ctx.font = 'bold 7px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(car.slot.slot + 1), 0, 1);

      ctx.restore();
    });
  }, [cars, controlLine, sectors, pathPolylines, currentDistance, bounds, zoom, panOffset, colorMode]);

  // パン操作 (ドラッグ)
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsPanning(true);
    setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isPanning) return;
    setPanOffset({
      x: e.clientX - panStart.x,
      y: e.clientY - panStart.y
    });
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  // ホイールズーム
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    setZoom(z => Math.max(0.4, Math.min(10.0, z * factor)));
  };

  const handleReset = () => {
    setZoom(1.0);
    setPanOffset({ x: 0, y: 0 });
  };

  return (
    <div className="flex flex-col h-full bg-[#161922] rounded-lg border border-[#262c3d] overflow-hidden select-none shadow-lg">
      {/* ツールバー */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1b202d] border-b border-[#2a3245] text-xs">
        <div className="flex items-center gap-2">
          <span className="font-bold text-slate-200 flex items-center gap-1.5">
            <Map size={14} className="text-emerald-400" />
            全コースウインドウ
          </span>

          {/* カラーモード切替 */}
          <div className="flex items-center bg-[#12141c] rounded p-0.5 border border-[#2e374c]">
            <button
              onClick={() => setColorMode('car')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                colorMode === 'car' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              車両色
            </button>
            <button
              onClick={() => setColorMode('speed')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                colorMode === 'speed' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              車速ヒート
            </button>
            <button
              onClick={() => setColorMode('accel')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                colorMode === 'accel' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              加減速
            </button>
          </div>
        </div>

        {/* コントロール */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setZoom(z => Math.min(10, z * 1.25))}
            title="拡大"
            className="p-1 hover:bg-[#283247] rounded text-slate-300 transition-colors"
          >
            <ZoomIn size={14} />
          </button>
          <button
            onClick={() => setZoom(z => Math.max(0.4, z * 0.8))}
            title="縮小"
            className="p-1 hover:bg-[#283247] rounded text-slate-300 transition-colors"
          >
            <ZoomOut size={14} />
          </button>
          <button
            onClick={handleReset}
            title="初期位置に戻す"
            className="p-1 hover:bg-[#283247] rounded text-slate-300 transition-colors"
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="relative flex-1 w-full h-full min-h-[220px]">
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          className="w-full h-full cursor-grab active:cursor-grabbing block"
        />

        {/* 凡例 / ガイド */}
        {colorMode === 'speed' && (
          <div className="absolute bottom-2 left-2 bg-[#12141ce0] border border-[#2e374c] rounded px-2 py-1 text-[10px] text-slate-300 flex items-center gap-2">
            <span>低速 (青)</span>
            <div className="w-16 h-2 rounded bg-gradient-to-r from-blue-600 via-green-500 to-red-500"></div>
            <span>高速 (赤)</span>
          </div>
        )}
        {colorMode === 'accel' && (
          <div className="absolute bottom-2 left-2 bg-[#12141ce0] border border-[#2e374c] rounded px-2 py-1 text-[10px] text-slate-300 flex items-center gap-2">
            <span className="text-red-400">減速G (赤)</span>
            <div className="w-16 h-2 rounded bg-gradient-to-r from-red-500 via-slate-600 to-cyan-400"></div>
            <span className="text-cyan-400">加速G (青)</span>
          </div>
        )}
      </div>
    </div>
  );
};
