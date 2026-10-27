import React, { useRef, useEffect, useState, useMemo } from 'react';
import { availableChannels, channelDef, type ChannelId } from '../services/overlayLayout';
import { useCsvFormats } from '../services/csvFormatStore';
import { getLang } from '../utils/i18n';

const STRIPS_KEY = 'ds_graph_strips';
const MAX_STRIPS = 4;
const STRIP_H = 34;
const STRIP_GAP = 6;
import { canvasColors, useResolvedTheme } from '../utils/theme';
import { useCompactLayout } from '../hooks/useCompactLayout';
import { usePinchPointers } from '../hooks/usePinchPointers';
import { CompareAxis, Lap, SelectedCarSlot, Sector } from '../types/telemetry';
import { calculateDeltaTimes } from '../services/lapCalculator';
import { findClosestPointByDistance, findClosestPointByTime } from '../utils/telemetrySearch';
import { prepareCanvas, useDevicePixelRatio } from '../utils/canvasLayer';
import { tr, useLang, useT } from '../utils/i18n';
import { ZoomIn, ZoomOut, RotateCcw, Activity, Layers } from 'lucide-react';

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
  // 横軸 (距離 / 時間)。全コースウインドウなど他のウインドウの車両位置もこの基準に合わせるため、App 側で持つ
  xAxisMode: CompareAxis;
  onChangeXAxisMode: (mode: CompareAxis) => void;
  // セクターにそろえているときの、そろえた位置の基準車の時刻 (秒)。時間基準ではそれより前を薄く描き、そこから表示する
  alignStartTime?: number;
}

export const SpeedGraphWindow: React.FC<SpeedGraphWindowProps> = ({
  cars,
  sectors,
  currentTime,
  currentDistance,
  onSeekTime,
  onSeekDistance,
  xAxisMode,
  onChangeXAxisMode: setXAxisMode,
  alignStartTime
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
  // 現在位置のカーソルだけを描く、上に重ねた canvas (再生中はこちらだけを描き直す)
  const cursorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // 下の canvas を描いたときの配置 (カーソルの位置の計算に使う)
  const layoutRef = useRef<{
    width: number; height: number; paddingLeft: number; paddingRight: number; paddingTop: number; paddingBottom: number;
    domainStart: number; domainRange: number; plotWidth: number;
  } | null>(null);

  // 表示モード設定
  const [showDeltaTime, setShowDeltaTime] = useState(true);
  const [showGOverlay, setShowGOverlay] = useState<'none' | 'accel' | 'corner' | 'combined'>('none');
  const [showAltitude, setShowAltitude] = useState(false);
  // アクセル・ブレーキ (記録されているログだけ。いまは iRacing の .ibt)
  const [showPedals, setShowPedals] = useState(true);
  // 速度グラフの下の値の帯 (自分で名前を付けた値・回転数など。値ごとに自分の目盛り。PLAN-36)
  const [stripIds, setStripIdsState] = useState<ChannelId[]>(() => {
    try { const v = JSON.parse(localStorage.getItem(STRIPS_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is ChannelId => typeof x === 'string').slice(0, MAX_STRIPS) : []; } catch { return []; }
  });
  const setStripIds = (ids: ChannelId[]) => { setStripIdsState(ids); try { localStorage.setItem(STRIPS_KEY, JSON.stringify(ids)); } catch { /* 覚えられなくても今は出す */ } };
  const [stripMenu, setStripMenu] = useState(false);
  const stripMenuRef = useRef<HTMLDivElement>(null);
  // 値の帯の選び方は、外を押す・Esc で閉じる (開いたまま、グラフの上に残っていた)
  useEffect(() => {
    if (!stripMenu) return;
    const onDown = (e: PointerEvent) => { if (!stripMenuRef.current?.contains(e.target as Node)) setStripMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setStripMenu(false); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey); };
  }, [stripMenu]);
  // 計算式・CSV の形式を読み終えたら、選べる値を作り直す (自分で名前を付けた値は、あとから読まれる)
  const csvDefs = useCsvFormats();
  // 帯に出せる値 (どれかの車のログにあるもの。速度・G は上のグラフにあるので除く)
  const stripChoices = useMemo(() => {
    const ids = new Set<ChannelId>();
    for (const c of cars) for (const id of availableChannels({ points: c.lap.points } as unknown as Parameters<typeof availableChannels>[0])) ids.add(id);
    return [...ids].filter(id => !['speed', 'accelG', 'corneringG', 'combinedG', 'altitude'].includes(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cars, csvDefs]);
  const strips = stripIds.filter(id => stripChoices.includes(id));

  // ズーム & パン状態 (0..1 の正規化範囲)
  const [viewRange, setViewRange] = useState<[number, number]>([0, 1]);
  const [isDragging, setIsDragging] = useState(false);
  // ドラッグ中か (state は描き直すまで変わらないので、同じイベントの中で続けて読めるよう ref にも持つ)
  const draggingRef = useRef(false);
  const [dragStartX, setDragStartX] = useState<number | null>(null);

  // 基準車 (Car 0: 赤)
  const baseCar = cars[0];
  const hasPedals = useMemo(() => cars.some(c => c.lap.points.some(p => p.throttle !== undefined || p.brake !== undefined)), [cars]);

  // タイム差 (Delta Time) の事前計算
  const deltaTimes = useMemo(() => {
    if (!baseCar || cars.length < 2) return [];
    return cars.slice(1).map(c => calculateDeltaTimes(baseCar.lap.points, c.lap.points));
  }, [cars, baseCar]);

  // 最大距離または最大時間
  const maxDomain = useMemo(() => {
    if (cars.length === 0) return 1;
    if (xAxisMode === 'distance') {
      // 距離補正で後ろへずらした車両は、末尾が 1 周の距離より先に出るので、最後の点の距離も見る
      return Math.max(...cars.map(c => Math.max(c.lap.distance, c.lap.points[c.lap.points.length - 1]?.distance ?? 0)), 1);
    } else {
      // セクターにそろえて時刻をずらした車両は、末尾が周のタイムより先に出るので、最後の点の時刻も見る
      return Math.max(...cars.map(c => Math.max(c.lap.lapTime, c.lap.points[c.lap.points.length - 1]?.time ?? 0)), 1);
    }
  }, [cars, xAxisMode]);

  // 現在位置のカーソルの、全体に対する位置 (0..1)
  const cursorRatio = Math.max(0, Math.min(1, (xAxisMode === 'distance' ? currentDistance : currentTime) / maxDomain));

  // 最高速度のスケール
  const maxSpeedY = useMemo(() => {
    if (cars.length === 0) return 200;
    const top = Math.max(...cars.map(c => c.lap.topSpeed), 100);
    return Math.ceil((top + 10) / 20) * 20; // 20km/h単位
  }, [cars]);

  // 表示領域の大きさが変わったら描き直す (スマートフォンを回したとき・ルーラーが出たときなど)
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setResizeTick(t => t + 1));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  // 右上の値の箱を左へ寄せるか (カーソルを描くときに決める)
  const [valueBoxOnLeft, setValueBoxOnLeft] = useState(false);
  // 現在位置のカーソルを、上に重ねた canvas に描く (下の canvas を描いた配置を使う)
  const cursorValueRef = useRef(0);
  cursorValueRef.current = xAxisMode === 'distance' ? currentDistance : currentTime;
  const drawCursor = () => {
    const layout = layoutRef.current;
    const canvas = cursorCanvasRef.current;
    if (!canvas) return;
    if (!layout) {
      // 下の canvas を描いていないとき (車両がない・隠れている) は何も出さない
      const w = canvas.parentElement?.clientWidth ?? 0;
      const h = canvas.parentElement?.clientHeight ?? 0;
      if (w > 0 && h > 0) prepareCanvas(canvas, w, h);
      return;
    }
    const { width, height, paddingLeft, paddingRight, paddingTop, paddingBottom, domainStart, domainRange, plotWidth } = layout;
    const ctx = prepareCanvas(canvas, width, height);
    if (!ctx) return;
    const currentCursorX = paddingLeft + ((cursorValueRef.current - domainStart) / domainRange) * plotWidth;
    // 赤い線が右寄り (グラフの 6 割より右) なら、右上の値の箱を左へ寄せる (描いた配置で決める。同じなら描き直さない)
    const onLeft = domainRange > 0 && (cursorValueRef.current - domainStart) / domainRange > 0.6;
    setValueBoxOnLeft(prev => (prev === onLeft ? prev : onLeft));
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
  };
  // 再生中はカーソルだけを描き直す
  useEffect(() => {
    drawCursor();
  }, [currentTime, currentDistance, xAxisMode]);

  // Canvas描画 (現在位置のカーソル以外。再生では描き直さない)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // テーマの色 (テーマを切り替えたら描き直す)
    const C = canvasColors();

    // 隠しているとき (たたんだウインドウ・切り替えで見えていないパネル) は描かない。見えたら大きさの変化で描き直す
    const width = canvas.parentElement?.clientWidth ?? 0;
    const height = canvas.parentElement?.clientHeight ?? 0;
    layoutRef.current = null;
    if (width === 0 || height === 0) return;
    const ctx = prepareCanvas(canvas, width, height);
    if (!ctx) return;

    // 背景
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, width, height);

    if (cars.length === 0) {
      ctx.fillStyle = C.axis;
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(tr('走行データが選択されていません', 'No driving data selected'), width / 2, height / 2);
      drawCursor();
      return;
    }

    // マージン
    const paddingLeft = 55;
    const paddingRight = 45;
    const paddingTop = 25;
    const paddingBottom = 30;

    // デルタタイム領域の分割
    // (高さが足りず、タイム差の欄が 30px 取れないときは描かない。スマートフォンを横にしたときなど)
    const hasDelta = showDeltaTime && xAxisMode === 'distance' && cars.length > 1 && (height - paddingTop - paddingBottom) * 0.32 - 15 >= 30;
    const speedFull = hasDelta ? (height - paddingTop - paddingBottom) * 0.68 : height - paddingTop - paddingBottom;
    // 値の帯は速度グラフの下 (速度の高さが 80px より小さくならない分だけ)
    const stripCount = Math.max(0, Math.min(strips.length, Math.floor((speedFull - 80) / (STRIP_H + STRIP_GAP))));
    const stripTotal = stripCount * (STRIP_H + STRIP_GAP);
    const speedHeight = speedFull - stripTotal;
    const deltaTop = paddingTop + speedFull + 15;
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
    ctx.strokeStyle = C.grid;
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = C.axis;

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
      ctx.strokeStyle = C.sectorLine;
      ctx.fillStyle = C.sector;
      ctx.font = 'bold 10px sans-serif';

      baseCar.lap.sectors.forEach(secRes => {
        // セクター線の位置は計測線からの累積 (distance は区間の長さなので使わない)
        const secVal = xAxisMode === 'distance' ? secRes.splitDistance : secRes.splitTime;
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
        // 点数が多いログでも引数の上限に当たらないよう、ループで求める
        let maxAlt = 10;
        let minAlt = 0;
        for (const p of pts) {
          if (p.altitude > maxAlt) maxAlt = p.altitude;
          if (p.altitude < minAlt) minAlt = p.altitude;
        }
        const altRange = Math.max(1, maxAlt - minAlt);

        ctx.strokeStyle = C.axis;
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

    // アクセル (実線)・ブレーキ (点線) を、記録のある車両ごとにその車両の色で、速度グラフの下の 3 割に描く (0〜100%)
    if (showPedals && hasPedals) {
      const bandBottom = paddingTop + speedHeight;
      const bandHeight = speedHeight * 0.3;
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.2;
      for (const { slot, lap } of cars) {
        for (const key of ['throttle', 'brake'] as const) {
          if (!lap.points.some(p => p[key] !== undefined)) continue;
          ctx.setLineDash(key === 'brake' ? [3, 2] : []);
          ctx.strokeStyle = slot.colorHex;
          ctx.beginPath();
          let started = false;
          for (const p of lap.points) {
            const xVal = xAxisMode === 'distance' ? p.distance : p.time;
            const val = p[key];
            if (val === undefined || xVal < activeDomainStart || xVal > activeDomainEnd) continue;
            const x = getX(xVal);
            const y = bandBottom - (Math.min(100, Math.max(0, val)) / 100) * bandHeight;
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // 速度グラフ描画 (各車両)
    // セクターにそろえているとき (時間基準) は、そろえた位置より前は時刻がずれていて比べられないので薄く描く
    const dimBefore = xAxisMode === 'time' && alignStartTime !== undefined ? alignStartTime : -Infinity;
    // 拡大したとき、表示範囲の少し外の点まで結ぶので、線が目盛りの所へはみ出さないよう描画領域で切り取る
    ctx.save();
    ctx.beginPath();
    ctx.rect(paddingLeft, 0, plotWidth, height);
    ctx.clip();
    cars.forEach(carItem => {
      const { slot, lap } = carItem;
      ctx.strokeStyle = slot.colorHex;
      ctx.lineWidth = slot.slot === 0 ? 2.5 : 2.0;

      // 薄く描く部分 (dim) とふつうに描く部分を分けて描く。境目をまたぐ 1 区間は両方に含めて、線が途切れないようにする
      // (境目の時刻は記録点の間にあるので、境目の前後の記録点をそれぞれもう一方にも含める)
      const xs = lap.points.map(p => (xAxisMode === 'distance' ? p.distance : p.time));
      let firstAfter = xs.findIndex(v => v >= dimBefore);
      if (firstAfter < 0) firstAfter = xs.length;
      for (const dim of [true, false]) {
        if (dim && dimBefore === -Infinity) continue;
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < lap.points.length; i++) {
          const p = lap.points[i];
          const xVal = xs[i];
          const inPart = dim ? i <= firstAfter : i >= firstAfter - 1;
          if (inPart && xVal >= activeDomainStart - 0.1 && xVal <= activeDomainEnd + 0.1) {
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
      }
      ctx.globalAlpha = 1;
    });
    ctx.restore();

    // 値の帯 (値ごとに、表示している範囲の最小〜最大を目盛りにする。尺度の違う値を速度の軸に重ねないため)
    for (let si = 0; si < stripCount; si++) {
      const id = strips[si];
      const def = channelDef(id);
      const top = paddingTop + speedHeight + STRIP_GAP + si * (STRIP_H + STRIP_GAP);
      let lo = Infinity, hi = -Infinity;
      for (const { lap } of cars) for (const p of lap.points) {
        const xVal = xAxisMode === 'distance' ? p.distance : p.time;
        const v = def.get(p);
        if (v === undefined || !Number.isFinite(v) || xVal < activeDomainStart || xVal > activeDomainEnd) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!Number.isFinite(lo)) { lo = def.min; hi = def.max; }
      if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
      ctx.fillStyle = C.panel;
      ctx.fillRect(paddingLeft, top, plotWidth, STRIP_H);
      ctx.fillStyle = C.axis;
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(def.decimals));
      ctx.fillText(fmt(hi), paddingLeft - 6, top + 9);
      ctx.fillText(fmt(lo), paddingLeft - 6, top + STRIP_H - 2);
      ctx.textAlign = 'left';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(`${def.label[getLang() === 'en' ? 1 : 0]}${def.unit ? ` (${def.unit})` : ''}`, paddingLeft + 4, top + 11);
      ctx.save();
      ctx.beginPath();
      ctx.rect(paddingLeft, top, plotWidth, STRIP_H);
      ctx.clip();
      for (const { slot, lap } of cars) {
        ctx.strokeStyle = slot.colorHex;
        ctx.lineWidth = slot.slot === 0 ? 1.6 : 1.3;
        ctx.beginPath();
        let started = false;
        for (const p of lap.points) {
          const xVal = xAxisMode === 'distance' ? p.distance : p.time;
          const v = def.get(p);
          if (v === undefined || !Number.isFinite(v)) { started = false; continue; }
          if (xVal < activeDomainStart - 0.1 || xVal > activeDomainEnd + 0.1) continue;
          const x = getX(xVal);
          const y = top + STRIP_H - 2 - ((v - lo) / (hi - lo)) * (STRIP_H - 4);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // タイム差グラフ (Delta Time) 描画
    if (hasDelta) {
      // デルタ背景とゼロ線
      ctx.fillStyle = C.panel;
      ctx.fillRect(paddingLeft, deltaTop, plotWidth, deltaHeight);

      const zeroY = deltaTop + deltaHeight / 2;
      ctx.strokeStyle = C.gridStrong;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(paddingLeft, zeroY);
      ctx.lineTo(width - paddingRight, zeroY);
      ctx.stroke();

      // 縦の範囲は、表示している区間のタイム差の大きさに合わせる (きりのよい値に切り上げ、最小 ±0.5 秒)。
      // 固定の範囲だと、大きな差の線が枠の外へ突き抜けていた
      let peak = 0;
      cars.slice(1).forEach((_, cIdx) => {
        const dVals = deltaTimes[cIdx] || [];
        baseCar.lap.points.forEach((p, pIdx) => {
          if (p.distance >= activeDomainStart && p.distance <= activeDomainEnd) peak = Math.max(peak, Math.abs(dVals[pIdx] || 0));
        });
      });
      const steps = [0.5, 1, 2, 5, 10, 20, 30, 60, 120];
      const maxDelta = steps.find(v => v >= peak) ?? Math.ceil(peak / 60) * 60;
      const yOf = (delta: number) => zeroY - (delta / maxDelta) * (deltaHeight * 0.45);

      ctx.fillStyle = C.axis;
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      const label = (v: number) => `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v) < 10 ? Math.abs(v).toFixed(1) : Math.abs(v).toFixed(0)}s`;
      ctx.fillText('0.00s', paddingLeft - 6, zeroY + 3);
      ctx.fillText(label(maxDelta), paddingLeft - 6, yOf(maxDelta) + 3);
      ctx.fillText(label(-maxDelta), paddingLeft - 6, yOf(-maxDelta) + 3);

      // 線はタイム差の枠の中だけに描く
      ctx.save();
      ctx.beginPath();
      ctx.rect(paddingLeft, deltaTop, plotWidth, deltaHeight);
      ctx.clip();

      cars.slice(1).forEach((targetCar, cIdx) => {
        const dVals = deltaTimes[cIdx] || [];
        ctx.strokeStyle = targetCar.slot.colorHex;
        ctx.lineWidth = 2.0;
        ctx.beginPath();

        let started = false;
        const bpts = baseCar.lap.points;
        bpts.forEach((p, pIdx) => {
          const delta = dVals[pIdx] || 0;
          // 表示範囲の外側の 1 点ずつも含めて、線を枠の端まで届かせる (はみ出した分は枠で切れる)
          const inView = (q?: { distance: number }) => !!q && q.distance >= activeDomainStart && q.distance <= activeDomainEnd;
          if (inView(p) || inView(bpts[pIdx - 1]) || inView(bpts[pIdx + 1])) {
            const x = getX(p.distance);
            // delta > 0: 赤がリード (上方向)
            const y = yOf(delta);
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
      ctx.restore();
    }

    layoutRef.current = { width, height, paddingLeft, paddingRight, paddingTop, paddingBottom, domainStart: activeDomainStart, domainRange: activeDomainRange, plotWidth };
    drawCursor();
  }, [
    cars,
    sectors,
    xAxisMode,
    alignStartTime,
    showDeltaTime,
    showGOverlay,
    showAltitude,
    showPedals,
    hasPedals,
    strips.join(','),
    viewRange,
    maxDomain,
    maxSpeedY,
    deltaTimes,
    baseCar,
    theme,
    resizeTick,
    dpr,
    lang
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
      draggingRef.current = true;
      setIsDragging(true);
      setDragStartX(x);
      seekToX(x, rect.width);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    seekToX(x, rect.width);
  };

  const handleMouseUp = () => {
    draggingRef.current = false;
    setIsDragging(false);
  };

  // 2 本指のピンチで拡大・縮小する (指の中点の位置を動かさない)
  const handlePinch = (scale: number, centerX: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const plotWidth = rect.width - 55 - 45;
    const r = plotWidth > 0 ? Math.max(0, Math.min(1, (centerX - rect.left - 55) / plotWidth)) : 0.5;
    setViewRange(([min, max]) => {
      const span = max - min;
      const newSpan = Math.max(0.05, Math.min(1.0, span / scale));
      return clampRange(min + r * span - r * newSpan, newSpan);
    });
  };
  const pointerHandlers = usePinchPointers({
    onDown: handleMouseDown,
    onMove: handleMouseMove,
    onUp: handleMouseUp,
    onPinch: handlePinch
  });

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

  // 表示範囲の幅を保ったまま、左端を min に動かす (0..1 に収める)
  const clampRange = (min: number, span: number): [number, number] => {
    const newMin = Math.max(0, Math.min(1 - span, min));
    return [newMin, newMin + span];
  };

  // ズームイン / ズームアウト。カーソルが表示範囲にあればカーソルを、ルーラーで別の所を見ているときはその中央を中心にする
  const handleZoom = (direction: 'in' | 'out') => {
    setViewRange(([min, max]) => {
      const span = max - min;
      const factor = direction === 'in' ? 0.65 : 1.5;
      const newSpan = Math.max(0.05, Math.min(1.0, span * factor));
      const center = cursorRatio >= min && cursorRatio <= max ? cursorRatio : (min + max) / 2;
      return clampRange(center - newSpan / 2, newSpan);
    });
  };

  // 再生・コマ送り・他ウインドウからのシークでカーソルが表示範囲の外に出たら、カーソルを中心に表示し直す
  useEffect(() => {
    // 表示範囲の中にあれば同じ配列を返す (新しい配列を返すと、グラフ全体を毎コマ描き直してしまう)
    setViewRange(range => {
      const [min, max] = range;
      if (cursorRatio >= min && cursorRatio <= max) return range;
      const span = max - min;
      return clampRange(cursorRatio - span / 2, span);
    });
  }, [cursorRatio]);

  // セクターにそろえたら (時間基準)、表示範囲をそろえた位置から周の終わりまでにする (前後はルーラーで見られる)
  const wasAlignedRef = useRef(false);
  useEffect(() => {
    if (alignStartTime === undefined) {
      // そろえるのをやめたら (ループ・解除)、全体の表示に戻す
      if (wasAlignedRef.current) setViewRange([0, 1]);
      wasAlignedRef.current = false;
      return;
    }
    wasAlignedRef.current = true;
    if (xAxisMode !== 'time' || maxDomain <= 0) return;
    const start = Math.max(0, Math.min(0.95, alignStartTime / maxDomain - 0.02));
    setViewRange([start, 1]);
    // そろえ直したとき、横軸の長さが変わったとき (表示範囲は横軸全体に対する割合で持っているため) に計算し直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alignStartTime, xAxisMode, maxDomain]);

  // ルーラー: 枠のドラッグで表示範囲を動かし、枠の外をクリックするとそこを中心に表示する
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const rulerDragRef = useRef<{ startX: number; startMin: number; width: number } | null>(null);
  const viewSpan = viewRange[1] - viewRange[0];
  const isZoomed = viewSpan < 0.999;

  const handleRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = (e.clientX - rect.left) / rect.width;
    let startMin = viewRange[0];
    if (ratio < viewRange[0] || ratio > viewRange[1]) {
      startMin = clampRange(ratio - viewSpan / 2, viewSpan)[0];
      setViewRange(clampRange(startMin, viewSpan));
    }
    rulerDragRef.current = { startX: e.clientX, startMin, width: rect.width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleRulerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = rulerDragRef.current;
    if (!drag) return;
    setViewRange(clampRange(drag.startMin + (e.clientX - drag.startX) / drag.width, viewSpan));
  };

  const handleRulerPointerUp = () => {
    rulerDragRef.current = null;
  };

  const handleResetZoom = () => {
    setViewRange([0, 1]);
  };


  return (
    <div className="flex flex-col h-full bg-surface-2 rounded-lg border border-line-2 overflow-hidden select-none shadow-lg">
      {/* ツールバー */}
      {/* 狭いときはボタン単位で折り返す (文字の途中で折れないよう nowrap)。見出しは出さない (切り替えのないウインドウなので) */}
      <div className={`touch-toolbar flex flex-wrap items-center justify-between gap-x-2 gap-y-1 bg-surface-3 border-b border-line-2 text-xs whitespace-nowrap shrink-0 ${compact ? 'px-2 py-1' : 'px-3 py-1.5'}`}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">

          {/* 横軸切替 */}
          <div className="flex bg-surface-1 rounded p-0.5 border border-line-3">
            <button
              onClick={() => setXAxisMode('distance')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                xAxisMode === 'distance' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {compact ? t('距離', 'Dist') : t('距離 (km)', 'Distance (km)')}
            </button>
            <button
              onClick={() => setXAxisMode('time')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                xAxisMode === 'time' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {compact ? t('時間', 'Time') : t('時間 (sec)', 'Time (s)')}
            </button>
          </div>

          {/* タイム差トグル */}
          {xAxisMode === 'distance' && cars.length > 1 && (
            <button
              onClick={() => setShowDeltaTime(!showDeltaTime)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border transition-all ${
                showDeltaTime
                  ? 'bg-blue-950/80 border-blue-500/80 text-blue-300'
                  : 'border-line-4 text-slate-400 hover:text-slate-200'
              }`}
            >
              {compact ? t('タイム差', 'Delta') : t('タイム差 (Delta)', 'Time delta')}
            </button>
          )}

          {/* Gフォースオーバーレイ切替 */}
          <div className="flex items-center gap-1">
            <span className="text-slate-400 text-[11px] ml-1">{compact ? 'G:' : t('G表示:', 'G:')}</span>
            <select
              value={showGOverlay}
              onChange={e => setShowGOverlay(e.target.value as any)}
              className="bg-surface-1 border border-line-3 text-[11px] text-slate-300 rounded px-1.5 py-0.5 outline-none"
            >
              <option value="none">OFF</option>
              <option value="accel">{compact ? t('縦G', 'Long.') : t('加減速G (縦G)', 'Longitudinal G')}</option>
              <option value="corner">{compact ? t('横G', 'Lat.') : t('横G (コーナリングG)', 'Lateral G')}</option>
              <option value="combined">{t('合算G', 'Combined G')}</option>
            </select>
          </div>

          {/* アクセル・ブレーキ切替 (記録のある車両があるときだけ) */}
          {hasPedals && (
            <button
              onClick={() => setShowPedals(!showPedals)}
              title={t('アクセル (実線)・ブレーキ (点線) を下に重ねる (0〜100%)。記録のあるログ (iRacing) だけ', 'Overlay throttle (solid) and brake (dotted) at the bottom (0-100%). Only for logs that record them (iRacing)')}
              className={`px-2 py-0.5 rounded text-[11px] border transition-all ${
                showPedals
                  ? 'bg-slate-800 border-slate-500 text-slate-200'
                  : 'border-line-4 text-slate-400 hover:text-slate-200'
              }`}
            >
              {compact ? t('ペダル', 'Pedals') : t('アクセル・ブレーキ', 'Throttle / brake')}
            </button>
          )}

          {/* 値の帯 (速度グラフの下に、値ごとに細い帯で出す。PLAN-36) */}
          {stripChoices.length > 0 && (
            <div className="relative" ref={stripMenuRef}>
              <button
                onClick={() => setStripMenu(v => !v)}
                className={`px-2 py-0.5 rounded text-[11px] border transition-all ${strips.length ? 'bg-slate-800 border-slate-500 text-slate-200' : 'border-line-4 text-slate-400 hover:text-slate-200'}`}
                title={t('速度グラフの下に、値 (回転数・自分で名前を付けた値など) を細い帯で出します。帯ごとに自分の目盛りです', 'Show values (RPM, custom values, ...) as thin strips under the speed graph, each with its own scale')}
                data-testid="graph-strips-toggle"
              >
                {t('値の帯', 'Strips')}{strips.length ? ` ${strips.length}` : ''}
              </button>
              {stripMenu && (
                <div className="absolute z-30 top-full mt-1 left-0 min-w-[10rem] bg-surface-1 border border-line-2 rounded-lg shadow-xl p-2 space-y-1 text-[11px]" data-testid="graph-strips-menu">
                  {stripChoices.map(id => (
                    <label key={id} className="flex items-center gap-1.5 text-slate-300 cursor-pointer whitespace-nowrap">
                      <input type="checkbox" checked={strips.includes(id)} disabled={!strips.includes(id) && strips.length >= MAX_STRIPS}
                        onChange={e => {
                          // このログに無い値の選び方も残す (ほかのログを開いたときに、また出るように)
                          const rest = stripIds.filter(x => x !== id);
                          setStripIds(e.target.checked ? [...rest, id].slice(-12) : rest);
                        }} data-testid={`graph-strip-${id}`} />
                      {channelDef(id).label[getLang() === 'en' ? 1 : 0]}
                    </label>
                  ))}
                  <p className="text-[10px] text-slate-500">{t(`${MAX_STRIPS} つまで`, `Up to ${MAX_STRIPS}`)}</p>
                </div>
              )}
            </div>
          )}

          {/* 標高切替 */}
          <button
            onClick={() => setShowAltitude(!showAltitude)}
            className={`px-2 py-0.5 rounded text-[11px] border transition-all ${
              showAltitude
                ? 'bg-slate-800 border-slate-500 text-slate-200'
                : 'border-line-4 text-slate-400 hover:text-slate-200'
            }`}
          >
            {t('標高', 'Altitude')}
          </button>
        </div>

        {/* ズーム操作 */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleZoom('in')}
            title={t('拡大', 'Zoom in')}
            className="p-1 hover:bg-surface-5 rounded text-slate-300 transition-colors"
          >
            <ZoomIn size={14} />
          </button>
          <button
            onClick={() => handleZoom('out')}
            title={t('縮小', 'Zoom out')}
            className="p-1 hover:bg-surface-5 rounded text-slate-300 transition-colors"
          >
            <ZoomOut size={14} />
          </button>
          <button
            onClick={handleResetZoom}
            title={t('全体表示 (リセット)', 'Show all (reset)')}
            className="p-1 hover:bg-surface-5 rounded text-slate-300 transition-colors"
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>

      {/* メインCanvas */}
      {/* 下のルーラーが見切れないよう、ウインドウを縮めたときはグラフの方を縮める */}
      <div className="relative flex-1 w-full h-full min-h-0">
        <canvas
          ref={canvasRef}
          {...pointerHandlers}
          className="w-full h-full cursor-crosshair block touch-none"
        />
        {/* 現在位置のカーソル (操作は下の canvas が受ける) */}
        <canvas ref={cursorCanvasRef} className="absolute inset-0 pointer-events-none block" />

        {/* 右上リアルタイム数値インジケーター (車両がないときは出さない) */}
        {/* 赤い線が右寄り (グラフの 6 割より右) にあるときは左上に出す (いま見ている所を隠さないように) */}
        {cars.length > 0 && (
          <div className={`absolute bg-surface-0/75 backdrop-blur-sm border border-line-2 rounded-md flex flex-col gap-1 shadow-md pointer-events-none ${compact ? 'top-1 p-1 text-[10px]' : 'top-2 p-2 text-xs min-w-[130px]'} ${valueBoxOnLeft ? (compact ? 'left-[50px]' : 'left-[60px]') : (compact ? 'right-1' : 'right-3')}`}>
            {cars.map((c, idx) => {
              // 現在のポイント検索
              const pts = c.lap.points;
              // 二分探索で探す (先頭から全部の点を見ると、点の多いログで毎コマ重い)
              const curPt = xAxisMode === 'distance'
                ? findClosestPointByDistance(pts, currentDistance)
                : findClosestPointByTime(pts, currentTime);

              return (
                <div key={idx} className="flex items-center justify-between gap-3 font-mono">
                  {/* 長い走行の名前は 1 行で省く (折り返してグラフに重なっていた。BUG-39) */}
                  <span className="flex items-center gap-1.5 font-bold min-w-0" style={{ color: c.slot.colorHex }} title={c.slot.label}>
                    <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ backgroundColor: c.slot.colorHex }}></span>
                    <span className="truncate max-w-[16rem] [@media(max-width:500px)]:max-w-[9rem]">{c.slot.label}</span>:
                  </span>
                  <span className="font-bold text-slate-100 shrink-0">{curPt ? curPt.speed.toFixed(1) : '0.0'} km/h</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ルーラー (拡大中のみ)。グラフの描画領域と左右をそろえる */}
      <div className="h-4 shrink-0 bg-surface-1" style={{ paddingLeft: 55, paddingRight: 45 }}>
        {isZoomed && (
          <div
            ref={rulerRef}
            onPointerDown={handleRulerPointerDown}
            onPointerMove={handleRulerPointerMove}
            onPointerUp={handleRulerPointerUp}
            onPointerCancel={handleRulerPointerUp}
            title={t('ドラッグで表示範囲を移動', 'Drag to move the visible range')}
            className="relative h-2.5 bg-surface-4 rounded-sm cursor-pointer touch-none"
          >
            <div
              className="absolute top-0 h-full bg-slate-500/50 border border-slate-400/70 rounded-sm cursor-grab active:cursor-grabbing"
              style={{ left: `${viewRange[0] * 100}%`, width: `${viewSpan * 100}%` }}
            />
            <div
              className="absolute top-0 h-full w-[2px] -ml-px bg-red-500 pointer-events-none"
              style={{ left: `${cursorRatio * 100}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
};
