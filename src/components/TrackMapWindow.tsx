import React, { useRef, useEffect, useState, useMemo } from 'react';
import { canvasColors, useResolvedTheme } from '../utils/theme';
import { useCompactLayout } from '../hooks/useCompactLayout';
import { usePinchPointers } from '../hooks/usePinchPointers';
import { CompareAxis, Lap, SelectedCarSlot, Sector, ControlLine } from '../types/telemetry';
import { findCarPoint } from '../utils/telemetrySearch';
import { prepareCanvas } from '../utils/canvasLayer';
import { passesNearPoint } from '../services/lapCalculator';
import { ZoomIn, ZoomOut, RotateCcw, Eye, Palette, Move, LocateFixed } from 'lucide-react';
import { getTileImage, MapBackground, TILE_ATTRIBUTION, TILE_SOURCES, tilesForView } from '../services/mapTiles';
import { useLapGeometries } from '../hooks/useLapGeometries';
import { computeCorrectedLineDelta, computeLineDelta, detectCorners } from '../services/drivingAnalysis';

const BACKGROUND_STORAGE_KEY = 'ds_map_background';
const METERS_PER_DEG_LAT = 111320;
// 基準車と同じコースのログとみなす、基準車の走り始めからの範囲 (m)
const NEAR_BASE_RADIUS_M = 5000;

// 背景地図の位置補正 (m) の保存キー。場所ごと (約 1km 四方) に覚える
function offsetStorageKey(lat: number, lon: number): string {
  return `ds_map_offset_${lat.toFixed(2)}_${lon.toFixed(2)}`;
}

function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できなくても表示には影響しない
  }
}

// ライン偏差の色分けで、最も濃い色になるズレ量 (m)
const LINE_DELTA_FULL_SCALE_M = 3;

interface TrackMapWindowProps {
  cars: {
    slot: SelectedCarSlot;
    lap: Lap;
  }[];
  controlLine?: ControlLine;
  sectors: Sector[];
  pathPolylines?: Array<Array<[number, number]>>;
  currentDistance: number;
  currentTime: number;
  compareAxis: CompareAxis;
  onSeekDistance: (distKm: number) => void;
}

export const TrackMapWindow: React.FC<TrackMapWindowProps> = ({
  cars,
  controlLine,
  sectors,
  pathPolylines,
  currentDistance,
  currentTime,
  compareAxis,
  onSeekDistance
}) => {
  // テーマを切り替えたら canvas を描き直す
  const theme = useResolvedTheme();
  // スマートフォン向けの配置では、ツールバーを 1 行にして横にスクロールさせ、見出しを省く
  const compact = useCompactLayout();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 車両の現在位置だけを描く、上に重ねた canvas (再生中はこちらだけを描き直す。追従中は地図ごと動くので両方)
  const carCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // 下の canvas を描いたときの座標変換 (車両の位置の計算に使う)
  const layoutRef = useRef<{ width: number; height: number; latMid: number; lonMid: number; cosLat: number; baseScale: number; pan: { x: number; y: number } } | null>(null);

  const [colorMode, setColorMode] = useState<'car' | 'speed' | 'accel' | 'line'>('car');
  const [showCorners, setShowCorners] = useState(true);
  // ラップ間の GPS の位置ずれ (平行移動) を推定して差し引く
  const [correctGpsShift, setCorrectGpsShift] = useState(true);
  const [zoom, setZoom] = useState(1.0);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  // 車両追従。ON の間は基準車が常に画面の中央に来るように表示を動かす
  const [isFollowing, setIsFollowing] = useState(false);
  // 実際に描画に使った平行移動量。追従を外したとき、その位置から手動の移動を続けるために覚えておく
  const drawnPanRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // 背景地図 (既定はなし = オフライン動作)
  const [background, setBackground] = useState<MapBackground>(() => {
    const saved = loadStored<MapBackground>(BACKGROUND_STORAGE_KEY, 'none');
    return saved === 'photo' || saved === 'standard' ? saved : 'none';
  });
  // 地図の位置調整モード。ON の間はドラッグで地図だけを動かす
  const [isAdjustingMap, setIsAdjustingMap] = useState(false);
  // GPS 軌跡に対する背景地図の位置補正 (m)。東・北が正
  const [mapOffset, setMapOffset] = useState<{ eastM: number; northM: number }>({ eastM: 0, northM: 0 });
  const [tileTick, setTileTick] = useState(0);
  // 表示領域の大きさが変わったら描き直す
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setResizeTick(t => t + 1));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  // ドラッグ量を距離へ換算するための、現在の表示倍率 (m / px)
  const metersPerPixelRef = useRef(1);

  // 基準車
  const baseCar = cars[0];

  // コーナー番号と、基準車のラインに対する各車両の左右のズレ
  const analysed = useLapGeometries(cars);
  const corners = useMemo(() => (analysed[0] ? detectCorners(analysed[0].geo) : []), [analysed]);
  const lineDeltas = useMemo(() => {
    if (colorMode !== 'line' || analysed.length < 2) return [];
    return analysed.slice(1).map(car => ({
      lap: car.lap,
      delta: correctGpsShift ? computeCorrectedLineDelta(analysed[0].geo, car.geo) : computeLineDelta(analysed[0].geo, car.geo)
    }));
  }, [analysed, colorMode, correctGpsShift]);

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

    // 車両ポイント。基準車から遠く離れた場所 (別のコース) のログは表示範囲に入れない (基準車のコースが小さく潰れるため)
    const origin = cars[0]?.lap.points[0];
    for (const car of cars) {
      if (origin && car !== cars[0] && !passesNearPoint(car.lap.points, origin.latitude, origin.longitude, NEAR_BASE_RADIUS_M)) continue;
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

  // 場所が変わったら、その場所で保存した地図の位置補正を読み込む
  const offsetKey = offsetStorageKey((bounds.minLat + bounds.maxLat) / 2, (bounds.minLon + bounds.maxLon) / 2);
  useEffect(() => {
    const saved = loadStored<{ eastM: number; northM: number } | null>(offsetKey, null);
    setMapOffset(saved && Number.isFinite(saved.eastM) && Number.isFinite(saved.northM) ? saved : { eastM: 0, northM: 0 });
  }, [offsetKey]);

  useEffect(() => {
    if (background === 'none') setIsAdjustingMap(false);
  }, [background]);

  // 各車両の現在位置を、上に重ねた canvas に描く (下の canvas を描いたときの座標変換を使う)
  const curRef = useRef({ cars, compareAxis, currentDistance, currentTime });
  curRef.current = { cars, compareAxis, currentDistance, currentTime };
  const drawCars = () => {
    const layout = layoutRef.current;
    const canvas = carCanvasRef.current;
    if (!canvas) return;
    if (!layout) {
      const w = canvas.parentElement?.clientWidth ?? 0;
      const h = canvas.parentElement?.clientHeight ?? 0;
      if (w > 0 && h > 0) prepareCanvas(canvas, w, h);
      return;
    }
    const { width, height, latMid, lonMid, cosLat, baseScale, pan } = layout;
    const ctx = prepareCanvas(canvas, width, height);
    if (!ctx) return;
    const { cars, compareAxis, currentDistance, currentTime } = curRef.current;
    const toScreen = (lat: number, lon: number) => ({
      x: width / 2 + (lon - lonMid) * cosLat * baseScale + pan.x,
      y: height / 2 - (lat - latMid) * baseScale + pan.y
    });
    cars.forEach(car => {
      const pts = car.lap.points;
      if (pts.length === 0) return;

      // 現在の点 (距離基準: 基準車と同じ距離 / 時間基準: 同じ経過時間)
      const curPt = findCarPoint(pts, compareAxis, currentDistance, currentTime) || pts[0];

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
  };
  // 再生中は車両だけを描き直す
  useEffect(() => {
    drawCars();
  }, [cars, currentDistance, currentTime, compareAxis]);
  // 追従中は地図ごと動くので、下の canvas も現在位置で描き直す
  const followPosition = isFollowing ? `${compareAxis === 'distance' ? currentDistance : currentTime}` : '';

  // Canvas描画 (車両の現在位置以外。追従していなければ再生では描き直さない)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // テーマの色 (テーマを切り替えたら描き直す)
    // 背景に地図・航空写真を敷くときは、その上で見えるよう、ライトでもダークの色で描く (従来どおり)
    const C = canvasColors(background !== 'none');

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

    if (cars.length === 0 && (!pathPolylines || pathPolylines.length === 0)) {
      ctx.fillStyle = C.axis;
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('コースデータがありません', width / 2, height / 2);
      drawCars();
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

    // 追従中は、基準車の現在位置が画面の中央に来るように平行移動量を決める
    let pan = panOffset;
    const basePts = cars[0]?.lap.points;
    if (isFollowing && basePts && basePts.length > 0) {
      const p = findCarPoint(basePts, compareAxis, currentDistance, currentTime) || basePts[0];
      pan = { x: -(p.longitude - lonMid) * cosLat * baseScale, y: (p.latitude - latMid) * baseScale };
    }
    drawnPanRef.current = pan;

    const toScreen = (lat: number, lon: number) => {
      const x = width / 2 + (lon - lonMid) * cosLat * baseScale + pan.x;
      const y = height / 2 - (lat - latMid) * baseScale + pan.y;
      return { x, y };
    };

    metersPerPixelRef.current = METERS_PER_DEG_LAT / baseScale;

    // 0. 背景地図タイル
    if (background !== 'none') {
      // 位置補正の分だけ、地図を GPS 軌跡に対してずらして描く
      const dLat = mapOffset.northM / METERS_PER_DEG_LAT;
      const dLon = mapOffset.eastM / (METERS_PER_DEG_LAT * cosLat);
      const toGeo = (x: number, y: number) => ({
        lat: latMid - (y - height / 2 - pan.y) / baseScale - dLat,
        lon: lonMid + (x - width / 2 - pan.x) / (cosLat * baseScale) - dLon
      });
      const topLeft = toGeo(0, 0);
      const bottomRight = toGeo(width, height);
      const tiles = tilesForView(
        background,
        { north: topLeft.lat, south: bottomRight.lat, west: topLeft.lon, east: bottomRight.lon },
        metersPerPixelRef.current
      );
      // 走行ラインが見やすいよう、少し暗くして敷く
      ctx.globalAlpha = background === 'photo' ? 0.8 : 0.7;
      for (const tile of tiles) {
        const image = getTileImage(tile, () => setTileTick(t => t + 1));
        if (!image) continue;
        const nw = toScreen(tile.north + dLat, tile.west + dLon);
        const se = toScreen(tile.south + dLat, tile.east + dLon);
        // 継ぎ目が出ないよう 0.5px 重ねる
        ctx.drawImage(image, nw.x, nw.y, se.x - nw.x + 0.5, se.y - nw.y + 0.5);
      }
      ctx.globalAlpha = 1;
    }

    // 1. コース形状ポリライン (.pth) の描画
    //    背景地図があるときは路面が見えるよう、下地は描かず境界線だけを薄く重ねる
    if (pathPolylines && pathPolylines.length > 0 && background !== 'none') {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = 1;
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
    } else if (pathPolylines && pathPolylines.length > 0) {
      ctx.strokeStyle = C.track;
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
      ctx.strokeStyle = C.trackEdge;
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

      ctx.strokeStyle = C.strong;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.stroke();

      // チェッカー柄またはラベル
      ctx.fillStyle = C.strong;
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('FINISH', (pA.x + pB.x) / 2, (pA.y + pB.y) / 2 - 6);
    }

    // 3. セクターゲート (S1, S2, S3...)
    sectors.forEach((sec, idx) => {
      const pA = toScreen(sec.latA, sec.lonA);
      const pB = toScreen(sec.latB, sec.lonB);

      ctx.strokeStyle = C.sector;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = C.sector;
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(sec.name || `S${idx + 1}`, (pA.x + pB.x) / 2, (pA.y + pB.y) / 2 - 5);
    });

    // 4. 車両の走行ライン (GPSトラック)
    cars.forEach(car => {
      const pts = car.lap.points;
      if (pts.length < 2) return;

      const lineDelta = lineDeltas.find(d => d.lap === car.lap);
      if (colorMode === 'line' && lineDelta) {
        // 基準車のラインからのズレ (進行方向に対して左: 青 / 右: オレンジ、濃いほど大きい)
        ctx.lineWidth = 3.5;
        // 補正した位置ずれの分だけ、描画位置も基準車側へ寄せる
        const dLat = lineDelta.delta.shiftNorthM / 111320;
        const dLon = lineDelta.delta.shiftEastM / (111320 * Math.cos((pts[0].latitude * Math.PI) / 180));
        for (let i = 0; i < pts.length - 1; i++) {
          const off = lineDelta.delta.offsetM[i];
          if (!Number.isFinite(off)) continue;
          const p1 = toScreen(pts[i].latitude - dLat, pts[i].longitude - dLon);
          const p2 = toScreen(pts[i + 1].latitude - dLat, pts[i + 1].longitude - dLon);
          const strength = Math.min(1, Math.abs(off) / LINE_DELTA_FULL_SCALE_M);
          ctx.strokeStyle = off < 0
            ? `rgba(56, 189, 248, ${0.25 + strength * 0.75})`
            : `rgba(251, 146, 60, ${0.25 + strength * 0.75})`;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }
      } else if (colorMode === 'car' || colorMode === 'line') {
        // ライン偏差モードでは、基準車を細い白線で描く
        ctx.strokeStyle = colorMode === 'line' ? C.soft : car.slot.colorHex;
        ctx.lineWidth = colorMode === 'line' ? 1.5 : car.slot.slot === 0 ? 3 : 2;
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
        // 0 km/h (停車) も有効な値として扱う
        const maxSpd = Number.isFinite(car.lap.topSpeed) && car.lap.topSpeed > 0 ? car.lap.topSpeed : 150;
        const minSpd = Number.isFinite(car.lap.bottomSpeed) ? car.lap.bottomSpeed : 40;
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
            ctx.strokeStyle = C.axis;
          }

          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }
      }
    });

    // コーナー番号 (基準車のアペックス位置)
    if (showCorners && baseCar) {
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const c of corners) {
        const p = baseCar.lap.points[c.apexIndex];
        if (!p) continue;
        const pos = toScreen(p.latitude, p.longitude);
        ctx.fillStyle = '#0f1117d0';
        ctx.beginPath();
        ctx.arc(pos.x, pos.y - 14, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(`C${c.number}`, pos.x, pos.y - 14);
      }
    }

    layoutRef.current = { width, height, latMid, lonMid, cosLat, baseScale, pan };
    drawCars();
  }, [cars, controlLine, sectors, pathPolylines, followPosition, compareAxis, bounds, zoom, panOffset, isFollowing, colorMode, corners, lineDeltas, showCorners, background, mapOffset, tileTick, resizeTick, theme]);

  // パン操作 (ドラッグ)
  // ドラッグの状態は、同じイベントの中で続けて読めるよう ref で持つ (タッチは動かしたときに押下と移動が続けて届くため)
  const panningRef = useRef(false);
  // ドラッグを始めた (前回の) ポインターの位置と、そのときの表示位置
  const dragFromRef = useRef({ x: 0, y: 0 });
  const panBaseRef = useRef<{ x: number; y: number } | null>(null);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    panningRef.current = true;
    dragFromRef.current = { x: e.clientX, y: e.clientY };
    // 表示位置の基準は、実際に動かしたときに決める (タップしただけでは追従を外さない)
    panBaseRef.current = null;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!panningRef.current) return;
    // 位置調整モードでは、前回のポインターの位置からの移動量で地図を動かす
    if (isAdjustingMap) {
      const mpp = metersPerPixelRef.current;
      const dx = e.clientX - dragFromRef.current.x;
      const dy = e.clientY - dragFromRef.current.y;
      dragFromRef.current = { x: e.clientX, y: e.clientY };
      // 画面の右 = 東、上 = 北
      setMapOffset(o => ({ eastM: o.eastM + dx * mpp, northM: o.northM - dy * mpp }));
      return;
    }
    if (!panBaseRef.current) {
      // 追従中にドラッグしたら追従を外し、今見えている位置から手動で動かす
      panBaseRef.current = isFollowing ? drawnPanRef.current : panOffset;
      if (isFollowing) setIsFollowing(false);
    }
    const base = panBaseRef.current;
    setPanOffset({
      x: base.x + e.clientX - dragFromRef.current.x,
      y: base.y + e.clientY - dragFromRef.current.y
    });
  };

  const handleMouseUp = () => {
    if (panningRef.current && isAdjustingMap) store(offsetKey, mapOffset);
    panningRef.current = false;
  };

  const handleSelectBackground = (value: MapBackground) => {
    setBackground(value);
    store(BACKGROUND_STORAGE_KEY, value);
  };

  const handleResetMapOffset = () => {
    setMapOffset({ eastM: 0, northM: 0 });
    store(offsetKey, { eastM: 0, northM: 0 });
  };

  // 2 本指のピンチで拡大・縮小する
  const pointerHandlers = usePinchPointers({
    onDown: handleMouseDown,
    onMove: handleMouseMove,
    onUp: handleMouseUp,
    onPinch: scale => setZoom(z => Math.max(0.4, Math.min(10.0, z * scale)))
  });

  // ホイールズーム
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    setZoom(z => Math.max(0.4, Math.min(10.0, z * factor)));
  };

  const handleReset = () => {
    setIsFollowing(false);
    setZoom(1.0);
    setPanOffset({ x: 0, y: 0 });
  };

  return (
    <div className="flex flex-col h-full bg-surface-2 rounded-lg border border-line-2 overflow-hidden select-none shadow-lg">
      {/* ツールバー */}
      {/* 狭いときはボタン単位で折り返す (文字の途中で折れないよう nowrap)。見出しは出さない (切り替えのないウインドウなので) */}
      <div className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 bg-surface-3 border-b border-line-2 text-xs whitespace-nowrap shrink-0 ${compact ? 'px-2 py-1' : 'px-3 py-1.5'}`}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">

          {/* カラーモード切替 */}
          <div className="flex items-center bg-surface-1 rounded p-0.5 border border-line-3">
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
              {compact ? '車速' : '車速ヒート'}
            </button>
            <button
              onClick={() => setColorMode('accel')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                colorMode === 'accel' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              加減速
            </button>
            <button
              onClick={() => setColorMode('line')}
              title="基準車 (Car 1) の走行ラインに対する、他の車両の左右のズレを色分け表示"
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                colorMode === 'line' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {compact ? 'ライン' : 'ライン偏差'}
            </button>
          </div>
          <button
            onClick={() => setShowCorners(v => !v)}
            title="コーナー番号の表示切替"
            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-all ${
              showCorners ? 'border-amber-500/50 text-amber-300' : 'border-line-3 text-slate-500 hover:text-slate-300'
            }`}
          >
            {compact ? 'コーナー' : 'コーナー番号'}
          </button>
          <select
            value={background}
            onChange={e => handleSelectBackground(e.target.value as MapBackground)}
            title="コース図の背景に地図を表示します (国土地理院タイル。表示にはインターネット接続が必要です)"
            aria-label="背景地図"
            className="bg-surface-1 border border-line-3 text-[11px] text-slate-300 rounded px-1.5 py-0.5 outline-none"
          >
            <option value="none">{compact ? '地図なし' : '背景: なし'}</option>
            <option value="photo">{compact ? '' : '背景: '}{TILE_SOURCES.photo.label}</option>
            <option value="standard">{compact ? '' : '背景: '}{TILE_SOURCES.standard.label}</option>
          </select>
          {background !== 'none' && (
            <button
              onClick={() => setIsAdjustingMap(v => !v)}
              aria-pressed={isAdjustingMap}
              title="ON の間は、ドラッグで背景地図だけを動かして GPS 軌跡に合わせます。OFF にすると通常の移動・拡大操作に戻ります"
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border transition-all ${
                isAdjustingMap ? 'bg-emerald-600 border-emerald-500 text-white' : 'border-line-3 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Move size={11} />
              {compact ? '位置調整' : '地図の位置調整'}{isAdjustingMap ? ': ON' : ''}
            </button>
          )}
        </div>

        {/* コントロール */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              // 追従を外すときは、今見えている位置のままにする
              if (isFollowing) setPanOffset(drawnPanRef.current);
              setIsFollowing(!isFollowing);
            }}
            title="車両追従 (基準車を常に中央に表示)"
            aria-pressed={isFollowing}
            className={`flex items-center gap-1 px-1.5 py-0.5 mr-1 rounded border text-[11px] transition-colors ${
              isFollowing ? 'bg-emerald-600 border-emerald-500 text-white' : 'border-line-3 text-slate-400 hover:text-slate-200'
            }`}
          >
            <LocateFixed size={13} />
            追従
          </button>
          <button
            onClick={() => setZoom(z => Math.min(10, z * 1.25))}
            title="拡大"
            className="p-1 hover:bg-surface-5 rounded text-slate-300 transition-colors"
          >
            <ZoomIn size={14} />
          </button>
          <button
            onClick={() => setZoom(z => Math.max(0.4, z * 0.8))}
            title="縮小"
            className="p-1 hover:bg-surface-5 rounded text-slate-300 transition-colors"
          >
            <ZoomOut size={14} />
          </button>
          <button
            onClick={handleReset}
            title="コース全体を表示"
            className="p-1 hover:bg-surface-5 rounded text-slate-300 transition-colors"
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className={`relative flex-1 w-full h-full ${compact ? 'min-h-0' : 'min-h-[220px]'}`}>
        <canvas
          ref={canvasRef}
          {...pointerHandlers}
          onWheel={handleWheel}
          className={`w-full h-full block touch-none ${isAdjustingMap ? 'cursor-move' : 'cursor-grab active:cursor-grabbing'}`}
        />
        {/* 車両の現在位置 (操作は下の canvas が受ける) */}
        <canvas ref={carCanvasRef} className="absolute inset-0 pointer-events-none block" />

        {/* 地図の位置調整中の案内 */}
        {isAdjustingMap && (
          <div className="absolute top-2 left-2 bg-emerald-950/90 border border-emerald-500/60 rounded px-2 py-1 text-[10px] text-emerald-100 flex items-center gap-2" data-testid="map-adjust-panel">
            <span>ドラッグで地図を移動 (ホイールで拡大縮小)</span>
            <span className="font-mono" data-testid="map-offset">
              東 {mapOffset.eastM >= 0 ? '+' : ''}{mapOffset.eastM.toFixed(1)}m / 北 {mapOffset.northM >= 0 ? '+' : ''}{mapOffset.northM.toFixed(1)}m
            </span>
            <button onClick={handleResetMapOffset} className="px-1.5 py-0.5 rounded border border-emerald-500/60 hover:bg-emerald-800/60">リセット</button>
            <button onClick={() => setIsAdjustingMap(false)} className="px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold">完了</button>
          </div>
        )}

        {/* 地図タイルの出典表示 */}
        {background !== 'none' && (
          <a
            href={TILE_ATTRIBUTION.url}
            target="_blank"
            rel="noreferrer"
            className="absolute bottom-1 right-1 bg-surface-1/82 rounded px-1.5 py-0.5 text-[9px] text-slate-300 hover:text-fg"
          >
            {TILE_ATTRIBUTION.text}
          </a>
        )}

        {/* 凡例 / ガイド */}
        {colorMode === 'speed' && (
          <div className="absolute bottom-2 left-2 bg-surface-1/88 border border-line-3 rounded px-2 py-1 text-[10px] text-slate-300 flex items-center gap-2">
            <span>低速 (青)</span>
            <div className="w-16 h-2 rounded bg-gradient-to-r from-blue-600 via-green-500 to-red-500"></div>
            <span>高速 (赤)</span>
          </div>
        )}
        {colorMode === 'line' && (
          <div className="absolute bottom-2 left-2 bg-surface-1/88 border border-line-3 rounded px-2 py-1 text-[10px] text-slate-300 flex items-center gap-2" data-testid="line-delta-legend">
            {lineDeltas.length === 0 ? (
              <span className="text-amber-300">比較する車両 (Car 2 以降) を「データ管理」で選択してください</span>
            ) : (
              <>
                <span className="text-sky-400">左 {LINE_DELTA_FULL_SCALE_M}m</span>
                <div className="w-20 h-2 rounded bg-gradient-to-r from-sky-400 via-slate-700 to-orange-400"></div>
                <span className="text-orange-400">右 {LINE_DELTA_FULL_SCALE_M}m</span>
                <span className="text-slate-500">{theme === 'light' && background === 'none' ? '濃い線' : '白線'}: 基準車 / 進行方向に対する左右</span>
                <label className="flex items-center gap-1 text-slate-300 cursor-pointer" title="ラップ間の GPS の位置ずれ (ほぼ一定の平行移動として現れる誤差) を推定して差し引きます。周回コースでのみ有効です">
                  <input type="checkbox" checked={correctGpsShift} onChange={e => setCorrectGpsShift(e.target.checked)} className="accent-red-500" />
                  GPS ずれ補正
                </label>
                {correctGpsShift && (
                  <span className="text-slate-500" data-testid="gps-shift-amount">
                    {lineDeltas.map(d => {
                      const amount = Math.hypot(d.delta.shiftEastM, d.delta.shiftNorthM);
                      return amount > 0 ? `${amount.toFixed(1)}m` : '推定不可';
                    }).join(' / ')}
                  </span>
                )}
              </>
            )}
          </div>
        )}
        {colorMode === 'accel' && (
          <div className="absolute bottom-2 left-2 bg-surface-1/88 border border-line-3 rounded px-2 py-1 text-[10px] text-slate-300 flex items-center gap-2">
            <span className="text-red-400">減速G (赤)</span>
            <div className="w-16 h-2 rounded bg-gradient-to-r from-red-500 via-slate-600 to-cyan-400"></div>
            <span className="text-cyan-400">加速G (青)</span>
          </div>
        )}
      </div>
    </div>
  );
};
