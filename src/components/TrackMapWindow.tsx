import React, { useRef, useEffect, useState, useMemo } from 'react';
import { canvasColors, useResolvedTheme } from '../utils/theme';
import { tr, useLang, useT } from '../utils/i18n';
import { useCompactLayout } from '../hooks/useCompactLayout';
import { usePinchPointers } from '../hooks/usePinchPointers';
import { CompareAxis, Lap, SelectedCarSlot, Sector, ControlLine } from '../types/telemetry';
import { findCarPoint } from '../utils/telemetrySearch';
import { prepareCanvas, useDevicePixelRatio } from '../utils/canvasLayer';
import { passesNearPoint } from '../services/lapCalculator';
import { ZoomIn, ZoomOut, RotateCcw, Eye, Palette, Move, LocateFixed } from 'lucide-react';
import { getTileImage, MapBackground, TILE_ATTRIBUTION, tilesForView } from '../services/mapTiles';
import { useLapGeometries } from '../hooks/useLapGeometries';
import { computeCorrectedLineDelta, computeLineDelta } from '../services/drivingAnalysis';
import { cornerLabel, useNamedCorners, type NamedCornerOnLap } from '../hooks/useNamedCorners';
import { applySpanCorner, carryNames, cornersFromDetection, mergeCorners, newCornerFile, placeCorners, splitCorner, tapSpan, type NamedCorner } from '../services/cornerNames';
import { saveCourseCorners } from '../services/courseCorners';
import { canUseRunStore } from '../services/runStore';
import { CornerEditPanel } from './CornerEditPanel';
import { PenLine } from 'lucide-react';
import { SectorStartBar, type SectorStartProps } from './SectorStartBar';

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
  /** ゴールの線 (スタートとゴールが別のコース)。スタートの線と同じ太さで、色を変えて描く */
  finishLine?: ControlLine;
  sectors: Sector[];
  pathPolylines?: Array<Array<[number, number]>>;
  currentDistance: number;
  currentTime: number;
  compareAxis: CompareAxis;
  onSeekDistance: (distKm: number) => void;
  /** Car 1 のコースの名前 (コーナーの名前を出すため) */
  circuitName?: string;
  /** セクターからの一斉スタート (PLAN-28。もとはアニメの窓だけ) */
  sectorStart?: Omit<SectorStartProps, 'sectors'>;
}

/** 追従のときの拡大率 (アニメの窓と同じ。画面の短い辺に約 330 m × 倍率分の 1 が入る) */
const FOLLOW_ZOOMS = [2, 3, 5] as const;
/** 追従の倍率 1 で、画面の短い辺に入る経度・緯度の幅 (度) */
const FOLLOW_SPAN_DEG = 0.003;
/** 拡大の上限 (大きいコースでも、追従の 5x まで寄れるように。もとは 10) */
const MAX_ZOOM = 40;

export const TrackMapWindow: React.FC<TrackMapWindowProps> = ({
  cars,
  controlLine,
  finishLine,
  sectors,
  pathPolylines,
  currentDistance,
  currentTime,
  compareAxis,
  onSeekDistance,
  circuitName,
  sectorStart
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
  // 車両の現在位置だけを描く、上に重ねた canvas (再生中はこちらだけを描き直す。追従中は地図ごと動くので両方)
  const carCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // 下の canvas を描いたときの座標変換 (車両の位置の計算に使う)
  const layoutRef = useRef<{ width: number; height: number; latMid: number; lonMid: number; cosLat: number; baseScale: number; pan: { x: number; y: number } } | null>(null);

  const [colorMode, setColorMode] = useState<'car' | 'speed' | 'accel' | 'line'>('car');
  const [showCorners, setShowCorners] = useState(true);
  // コーナーの編集 (PLAN-27): 直している途中の一覧 (編集していなければ null)・選んでいるコーナー
  const [cornerDraft, setCornerDraft] = useState<NamedCorner[] | null>(null);
  const [selectedCorner, setSelectedCorner] = useState<number | null>(null);
  const [cornerSaving, setCornerSaving] = useState(false);
  const [cornerError, setCornerError] = useState('');
  // 押した位置 (ドラッグでなく押しただけかを見る)
  const downAtRef = useRef<{ x: number; y: number } | null>(null);
  // 編集中に走行の線の上からなぞった範囲 (基準車の点の番号。なぞっていなければ null)
  const [cornerSpan, setCornerSpan] = useState<{ a: number; b: number } | null>(null);
  const spanRef = useRef<{ a: number; b: number } | null>(null);
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
  // タイルが届いたら描き直す。同じ関数を渡して、読み込み中のタイルに同じウインドウが何度も登録されないようにする
  const onTileLoadRef = useRef(() => setTileTick(t => t + 1));
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
  const course = useNamedCorners(analysed[0]?.geo, circuitName);
  const baseGeo = analysed[0]?.geo;
  // 地図に出すコーナー (編集中は直している途中のもの)。k は一覧の中の番号
  const { corners, missingCorners } = useMemo(() => {
    if (!cornerDraft || !baseGeo) return { corners: course.corners.map((c, k): NamedCornerOnLap & { k: number } => ({ ...c, k })), missingCorners: new Set<number>() };
    const placed = placeCorners(baseGeo, cornerDraft);
    const missing = new Set<number>();
    const list: Array<NamedCornerOnLap & { k: number }> = [];
    placed.forEach((c, k) => (c ? list.push({ ...c, k }) : missing.add(k)));
    return { corners: list, missingCorners: missing };
  }, [cornerDraft, baseGeo, course.corners]);
  // 直して保存できるのは、保管場所があって、コースのフォルダが分かるときだけ
  const canEditCorners = !!course.folder && !!baseGeo && canUseRunStore();
  const startCornerEdit = () => {
    if (!baseGeo) return;
    setCornerDraft(course.file?.corners.length ? course.file.corners : cornersFromDetection(baseGeo, course.found));
    setSelectedCorner(null);
    setCornerError('');
    setShowCorners(true);
    // 地図の位置調整は、編集中はボタンを出さないので外す (なぞる操作が地図の位置を動かさないように)
    setIsAdjustingMap(false);
  };
  const saveCornerEdit = async () => {
    if (!cornerDraft || !course.folder) return;
    setCornerSaving(true);
    setCornerError('');
    try {
      await saveCourseCorners(course.folder, newCornerFile(course.folder, cornerDraft.map(c => ({ ...c, name: c.name.trim() || '?' })), false));
      setCornerDraft(null);
      setSelectedCorner(null);
    } catch (e) {
      setCornerError(t(`保存できませんでした: ${e instanceof Error ? e.message : e}`, `Could not save: ${e instanceof Error ? e.message : e}`));
    } finally {
      setCornerSaving(false);
    }
  };
  /** 画面の位置 (clientX/Y) にいちばん近い基準車の点の番号 (maxPx より遠ければ -1) */
  const nearestBasePoint = (canvas: HTMLCanvasElement, clientX: number, clientY: number, maxPx: number) => {
    const layout = layoutRef.current;
    if (!layout || !baseCar) return -1;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const { width, height, latMid, lonMid, cosLat, baseScale, pan } = layout;
    let best = -1, bestD = maxPx;
    baseCar.lap.points.forEach((p, i) => {
      const d = Math.hypot(width / 2 + (p.longitude - lonMid) * cosLat * baseScale + pan.x - x, height / 2 - (p.latitude - latMid) * baseScale + pan.y - y);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };
  /** 編集中に地図を押したとき: 札の近くならそのコーナーを選び、走行の線の近くならコーナーを足す */
  const handleMapTap = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const down = downAtRef.current;
    if (!cornerDraft || !baseGeo || !baseCar || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    const layout = layoutRef.current;
    if (!layout) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const { width, height, latMid, lonMid, cosLat, baseScale, pan } = layout;
    const toScreen = (lat: number, lon: number) => ({ x: width / 2 + (lon - lonMid) * cosLat * baseScale + pan.x, y: height / 2 - (lat - latMid) * baseScale + pan.y });
    for (const c of corners) {
      const p = baseCar.lap.points[c.apexIndex];
      if (!p) continue;
      const q = toScreen(p.latitude, p.longitude);
      // 名札は頂点の 14px 上に描く (描くところと同じ位置で当たりを見る)
      if (Math.hypot(q.x - x, q.y - 14 - y) < 16) { setSelectedCorner(c.k); return; }
    }
    let best = -1, bestD = 24;
    baseCar.lap.points.forEach((p, i) => {
      const q = toScreen(p.latitude, p.longitude);
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) { setSelectedCorner(null); return; }
    // 前後のコーナーに重ねない範囲で足す (重なると、走る順に置くときに前後のコーナーが置けなくなるため)。
    // 押した所がもうコーナーの中なら、そのコーナーを選ぶ
    const span = tapSpan(cornerDraft, baseGeo, best);
    if (!span) {
      const k = placeCorners(baseGeo, cornerDraft).findIndex(p => !!p && p.startIndex <= best && best <= p.endIndex);
      setSelectedCorner(k >= 0 ? k : null);
      return;
    }
    const r = applySpanCorner(cornerDraft, baseGeo, span.a, span.b);
    if (!r) {
      // 前後のコーナーが近くて足せる長さが無いときは、いちばん近いコーナーを選ぶ (何も起きないと分かりにくいため)
      const placed = placeCorners(baseGeo, cornerDraft);
      let k = -1, d = Infinity;
      placed.forEach((p, i) => { if (p && Math.abs(p.apexIndex - best) < d) { d = Math.abs(p.apexIndex - best); k = i; } });
      setSelectedCorner(k >= 0 ? k : null);
      return;
    }
    setCornerDraft(r.list);
    setSelectedCorner(r.index);
  };
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

    // 車両ポイント。基準車から遠く離れた場所 (別のコース) のログは表示範囲に入れない (基準車のコースが小さく潰れるため)
    const origin = cars[0]?.lap.points[0];
    for (const car of cars) {
      if (origin && car !== cars[0] && !passesNearPoint(car.lap.points, origin.latitude, origin.longitude, NEAR_BASE_RADIUS_M)) continue;
      for (const p of car.lap.points) {
        includePoint(p.latitude, p.longitude);
      }
    }

    // コースポリラインは、走行の線に沿っている線 (25 m 以内) だけを範囲に入れる (走行の線がなければ全部)。
    // OSM から取ったコース図には、サーキットの敷地の輪郭・別のコースも入っていて、全部に合わせると走行の線が小さく隅に寄る
    // (2026-10-19、筑波で 900 m 四方の輪郭)。走行の線が 1 周の一部だけでも、そのコースの線は範囲に入るので、コース全体が見える
    if (pathPolylines && pathPolylines.length > 0) {
      const hasTrace = minLat !== 90;
      const basePts = cars[0]?.lap.points ?? [];
      // 走行の線は 400 点ほどに間引いて比べる (コースの線の点の数 × 走行の線の点の数になるため)
      const stride = Math.max(1, Math.floor(basePts.length / 400));
      const trace: Array<[number, number]> = [];
      for (let i = 0; i < basePts.length; i += stride) trace.push([basePts[i].latitude, basePts[i].longitude]);
      const mPerDegLat = 111320;
      const mPerDegLon = 111320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
      const nearTrace = (lat: number, lon: number) =>
        trace.some(([tl, tn]) => Math.hypot((lat - tl) * mPerDegLat, (lon - tn) * mPerDegLon) < 25);
      for (const poly of pathPolylines) {
        // 点の 3 割以上が走行の線の近くにある線だけ (敷地の輪郭は所々でコースに近づくので、1 点だけでは決めない)。
        // 点の多い線は 200 点ほどに間引いて調べる
        if (hasTrace && trace.length > 0) {
          const pStride = Math.max(1, Math.floor(poly.length / 200));
          let tested = 0, near = 0;
          for (let i = 0; i < poly.length; i += pStride) { tested++; if (nearTrace(poly[i][1], poly[i][0])) near++; }
          if (near < tested * 0.3) continue;
        }
        for (const [lon, lat] of poly) {
          includePoint(lat, lon);
        }
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

  /** 今の見え方を、追従の倍率 (画面の短い辺に 0.003 度 × 倍率分の 1) で表す */
  const followZoomOf = () => {
    const l = layoutRef.current;
    if (!l) return 0;
    return (l.baseScale * FOLLOW_SPAN_DEG) / Math.min(l.width, l.height);
  };
  /** 追従の倍率にする (コース全体の倍率 zoom を、その見え方になるよう決める) */
  const setFollowZoom = (z: number) => {
    const l = layoutRef.current;
    if (!l || zoom <= 0) return;
    const fit = l.baseScale / zoom;
    const want = (Math.min(l.width, l.height) / FOLLOW_SPAN_DEG) * z;
    setZoom(Math.max(0.4, Math.min(MAX_ZOOM, want / fit)));
  };

  // 各車両の現在位置を、上に重ねた canvas に描く (下の canvas を描いたときの座標変換を使う)
  const curRef = useRef({ cars, compareAxis, currentDistance, currentTime, isFollowing });
  curRef.current = { cars, compareAxis, currentDistance, currentTime, isFollowing };
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
    const { cars, compareAxis, currentDistance, currentTime, isFollowing: following } = curRef.current;
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

      // 追従 (車を大きく出している) ときは、車の下に速度 (もとはアニメの窓だけ)
      if (following) {
        const label = `${curPt.speed.toFixed(0)} km/h`;
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(label, pos.x, pos.y + 14);
        ctx.fillStyle = car.slot.colorHex;
        ctx.fillText(label, pos.x, pos.y + 14);
      }
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
      ctx.fillText(tr('コースデータがありません', 'No course data'), width / 2, height / 2);
      drawCars();
      return;
    }

    // アスペクト比維持の座標変換
    const latMid = (bounds.minLat + bounds.maxLat) / 2;
    const lonMid = (bounds.minLon + bounds.maxLon) / 2;
    const cosLat = Math.cos((latMid * Math.PI) / 180);

    const geoWidth = (bounds.maxLon - bounds.minLon) * cosLat;
    const geoHeight = bounds.maxLat - bounds.minLat;

    // コーナーの編集中は、右の一覧に隠れない左の部分にコースを収める (一覧の幅 + 余白)
    const editPanelW = cornerDraft ? Math.min(224, width * 0.48) + 8 : 0;
    const scaleX = ((width - editPanelW) * 0.85) / geoWidth;
    const scaleY = (height * 0.85) / geoHeight;
    const baseScale = Math.min(scaleX, scaleY) * zoom;

    // 追従中は、基準車の現在位置が画面の中央に来るように平行移動量を決める
    let pan = editPanelW ? { x: panOffset.x - editPanelW / 2, y: panOffset.y } : panOffset;
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
        const image = getTileImage(tile, onTileLoadRef.current);
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

    // 計測線・セクターの名前は、線の端の先に書く (線の真ん中に書くと、走行の線と車の印に重なって読めない)。
    // 両端のうち、書く所の近くを走行の線が通っていないほうを選ぶ (同じなら、コース図の真ん中から遠いほう)
    const mapCenter = toScreen(latMid, lonMid);
    const traceScreen: Array<{ x: number; y: number }> = [];
    {
      const pts = cars[0]?.lap.points ?? [];
      // 名前の置き場所を決めるだけなので 200 点ほどに間引く (追従中は毎コマ描き直すため)
      const stride = Math.max(1, Math.floor(pts.length / 200));
      for (let i = 0; i < pts.length; i += stride) traceScreen.push(toScreen(pts[i].latitude, pts[i].longitude));
    }
    const crowd = (x: number, y: number) => traceScreen.reduce((n, q) => n + (Math.hypot(q.x - x, q.y - y) < 16 ? 1 : 0), 0);
    const drawGateLabel = (pA: { x: number; y: number }, pB: { x: number; y: number }, text: string, color: string) => {
      const len = Math.hypot(pB.x - pA.x, pB.y - pA.y);
      // 線が短すぎて向きが決まらないときは、線の上に書く
      const candidates = len < 1
        ? [{ x: pA.x, y: pA.y - 10, ux: 0, uy: -1, d: 0 }]
        : [[pA, pB], [pB, pA]].map(([outer, inner]) => {
            const ux = (outer.x - inner.x) / len, uy = (outer.y - inner.y) / len;
            return { x: outer.x + ux * 6, y: outer.y + uy * 6, ux, uy, d: Math.hypot(outer.x - mapCenter.x, outer.y - mapCenter.y) };
          });
      const best = candidates
        .map(c => ({ ...c, n: crowd(c.x + c.ux * 12, c.y + c.uy * 8) }))
        .sort((a, b) => a.n - b.n || b.d - a.d)[0];
      const { x, y, ux, uy } = best;
      ctx.textAlign = ux > 0.35 ? 'left' : ux < -0.35 ? 'right' : 'center';
      ctx.textBaseline = uy > 0.35 ? 'top' : uy < -0.35 ? 'bottom' : 'middle';
      // 縁取りをして、下の線の上でも読めるようにする
      ctx.lineWidth = 3;
      ctx.strokeStyle = C.bg;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      ctx.textBaseline = 'alphabetic';
    };

    // 2. コントロールライン (スタート/フィニッシュ)
    if (controlLine) {
      const pA = toScreen(controlLine.latA, controlLine.lonA);
      const pB = toScreen(controlLine.latB, controlLine.lonB);

      // 文字は書かず、模様のない 1 本の太い線で描く (セクターの線は細い点線なので見分けられる)
      ctx.strokeStyle = C.strong;
      ctx.lineWidth = 6;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.stroke();
    }
    // ゴールの線 (スタートとゴールが別のコース): 市松模様のように白と黒を交互に
    if (finishLine) {
      const pA = toScreen(finishLine.latA, finishLine.lonA);
      const pB = toScreen(finishLine.latB, finishLine.lonB);
      ctx.lineWidth = 6;
      ctx.lineCap = 'butt';
      ctx.strokeStyle = '#000000';
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(pA.x, pA.y); ctx.lineTo(pB.x, pB.y); ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pA.x, pA.y); ctx.lineTo(pB.x, pB.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    // 3. セクターゲート (S1, S2, S3...)
    sectors.forEach((sec, idx) => {
      // 計測線と同じ所 (5 m 以内) にあるセクター (最後のセクターの終わり) は、計測線と重なるので線も名前も描かない。
      // 画面の上の距離で決めると、拡大の度合いで変わるので、地面の上の距離で決める
      if (controlLine) {
        const dNorth = ((sec.latA + sec.latB) / 2 - (controlLine.latA + controlLine.latB) / 2) * 111320;
        const dEast = ((sec.lonA + sec.lonB) / 2 - (controlLine.lonA + controlLine.lonB) / 2) * 111320 * cosLat;
        if (Math.hypot(dNorth, dEast) < 5) return;
      }
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

      ctx.font = 'bold 9px sans-serif';
      drawGateLabel(pA, pB, sec.name || `S${idx + 1}`, C.sector);
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
        // 名前の長さに合わせた札 (「ダンロップ」などの名前も入るように)
        const label = cornerLabel(c);
        const w = Math.max(18, ctx.measureText(label).width + 8);
        const picked = cornerDraft !== null && c.k === selectedCorner;
        if (picked) {
          // 選んだコーナーの範囲 (入口から出口まで) を太く
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 6;
          ctx.beginPath();
          for (let i = c.startIndex; i <= c.endIndex; i++) {
            const q = baseCar.lap.points[i];
            if (!q) continue;
            const s = toScreen(q.latitude, q.longitude);
            if (i === c.startIndex) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
          }
          ctx.stroke();
        }
        ctx.fillStyle = picked ? '#f59e0b' : '#0f1117d0';
        ctx.beginPath();
        ctx.roundRect(pos.x - w / 2, pos.y - 23, w, 18, 9);
        ctx.fill();
        // 縁取り (暗いテーマ・暗い航空写真の上でも札が見えるように)
        if (!picked) {
          ctx.strokeStyle = '#fbbf2499';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.fillStyle = picked ? '#0f1117' : '#fbbf24';
        ctx.fillText(label, pos.x, pos.y - 14);
      }
    }

    // なぞっている範囲
    if (cornerSpan && baseCar) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const i0 = Math.min(cornerSpan.a, cornerSpan.b), i1 = Math.max(cornerSpan.a, cornerSpan.b);
      for (let i = i0; i <= i1; i++) {
        const q = baseCar.lap.points[i];
        if (!q) continue;
        const sp = toScreen(q.latitude, q.longitude);
        if (i === i0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
      }
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    layoutRef.current = { width, height, latMid, lonMid, cosLat, baseScale, pan };
    drawCars();
  }, [cornerSpan, cars, controlLine, finishLine, sectors, pathPolylines, followPosition, compareAxis, bounds, zoom, panOffset, isFollowing, colorMode, corners, selectedCorner, cornerDraft, lineDeltas, showCorners, background, mapOffset, tileTick, resizeTick, dpr, theme, lang]);

  // パン操作 (ドラッグ)
  // ドラッグの状態は、同じイベントの中で続けて読めるよう ref で持つ (タッチは動かしたときに押下と移動が続けて届くため)
  const panningRef = useRef(false);
  // ドラッグを始めた (前回の) ポインターの位置と、そのときの表示位置
  const dragFromRef = useRef({ x: 0, y: 0 });
  const panBaseRef = useRef<{ x: number; y: number } | null>(null);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // コーナーの編集中に走行の線の上から動かしたら、地図を動かさずに範囲をなぞる
    spanRef.current = null;
    if (cornerDraft && baseGeo && !isAdjustingMap) {
      // タッチは押した時のイベントを後で渡されるため、currentTarget が空のことがある (canvasRef を使う)
      const i = canvasRef.current ? nearestBasePoint(canvasRef.current, e.clientX, e.clientY, 14) : -1;
      if (i >= 0) {
        spanRef.current = { a: i, b: i };
        panningRef.current = false;
        return;
      }
    }
    panningRef.current = true;
    dragFromRef.current = { x: e.clientX, y: e.clientY };
    // 表示位置の基準は、実際に動かしたときに決める (タップしただけでは追従を外さない)
    panBaseRef.current = null;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (spanRef.current) {
      const i = canvasRef.current ? nearestBasePoint(canvasRef.current, e.clientX, e.clientY, 60) : -1;
      // 一度に大きく跳んだ点 (コースが並んでいる所で隣の線に移った・周の始めと終わりをまたいだ) は使わない
      if (i >= 0 && i !== spanRef.current.b && baseGeo && Math.abs(baseGeo.s[i] - baseGeo.s[spanRef.current.b]) < 150) {
        spanRef.current = { ...spanRef.current, b: i };
        setCornerSpan(spanRef.current);
      }
      return;
    }
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

  const handleMouseUp = (cancelled?: boolean) => {
    const span = spanRef.current;
    spanRef.current = null;
    if (span) {
      setCornerSpan(null);
      if (!cancelled && span.a !== span.b && cornerDraft && baseGeo) {
        const r = applySpanCorner(cornerDraft, baseGeo, span.a, span.b);
        if (r) { setCornerDraft(r.list); setSelectedCorner(r.index); }
        // 動かした量が小さい (縮小して見ている) と、離したあとの click でコーナーをもう 1 つ足してしまうため
        downAtRef.current = null;
      }
    }
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
    onPinch: scale => setZoom(z => Math.max(0.4, Math.min(MAX_ZOOM, z * scale)))
  });

  // ホイールズーム
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    setZoom(z => Math.max(0.4, Math.min(MAX_ZOOM, z * factor)));
  };

  const handleReset = () => {
    setIsFollowing(false);
    setZoom(1.0);
    setPanOffset({ x: 0, y: 0 });
  };

  // 違うコースになったら、コース全体を表示し直し、直しかけのコーナーの編集はやめる
  // (前のコースで動かした位置のままだと中央からずれ、前のコースのコーナーを新しいコースに保存してしまうため)
  const courseKeyRef = useRef(course.folder ?? circuitName);
  useEffect(() => {
    const key = course.folder ?? circuitName;
    if (courseKeyRef.current === key) return;
    courseKeyRef.current = key;
    handleReset();
    setCornerDraft(null);
    setSelectedCorner(null);
    spanRef.current = null;
    setCornerSpan(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course.folder, circuitName]);

  return (
    <div className="flex flex-col h-full bg-surface-2 rounded-lg border border-line-2 overflow-hidden select-none shadow-lg">
      {/* ツールバー */}
      {/* 狭いときはボタン単位で折り返す (文字の途中で折れないよう nowrap)。見出しは出さない (切り替えのないウインドウなので) */}
      <div className={`touch-toolbar flex flex-wrap items-center justify-between gap-x-2 gap-y-1 bg-surface-3 border-b border-line-2 text-xs whitespace-nowrap shrink-0 ${compact ? 'px-2 py-1' : 'px-3 py-1.5'}`}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">

          {/* カラーモード切替。コーナーの編集中は出さない (ボタンが折り返して、スマートフォンでは地図が狭くなるため。下の 2 つも同じ) */}
          <div className={`flex items-center bg-surface-1 rounded p-0.5 border border-line-3 ${cornerDraft ? 'hidden' : ''}`}>
            <button
              onClick={() => setColorMode('car')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                colorMode === 'car' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('車両色', 'Car colour')}
            </button>
            <button
              onClick={() => setColorMode('speed')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                colorMode === 'speed' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {compact ? t('車速', 'Speed') : t('車速ヒート', 'Speed heat')}
            </button>
            <button
              onClick={() => setColorMode('accel')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                colorMode === 'accel' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('加減速', 'Accel')}
            </button>
            <button
              onClick={() => setColorMode('line')}
              title={t('基準車 (Car 1) の走行ラインに対する、他の車両の左右のズレを色分け表示', 'Colours how far left or right the other cars are from the reference car (Car 1) line')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                colorMode === 'line' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {compact ? t('ライン', 'Line') : t('ライン偏差', 'Line delta')}
            </button>
          </div>
          <button
            onClick={() => setShowCorners(v => !v)}
            title={t('コーナー番号の表示切替', 'Show or hide corner numbers')}
            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-all ${cornerDraft ? 'hidden' : ''} ${
              showCorners ? 'border-amber-500/50 text-amber-300' : 'border-line-3 text-slate-500 hover:text-slate-300'
            }`}
          >
            {compact ? t('コーナー', 'Corners') : t('コーナー番号', 'Corner numbers')}
          </button>
          {canEditCorners && !cornerDraft && (
            <button
              onClick={startCornerEdit}
              title={t('コーナーの名前を付ける・まとめる・分ける (保管場所の course/Corner/ に保存)', 'Name, merge or split corners (saved to course/Corner/ in your storage)')}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border border-line-3 text-slate-400 hover:text-slate-200"
              data-testid="corner-edit"
            >
              <PenLine size={11} />
              {compact ? t('編集', 'Edit') : t('コーナーの編集', 'Edit corners')}
            </button>
          )}
          <select
            value={background}
            onChange={e => handleSelectBackground(e.target.value as MapBackground)}
            title={t('コース図の背景に地図を表示します (国土地理院タイル。表示にはインターネット接続が必要です)', 'Shows a map behind the track (GSI tiles; needs an internet connection)')}
            aria-label={t('背景地図', 'Background map')}
            className="bg-surface-1 border border-line-3 text-[11px] text-slate-300 rounded px-1.5 py-0.5 outline-none"
          >
            <option value="none">{compact ? t('地図なし', 'No map') : t('背景: なし', 'Background: none')}</option>
            <option value="photo">{compact ? '' : t('背景: ', 'Background: ')}{t('航空写真', 'Aerial photo')}</option>
            <option value="standard">{compact ? '' : t('背景: ', 'Background: ')}{t('地図', 'Map')}</option>
          </select>
          {background !== 'none' && !cornerDraft && (
            <button
              onClick={() => setIsAdjustingMap(v => !v)}
              aria-pressed={isAdjustingMap}
              title={t('ON の間は、ドラッグで背景地図だけを動かして GPS 軌跡に合わせます。OFF にすると通常の移動・拡大操作に戻ります', 'While ON, dragging moves only the background map so it lines up with the GPS trace. Turn OFF to return to normal pan and zoom')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border transition-all ${
                isAdjustingMap ? 'bg-emerald-600 border-emerald-500 text-white' : 'border-line-3 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Move size={11} />
              {compact ? t('位置調整', 'Align') : t('地図の位置調整', 'Align map')}{isAdjustingMap ? ': ON' : ''}
            </button>
          )}
        </div>

        {/* コントロール */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              // 追従を外すときは、今見えている位置のままにする
              if (isFollowing) setPanOffset(drawnPanRef.current);
              // 追従を始めるとき、コース全体に近い見え方なら、車を大きく出す (アニメの窓と同じ 3x)
              else if (followZoomOf() < FOLLOW_ZOOMS[0]) setFollowZoom(3);
              setIsFollowing(!isFollowing);
            }}
            title={t('車両追従 (基準車を常に中央に表示)', 'Follow car (keep the reference car centred)')}
            aria-pressed={isFollowing}
            className={`flex items-center gap-1 px-1.5 py-0.5 mr-1 rounded border text-[11px] transition-colors ${
              isFollowing ? 'bg-emerald-600 border-emerald-500 text-white' : 'border-line-3 text-slate-400 hover:text-slate-200'
            }`}
          >
            <LocateFixed size={13} />
            {t('追従', 'Follow')}
          </button>
          {/* 追従のときの拡大率 (アニメの窓と同じ 2x・3x・5x) */}
          {isFollowing && (
            <div className="flex items-center mr-1" data-testid="track-follow-zoom">
              {FOLLOW_ZOOMS.map(z => (
                <button
                  key={z}
                  onClick={() => setFollowZoom(z)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${Math.abs(followZoomOf() - z) < 0.05 ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400 hover:bg-surface-4'}`}
                >
                  {z}x
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => setZoom(z => Math.min(MAX_ZOOM, z * 1.25))}
            title={t('拡大', 'Zoom in')}
            className="p-1 hover:bg-surface-5 rounded text-slate-300 transition-colors"
          >
            <ZoomIn size={14} />
          </button>
          <button
            onClick={() => setZoom(z => Math.max(0.4, z * 0.8))}
            title={t('縮小', 'Zoom out')}
            className="p-1 hover:bg-surface-5 rounded text-slate-300 transition-colors"
          >
            <ZoomOut size={14} />
          </button>
          <button
            onClick={handleReset}
            title={t('コース全体を表示', 'Show the whole course')}
            className="p-1 hover:bg-surface-5 rounded text-slate-300 transition-colors"
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>

      {/* セクターからの一斉スタート (もとはアニメの窓だけ。PLAN-28)。コーナーの編集中は出さない */}
      {sectorStart && sectors.length > 0 && !cornerDraft && (
        <div className={`flex items-center bg-surface-3 border-b border-line-2 text-xs whitespace-nowrap shrink-0 overflow-x-auto ${compact ? 'px-2 py-1' : 'px-3 py-1'}`} data-testid="track-sector-start">
          <SectorStartBar compact={compact} sectors={sectors} {...sectorStart} />
        </div>
      )}

      {/* Canvas。ウインドウの残りの高さに合わせる (h-full・最低の高さを付けると、上の段が 2 行になったときに枠の外へはみ出し、コース図の下が切れる) */}
      <div className="relative flex-1 w-full min-h-0">
        <canvas
          ref={canvasRef}
          {...pointerHandlers}
          onPointerDownCapture={e => { downAtRef.current = { x: e.clientX, y: e.clientY }; }}
          onClick={handleMapTap}
          onWheel={handleWheel}
          className={`w-full h-full block touch-none ${isAdjustingMap ? 'cursor-move' : 'cursor-grab active:cursor-grabbing'}`}
        />
        {/* 車両の現在位置 (操作は下の canvas が受ける) */}
        <canvas ref={carCanvasRef} className="absolute inset-0 pointer-events-none block" />

        {cornerDraft && baseGeo && (
          <CornerEditPanel
            draft={cornerDraft}
            missing={missingCorners}
            selected={selectedCorner}
            onSelect={setSelectedCorner}
            onRename={(k, name) => setCornerDraft(d => d && d.map((c, i) => (i === k ? { ...c, name } : c)))}
            onMerge={k => { setCornerDraft(d => d && mergeCorners(d, k, d[k].name)); setSelectedCorner(k); }}
            onSplit={k => setCornerDraft(d => d && splitCorner(d, k, baseGeo))}
            onDelete={k => { setCornerDraft(d => d && d.filter((_, i) => i !== k)); setSelectedCorner(null); }}
            onRedetect={() => { setCornerDraft(d => carryNames(cornersFromDetection(baseGeo, course.found), d ?? [])); setSelectedCorner(null); }}
            onSave={() => void saveCornerEdit()}
            onCancel={() => { setCornerDraft(null); setSelectedCorner(null); }}
            saving={cornerSaving}
            error={cornerError}
          />
        )}

        {/* 地図の位置調整中の案内 */}
        {isAdjustingMap && (
          <div className="absolute top-2 left-2 bg-emerald-950/90 border border-emerald-500/60 rounded px-2 py-1 text-[10px] text-emerald-100 flex items-center gap-2" data-testid="map-adjust-panel">
            <span>{t('ドラッグで地図を移動 (ホイールで拡大縮小)', 'Drag to move the map (wheel to zoom)')}</span>
            <span className="font-mono" data-testid="map-offset">
              {t('東', 'E')} {mapOffset.eastM >= 0 ? '+' : ''}{mapOffset.eastM.toFixed(1)}m / {t('北', 'N')} {mapOffset.northM >= 0 ? '+' : ''}{mapOffset.northM.toFixed(1)}m
            </span>
            <button onClick={handleResetMapOffset} className="px-1.5 py-0.5 rounded border border-emerald-500/60 hover:bg-emerald-800/60">{t('リセット', 'Reset')}</button>
            <button onClick={() => setIsAdjustingMap(false)} className="px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold">{t('完了', 'Done')}</button>
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
            {t(TILE_ATTRIBUTION.text, 'Source: GSI Japan')}
          </a>
        )}

        {/* 凡例 / ガイド */}
        {colorMode === 'speed' && (
          <div className="absolute bottom-2 left-2 bg-surface-1/88 border border-line-3 rounded px-2 py-1 text-[10px] text-slate-300 flex items-center gap-2">
            <span>{t('低速 (青)', 'Slow (blue)')}</span>
            <div className="w-16 h-2 rounded bg-gradient-to-r from-blue-600 via-green-500 to-red-500"></div>
            <span>{t('高速 (赤)', 'Fast (red)')}</span>
          </div>
        )}
        {colorMode === 'line' && (
          <div className="absolute bottom-2 left-2 bg-surface-1/88 border border-line-3 rounded px-2 py-1 text-[10px] text-slate-300 flex items-center gap-2" data-testid="line-delta-legend">
            {lineDeltas.length === 0 ? (
              <span className="text-amber-300">{t('比較する車両 (Car 2 以降) を「データ管理」で選択してください', 'Select cars to compare (Car 2 and later) on the data tab')}</span>
            ) : (
              <>
                <span className="text-sky-400">{t('左', 'Left')} {LINE_DELTA_FULL_SCALE_M}m</span>
                <div className="w-20 h-2 rounded bg-gradient-to-r from-sky-400 via-slate-700 to-orange-400"></div>
                <span className="text-orange-400">{t('右', 'Right')} {LINE_DELTA_FULL_SCALE_M}m</span>
                <span className="text-slate-500">{theme === 'light' && background === 'none' ? t('濃い線', 'Dark line') : t('白線', 'White line')}{t(': 基準車 / 進行方向に対する左右', ': reference car / left-right relative to direction of travel')}</span>
                <label className="flex items-center gap-1 text-slate-300 cursor-pointer" title={t('ラップ間の GPS の位置ずれ (ほぼ一定の平行移動として現れる誤差) を推定して差し引きます。周回コースでのみ有効です', 'Estimates and removes the GPS position offset between laps (an error that appears as a roughly constant shift). Only works on circuits')}>
                  <input type="checkbox" checked={correctGpsShift} onChange={e => setCorrectGpsShift(e.target.checked)} className="accent-red-500" />
                  {t('GPS ずれ補正', 'GPS offset correction')}
                </label>
                {correctGpsShift && (
                  <span className="text-slate-500" data-testid="gps-shift-amount">
                    {lineDeltas.map(d => {
                      const amount = Math.hypot(d.delta.shiftEastM, d.delta.shiftNorthM);
                      return amount > 0 ? `${amount.toFixed(1)}m` : t('推定不可', 'n/a');
                    }).join(' / ')}
                  </span>
                )}
              </>
            )}
          </div>
        )}
        {colorMode === 'accel' && (
          <div className="absolute bottom-2 left-2 bg-surface-1/88 border border-line-3 rounded px-2 py-1 text-[10px] text-slate-300 flex items-center gap-2">
            <span className="text-red-400">{t('減速G (赤)', 'Braking G (red)')}</span>
            <div className="w-16 h-2 rounded bg-gradient-to-r from-red-500 via-slate-600 to-cyan-400"></div>
            <span className="text-cyan-400">{t('加速G (青)', 'Accel G (blue)')}</span>
          </div>
        )}
      </div>
    </div>
  );
};
