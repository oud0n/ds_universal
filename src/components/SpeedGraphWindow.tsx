import React, { useRef, useEffect, useState, useMemo } from 'react';
import { Lap, SelectedCarSlot, Sector } from '../types/telemetry';
import { calculateDeltaTimes } from '../services/lapCalculator';
import { ZoomIn, ZoomOut, RotateCcw, Activity, TrendingUp, Layers } from 'lucide-react';

interface SpeedGraphWindowProps {
  cars: {
    slot: SelectedCarSlot;
    lap: Lap;
  }[];
  sectors: Sector[];
  currentTime: number;          // 基準車の現在経過時間 (秒)
  currentDistance: number;      // 基準車の現在距離 (km)
  onSeekTime: (timeSec: number) => void;
  onSeekDistance: (distKm: number) => void;
}

export const SpeedGraphWindow: React.FC<SpeedGraphWindowProps> = ({
  cars,
  sectors,
  currentTime,
  currentDistance,
  onSeekTime,
  onSeekDistance
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 表示モード設定
  const [xAxisMode, setXAxisMode] = useState<'distance' | 'time'>('distance');
  const [showDeltaTime, setShowDeltaTime] = useState(true);
  const [showGOverlay, setShowGOverlay] = useState<'none' | 'accel' | 'corner' | 'combined'>('none');
  const [showAltitude, setShowAltitude] = useState(false);

  // ズーム & パン状態 (0..1 の正規化範囲)
  const [viewRange, setViewRange] = useState<[number, number]>([0, 1]);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartX, setDragStartX] = useState<number | null>(null);

  // 基準車 (Car 0: 赤)
  const baseCar = cars[0];

  // タイム差 (Delta Time) の事前計算
  const deltaTimes = useMemo(() => {
    if (!baseCar || cars.length < 2) return [];
    return cars.slice(1).map(c => calculateDeltaTimes(baseCar.lap.points, c.lap.points));
  }, [cars, baseCar]);

  // 最大距離または最大時間
  const maxDomain = useMemo(() => {
    if (cars.length === 0) return 1;
    if (xAxisMode === 'distance') {
      return Math.max(...cars.map(c => c.lap.distance), 1);
    } else {
      return Math.max(...cars.map(c => c.lap.lapTime), 1);
    }
  }, [cars, xAxisMode]);

  // 最高速度のスケール
  const maxSpeedY = useMemo(() => {
    if (cars.length === 0) return 200;
    const top = Math.max(...cars.map(c => c.lap.topSpeed), 100);
    return Math.ceil((top + 10) / 20) * 20; // 20km/h単位
  }, [cars]);

  // Canvas描画
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Retina対応
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 800;
    const height = canvas.parentElement?.clientHeight || 400;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.scale(dpr, dpr);

    // 背景
    ctx.fillStyle = '#141721';
    ctx.fillRect(0, 0, width, height);

    if (cars.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('走行データが選択されていません', width / 2, height / 2);
      return;
    }

    // マージン
    const paddingLeft = 55;
    const paddingRight = 45;
    const paddingTop = 25;
    const paddingBottom = 30;

    // デルタタイム領域の分割
    const hasDelta = showDeltaTime && xAxisMode === 'distance' && cars.length > 1;
    const speedHeight = hasDelta ? (height - paddingTop - paddingBottom) * 0.68 : height - paddingTop - paddingBottom;
    const deltaTop = paddingTop + speedHeight + 15;
    const deltaHeight = hasDelta ? height - deltaTop - paddingBottom : 0;
    const plotWidth = width - paddingLeft - paddingRight;

    // ビューレンジ適用 (ズーム)
    const [zoomMin, zoomMax] = viewRange;
    const activeDomainStart = zoomMin * maxDomain;
    const activeDomainEnd = zoomMax * maxDomain;
    const activeDomainRange = Math.max(0.0001, activeDomainEnd - activeDomainStart);

    const getX = (val: number) => {
      return paddingLeft + ((val - activeDomainStart) / activeDomainRange) * plotWidth;
    };

    const getSpeedY = (spd: number) => {
      return paddingTop + speedHeight - (spd / maxSpeedY) * speedHeight;
    };

    // グリッド線 (速度)
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#222838';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#64748b';

    const speedStep = maxSpeedY <= 150 ? 25 : 50;
    for (let s = 0; s <= maxSpeedY; s += speedStep) {
      const y = getSpeedY(s);
      ctx.beginPath();
      ctx.moveTo(paddingLeft, y);
      ctx.lineTo(width - paddingRight, y);
      ctx.stroke();
      ctx.fillText(`${s} km/h`, paddingLeft - 8, y + 3);
    }

    // グリッド線 (X軸: 距離または時間)
    ctx.textAlign = 'center';
    const xStep = xAxisMode === 'distance' ? (maxDomain > 5 ? 1 : 0.5) : (maxDomain > 60 ? 20 : 10);
    for (let xVal = 0; xVal <= maxDomain; xVal += xStep) {
      if (xVal >= activeDomainStart && xVal <= activeDomainEnd) {
        const x = getX(xVal);
        ctx.beginPath();
        ctx.moveTo(x, paddingTop);
        ctx.lineTo(x, paddingTop + speedHeight);
        if (hasDelta) {
          ctx.lineTo(x, deltaTop + deltaHeight);
        }
        ctx.stroke();

        const label = xAxisMode === 'distance' ? `${xVal.toFixed(1)} km` : `${xVal.toFixed(0)} s`;
        ctx.fillText(label, x, height - 10);
      }
    }

    // セクターライン描画
    if (sectors.length > 0 && baseCar) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#eab308';
      ctx.fillStyle = '#facc15';
      ctx.font = 'bold 10px sans-serif';

      baseCar.lap.sectors.forEach(secRes => {
        const secVal = xAxisMode === 'distance' ? secRes.distance : secRes.splitTime;
        if (secVal >= activeDomainStart && secVal <= activeDomainEnd) {
          const sx = getX(secVal);
          ctx.beginPath();
          ctx.moveTo(sx, paddingTop - 5);
          ctx.lineTo(sx, paddingTop + speedHeight);
          ctx.stroke();

          ctx.fillText(secRes.sectorName, sx, paddingTop - 8);
        }
      });
      ctx.setLineDash([]);
    }

    // 標高グラフオーバーレイ
    if (showAltitude && baseCar) {
      const pts = baseCar.lap.points;
      if (pts.length > 0) {
        const maxAlt = Math.max(...pts.map(p => p.altitude), 10);
        const minAlt = Math.min(...pts.map(p => p.altitude), 0);
        const altRange = Math.max(1, maxAlt - minAlt);

        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false;

        for (const p of pts) {
          const xVal = xAxisMode === 'distance' ? p.distance : p.time;
          if (xVal >= activeDomainStart && xVal <= activeDomainEnd) {
            const x = getX(xVal);
            const y = paddingTop + speedHeight - ((p.altitude - minAlt) / altRange) * (speedHeight * 0.4);
            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
        }
        ctx.stroke();
      }
    }

    // Gフォースオーバーレイ
    if (showGOverlay !== 'none' && baseCar) {
      const pts = baseCar.lap.points;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;

      for (const p of pts) {
        const xVal = xAxisMode === 'distance' ? p.distance : p.time;
        if (xVal >= activeDomainStart && xVal <= activeDomainEnd) {
          const x = getX(xVal);
          let gVal = 0;
          if (showGOverlay === 'accel') gVal = p.accelG;
          else if (showGOverlay === 'corner') gVal = Math.abs(p.corneringG);
          else if (showGOverlay === 'combined') gVal = p.combinedG;

          // 0Gが中心, ±2Gでスケーリング
          const y = paddingTop + speedHeight * 0.5 - (gVal / 2.0) * (speedHeight * 0.4);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.strokeStyle = '#a855f7';
      ctx.stroke();
    }

    // 速度グラフ描画 (各車両)
    cars.forEach(carItem => {
      const { slot, lap } = carItem;
      ctx.strokeStyle = slot.colorHex;
      ctx.lineWidth = slot.slot === 0 ? 2.5 : 2.0;
      ctx.beginPath();

      let started = false;
      for (const p of lap.points) {
        const xVal = xAxisMode === 'distance' ? p.distance : p.time;
        if (xVal >= activeDomainStart - 0.1 && xVal <= activeDomainEnd + 0.1) {
          const x = getX(xVal);
          const y = getSpeedY(p.speed);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
    });

    // タイム差グラフ (Delta Time) 描画
    if (hasDelta) {
      // デルタ背景とゼロ線
      ctx.fillStyle = '#10131d';
      ctx.fillRect(paddingLeft, deltaTop, plotWidth, deltaHeight);

      const zeroY = deltaTop + deltaHeight / 2;
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(paddingLeft, zeroY);
      ctx.lineTo(width - paddingRight, zeroY);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText('0.00s', paddingLeft - 6, zeroY + 3);
      ctx.fillText('+1.0s', paddingLeft - 6, zeroY - deltaHeight * 0.35 + 3);
      ctx.fillText('-1.0s', paddingLeft - 6, zeroY + deltaHeight * 0.35 + 3);

      // 最大デルタレンジ (±2秒をデフォルト)
      const maxDelta = 2.0;

      cars.slice(1).forEach((targetCar, cIdx) => {
        const dVals = deltaTimes[cIdx] || [];
        ctx.strokeStyle = targetCar.slot.colorHex;
        ctx.lineWidth = 2.0;
        ctx.beginPath();

        let started = false;
        baseCar.lap.points.forEach((p, pIdx) => {
          const delta = dVals[pIdx] || 0;
          if (p.distance >= activeDomainStart && p.distance <= activeDomainEnd) {
            const x = getX(p.distance);
            // delta > 0: 赤がリード (上方向)
            const y = zeroY - (delta / maxDelta) * (deltaHeight * 0.45);
            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
        });
        ctx.stroke();
      });
    }

    // 現在シーク位置カーソル (赤ライン)
    const currentCursorX = getX(xAxisMode === 'distance' ? currentDistance : currentTime);
    if (currentCursorX >= paddingLeft && currentCursorX <= width - paddingRight) {
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(currentCursorX, paddingTop - 5);
      ctx.lineTo(currentCursorX, height - paddingBottom);
      ctx.stroke();

      // 三角マーカー (公式アプリ準拠)
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.moveTo(currentCursorX - 5, paddingTop - 5);
      ctx.lineTo(currentCursorX + 5, paddingTop - 5);
      ctx.lineTo(currentCursorX, paddingTop + 2);
      ctx.closePath();
      ctx.fill();
    }
  }, [
    cars,
    sectors,
    currentTime,
    currentDistance,
    xAxisMode,
    showDeltaTime,
    showGOverlay,
    showAltitude,
    viewRange,
    maxDomain,
    maxSpeedY,
    deltaTimes,
    baseCar
  ]);

  // クリック・ドラッグでシーク操作
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    const paddingLeft = 55;
    const paddingRight = 45;
    const plotWidth = rect.width - paddingLeft - paddingRight;

    if (x >= paddingLeft && x <= rect.width - paddingRight) {
      setIsDragging(true);
      setDragStartX(x);
      seekToX(x, rect.width);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    seekToX(x, rect.width);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const seekToX = (x: number, containerWidth: number) => {
    const paddingLeft = 55;
    const paddingRight = 45;
    const plotWidth = containerWidth - paddingLeft - paddingRight;

    const ratio = Math.max(0, Math.min(1, (x - paddingLeft) / plotWidth));
    const [zoomMin, zoomMax] = viewRange;
    const activeDomainStart = zoomMin * maxDomain;
    const activeDomainEnd = zoomMax * maxDomain;

    const val = activeDomainStart + ratio * (activeDomainEnd - activeDomainStart);

    if (xAxisMode === 'distance') {
      onSeekDistance(val);
    } else {
      onSeekTime(val);
    }
  };

  // ズームイン / ズームアウト
  const handleZoom = (direction: 'in' | 'out') => {
    setViewRange(([min, max]) => {
      const center = (min + max) / 2;
      const span = max - min;
      const factor = direction === 'in' ? 0.65 : 1.5;
      const newSpan = Math.max(0.05, Math.min(1.0, span * factor));
      const newMin = Math.max(0, center - newSpan / 2);
      const newMax = Math.min(1, newMin + newSpan);
      return [newMin, newMax];
    });
  };

  const handleResetZoom = () => {
    setViewRange([0, 1]);
  };

  return (
    <div className="flex flex-col h-full bg-[#161922] rounded-lg border border-[#262c3d] overflow-hidden select-none shadow-lg">
      {/* ツールバー */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1b202d] border-b border-[#2a3245] text-xs">
        <div className="flex items-center gap-2">
          <span className="font-bold text-slate-200 flex items-center gap-1.5">
            <TrendingUp size={14} className="text-red-500" />
            速度ウインドウ
          </span>

          {/* 横軸切替 */}
          <div className="flex bg-[#12141c] rounded p-0.5 border border-[#2e374c]">
            <button
              onClick={() => setXAxisMode('distance')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                xAxisMode === 'distance' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              距離 (km)
            </button>
            <button
              onClick={() => setXAxisMode('time')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                xAxisMode === 'time' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              時間 (sec)
            </button>
          </div>

          {/* タイム差トグル */}
          {xAxisMode === 'distance' && cars.length > 1 && (
            <button
              onClick={() => setShowDeltaTime(!showDeltaTime)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border transition-all ${
                showDeltaTime
                  ? 'bg-blue-950/80 border-blue-500/80 text-blue-300'
                  : 'border-[#333d54] text-slate-400 hover:text-slate-200'
              }`}
            >
              タイム差 (Delta)
            </button>
          )}

          {/* Gフォースオーバーレイ切替 */}
          <div className="flex items-center gap-1">
            <span className="text-slate-400 text-[11px] ml-1">G表示:</span>
            <select
              value={showGOverlay}
              onChange={e => setShowGOverlay(e.target.value as any)}
              className="bg-[#12141c] border border-[#2e374c] text-[11px] text-slate-300 rounded px-1.5 py-0.5 outline-none"
            >
              <option value="none">OFF</option>
              <option value="accel">加減速G (縦G)</option>
              <option value="corner">横G (コーナリングG)</option>
              <option value="combined">合算G</option>
            </select>
          </div>

          {/* 標高切替 */}
          <button
            onClick={() => setShowAltitude(!showAltitude)}
            className={`px-2 py-0.5 rounded text-[11px] border transition-all ${
              showAltitude
                ? 'bg-slate-800 border-slate-500 text-slate-200'
                : 'border-[#333d54] text-slate-400 hover:text-slate-200'
            }`}
          >
            標高
          </button>
        </div>

        {/* ズーム操作 */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleZoom('in')}
            title="拡大"
            className="p-1 hover:bg-[#283247] rounded text-slate-300 transition-colors"
          >
            <ZoomIn size={14} />
          </button>
          <button
            onClick={() => handleZoom('out')}
            title="縮小"
            className="p-1 hover:bg-[#283247] rounded text-slate-300 transition-colors"
          >
            <ZoomOut size={14} />
          </button>
          <button
            onClick={handleResetZoom}
            title="全体表示 (リセット)"
            className="p-1 hover:bg-[#283247] rounded text-slate-300 transition-colors"
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>

      {/* メインCanvas */}
      <div className="relative flex-1 w-full h-full min-h-[220px]">
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          className="w-full h-full cursor-crosshair block"
        />

        {/* 右上リアルタイム数値インジケーター */}
        <div className="absolute top-2 right-3 bg-[#11131adb] backdrop-blur-sm border border-[#2b3347] rounded-md p-2 text-xs flex flex-col gap-1 shadow-md pointer-events-none min-w-[130px]">
          {cars.map((c, idx) => {
            // 現在のポイント検索
            const pts = c.lap.points;
            let curPt = pts[0];
            if (pts.length > 0) {
              const targetVal = xAxisMode === 'distance' ? currentDistance : currentTime;
              curPt = pts.reduce((prev, curr) => {
                const prevDiff = Math.abs((xAxisMode === 'distance' ? prev.distance : prev.time) - targetVal);
                const currDiff = Math.abs((xAxisMode === 'distance' ? curr.distance : curr.time) - targetVal);
                return currDiff < prevDiff ? curr : prev;
              }, pts[0]);
            }

            return (
              <div key={idx} className="flex items-center justify-between font-mono">
                <span className="flex items-center gap-1.5 font-bold" style={{ color: c.slot.colorHex }}>
                  <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: c.slot.colorHex }}></span>
                  {c.slot.label}:
                </span>
                <span className="font-bold text-slate-100">{curPt ? curPt.speed.toFixed(1) : '0.0'} km/h</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
