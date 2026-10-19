import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { CompareAxis, Lap, Session, TelemetryPoint, SelectedCarSlot, ControlLine, Sector, CircuitPreset, PolylineSource } from './types/telemetry';
import { parseDtb } from './services/dtbParser';
import { parseDigispiceRawBinary } from './services/rawBinaryParser';
import { parseCsv } from './services/csvParser';
import { parseNmea } from './services/nmeaParser';
import { blobByteSource, goproRecording, NoGoproGpsError, parseGoproGps } from './services/gpmfParser';
import { videoSyncManager } from './services/videoSyncManager';
import { tr, useT } from './utils/i18n';
import { inflateXrz, isAimCsv, isXrk, parseAimCsv, parseXrk } from './services/aimFormats';
import { isIbt, parseIbt } from './services/ibtParser';
import { MOTEC_CSV_ENABLED, isGpx, isMotecCsv, isRaceChronoCsv, isTcx, isVbo, parseMotecCsv, parseGpx, parseRaceChronoCsv, parseTcx, parseVbo } from './services/externalFormats';
import { parseFit } from './services/fitParser';
import { parsePth, parseCln } from './services/pthParser';
import { countGateCrossings, createVirtualControlLine, extractLaps, firstGateCrossingTime, gateDirection, passesNearControlLine, passesNearPoint } from './services/lapCalculator';
import { ConvertTab } from './components/ConvertTab';
import { CIRCUIT_PRESETS, ALL_CIRCUITS, findMatchingCircuit, resolveCircuitPolylines, findUserPolylines } from './services/circuitDatabase';
import { userCircuitStorage, runsOnPolylines } from './services/userCircuitStorage';

import { Header } from './components/Header';
import { SpeedGraphWindow } from './components/SpeedGraphWindow';
import { TrackMapWindow } from './components/TrackMapWindow';
import { ReplayWindow } from './components/ReplayWindow';
import { FrictionCircleWindow } from './components/FrictionCircleWindow';
import { DriftWindow } from './components/DriftWindow';
import { CornerAnalysisWindow } from './components/CornerAnalysisWindow';
import { BrakingAnalysisWindow } from './components/BrakingAnalysisWindow';
import { VideoSyncWindow } from './components/VideoSyncWindow';
import { useVideoTracks, useVideoView, videoEndSessionSec } from './services/videoViewStore';
import { DataTab } from './components/DataTab';
import { LoggerTab } from './components/LoggerTab';
import { CircuitEditorModal } from './components/CircuitEditorModal';
import { DonateModal } from './components/DonateModal';
import { useResizableSplit } from './hooks/useResizableSplit';
import { canUseLoggerUsb, fileAccept } from './utils/device';
import { useCompactLayout, useLandscape } from './hooks/useCompactLayout';
import { GFilterLevel, applyGFilter, getGFilterLevel, setGFilterLevel } from './services/physics';
import { BottomTabBar, MobileSeekBar } from './components/MobileNav';
import { SplitResizer } from './components/SplitResizer';
import { interpolatePoint } from './utils/telemetrySearch';

/**
 * 距離を補正した周で、補正後の距離が 0 になる時刻 (秒)。
 * 補正で走り始めが 0 m より先に出たときは、最初の点の車速で 0 m まで戻した時刻 (負) を返す
 */
function timeAtDistanceZero(points: TelemetryPoint[], scale: number, offsetKm: number): number {
  const d = (p: TelemetryPoint) => p.distance * scale + offsetKm;
  if (points.length === 0) return 0;
  const first = points[0];
  if (d(first) >= 0) {
    const kmPerSec = first.speed / 3600;
    return kmPerSec > 0.001 ? first.time - d(first) / kmPerSec : first.time;
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (d(b) >= 0) {
      const span = d(b) - d(a);
      return span > 0 ? a.time + ((0 - d(a)) / span) * (b.time - a.time) : b.time;
    }
  }
  return 0;
}

// コースのプリセットを、近くのログだけに反映するときの範囲 (自動判定と同じ 15 km)
const COURSE_MATCH_RADIUS_M = 15000;
// 空の値は毎回同じものを渡す (描画の再計算を減らすため)
const NO_SECTORS: Sector[] = [];
const NO_POLYLINES: Array<Array<[number, number]>> = [];

/** ウインドウをたたむ / 開くボタン (パソコン表示のウインドウの帯の右端に置く) */
const CollapseButton: React.FC<{ collapsed: boolean; onClick: () => void }> = ({ collapsed, onClick }) => (
  <button
    onClick={onClick}
    title={collapsed ? tr('開く', 'Expand') : tr('たたむ', 'Collapse')}
    aria-expanded={!collapsed}
    className="ml-auto shrink-0 p-0.5 rounded text-slate-400 hover:text-slate-200 hover:bg-surface-4 cursor-pointer"
  >
    {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
  </button>
);

// パソコン表示でたたんだウインドウを覚えておくキー
const COLLAPSED_STORAGE_KEY = 'ds_collapsed_panes';

// ドリフト採点・評価の表示 (2026-10-17 に表示をやめた。DriftWindow などのコードは残してあるので、true に戻せば出る)
const SHOW_DRIFT = false;

// スマートフォンのグラフ解析タブで、速度ウインドウの下 (横向きでは右) に切り替えて出すウインドウ
type MobilePanel = 'map' | 'replay' | 'gg' | 'corner' | 'braking' | 'drift';
const MOBILE_PANELS: { id: MobilePanel; label: [string, string] }[] = ([
  { id: 'map', label: ['コース', 'Map'] },
  { id: 'replay', label: ['アニメ', 'Anim'] },
  { id: 'gg', label: ['GG', 'GG'] },
  { id: 'corner', label: ['コーナー', 'Corners'] },
  { id: 'braking', label: ['ブレーキ', 'Braking'] },
  { id: 'drift', label: ['ドリフト', 'Drift'] }
] as { id: MobilePanel; label: [string, string] }[]).filter(p => SHOW_DRIFT || p.id !== 'drift');

export const App: React.FC = () => {
  // 画面の文言 (言語を切り替えると描き直す)
  const T = useT();
  // タブ
  // 公開ページでは URL の末尾 (#convert など) で最初に開くタブを指定できる
  const [currentTab, setCurrentTab] = useState<'graph' | 'data' | 'logger' | 'video' | 'convert'>(() => {
    const h = typeof window !== 'undefined' ? window.location.hash.replace('#', '') : '';
    // ロガーと USB でつなげない環境 (スマートフォン・タブレット・Safari など) ではロガー設定を出さないので、#logger でもグラフ解析を開く
    if (h === 'logger' && !canUseLoggerUsb) return 'graph';
    return h === 'convert' || h === 'data' || h === 'logger' || h === 'video' ? h : 'graph';
  });
  const currentTabRef = useRef(currentTab);
  currentTabRef.current = currentTab;
  // 変換画面で書き出すログ (データ管理の「変換画面で開く」で選ぶ。空なら基準車のログ)
  const [convertSessionId, setConvertSessionId] = useState('');

  // スマートフォン向けの配置 (画面の大きさで切り替える)。スマートフォンでは動画同期を出さない
  const isCompact = useCompactLayout();
  const isLandscape = useLandscape();
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('map');

  // パソコン表示で、たたんでいるウインドウ (anim: 左下のアニメーション / 動画、map: 全コース、sub: 右下の GG など)。端末に保存する
  const [collapsed, setCollapsed] = useState<{ anim: boolean; map: boolean; sub: boolean }>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) || '{}');
      return { anim: !!v.anim, map: !!v.map, sub: !!v.sub };
    } catch {
      return { anim: false, map: false, sub: false };
    }
  });
  // 右の列 (全コースと GG など) を両方たたんでいるか
  const rightCollapsed = collapsed.map && collapsed.sub;
  // nextMode: タブを押して開くときの、そのタブ (まだ state に入っていないので渡してもらう)
  const toggleCollapsed = (key: 'anim' | 'map' | 'sub', value?: boolean, nextMode?: string) => {
    // たたんだ動画のウインドウを開くときは、再生を止める (開いた動画が再生の基準に切り替わり、続きから再生できないため)
    const opening = collapsed[key] && value !== true;
    const mode = nextMode ?? (key === 'anim' ? leftBottomMode : key === 'sub' ? subWindowMode : '');
    const videoPane = key !== 'map' && mode === 'video';
    if (opening && videoPane) setIsPlaying(false);
    setCollapsed(prev => {
      const next = { ...prev, [key]: value ?? !prev[key] };
      try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // 保存できなくても、この画面では切り替える
      }
      return next;
    });
  };
  useEffect(() => {
    if (isCompact && currentTab === 'video') setCurrentTab('graph');
  }, [isCompact, currentTab]);

  // グラフ画面・左下モード ('replay' | 'video')
  const [leftBottomMode, setLeftBottomMode] = useState<'replay' | 'video'>('replay');

  // サブウインドウ表示モード ('all' | 'track_friction' | 'replay_focus' | 'video')
  const [subWindowMode, setSubWindowMode] = useState<'all' | 'track_friction' | 'replay_focus' | 'video' | 'corner' | 'braking'>('all');

  // ウィンドウ分割リサイズフック (左右、左側上下、右側上下)
  const horizSplit = useResizableSplit({ initialRatio: 0.58, direction: 'horizontal', storageKey: 'ds_split_horiz' });
  const leftVertSplit = useResizableSplit({ initialRatio: 0.60, direction: 'vertical', storageKey: 'ds_split_left_vert' });
  const rightVertSplit = useResizableSplit({ initialRatio: 0.55, direction: 'vertical', storageKey: 'ds_split_right_vert' });

  // セッション一覧
  const [sessions, setSessions] = useState<Session[]>([]);

  // 選択中の車両スロット (最大4台: 0:赤, 1:青, 2:緑, 3:橙)
  const [selectedCars, setSelectedCars] = useState<SelectedCarSlot[]>([]);

  // コース・コントロールライン・セクター
  // ログを読み込むかコースを選ぶまでは未設定
  // 直前に決まったコースの設定 (計測線・セクター・コース名)。次に読み込むログのコース判定の手がかりにする。
  // コースの設定はセッションごとに持ち、画面には基準車のセッションのものを表示する (アプリ全体で 1 つにはしない)
  type CourseHint = { cl?: ControlLine; sec: Sector[]; name: string; polylines?: Array<Array<[number, number]>>; polylinesSource?: PolylineSource };
  const courseRef = useRef<CourseHint>({ sec: [], name: '' });
  // ログを 1 本も読み込んでいないときに画面に出すコース (先にコース編集・プリセット・コース図を設定したとき)
  const [idleCourse, setIdleCourse] = useState<CourseHint>({ sec: [], name: '' });
  const setCourseHint = (c: CourseHint) => {
    courseRef.current = c;
    setIdleCourse(c);
  };
  // 登録済みのユーザーコースの数 (データ管理タブの表示用)。保存済みのデータは起動後に非同期で読み込むので、読み込み後に更新する
  const [userCircuitCount, setUserCircuitCount] = useState(0);
  useEffect(() => {
    userCircuitStorage.ready.then(() => setUserCircuitCount(userCircuitStorage.getCircuitCount()));
  }, []);
  // コース図の取得の受付番号 (セッションごと)。後から別のコース図を設定したセッションに、古い取得結果を上書きしない
  const polylineRequestRef = useRef(new Map<string, number>());

  // 再生アニメーション状態
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [currentDistanceKm, setCurrentDistanceKm] = useState(0);

  // モーダル
  const [isCircuitEditorOpen, setIsCircuitEditorOpen] = useState(false);
  const [isDonateModalOpen, setIsDonateModalOpen] = useState(false);

  // コース図の問い合わせの通し番号 (最後に出した問い合わせの応答だけを反映するため)

  // 非表示ファイルインプット参照
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pthInputRef = useRef<HTMLInputElement | null>(null);
  const clnInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // 基準車。ふだんは Car 1 (赤) だが、Car 1 が空のとき (セッションを消した後など) は、割り当てのある一番若いスロットを基準にする。
  // 各ウインドウは表示中の車両の先頭 (activeCars[0]) を基準車として描くので、それと必ず一致させる
  const findLap = (c: SelectedCarSlot) =>
    sessions.find(s => s.id === c.sessionId)?.laps.find(l => l.lapNumber === c.lapNumber);
  const baseSelected = [...selectedCars].sort((a, b) => a.slot - b.slot).find(c => findLap(c));
  const baseSession = sessions.find(s => s.id === baseSelected?.sessionId);
  const baseLap = baseSelected ? findLap(baseSelected) : undefined;

  // 画面に出すコース (計測線・セクター・コース名・コース図) は、基準車のセッション (なければ最初のセッション) のもの
  const courseSession = baseSession ?? sessions[0];
  const currentControlLine = courseSession ? courseSession.controlLine : idleCourse.cl;
  const currentSectors = courseSession ? courseSession.sectors : idleCourse.sec;
  const currentCircuitName = courseSession ? courseSession.circuitName : idleCourse.name;
  const currentPthPolylines = (courseSession ? courseSession.pathPolylines : idleCourse.polylines) ?? NO_POLYLINES;
  // 最新のセッション一覧と基準のセッション。ファイルを読む await の後で使う処理が、その間に読み込まれたセッションを見落とさないように
  const latestRef = useRef({ sessions, courseSessionId: courseSession?.id });
  latestRef.current = { sessions, courseSessionId: courseSession?.id };

  // 車両どうしを比べる基準 (速度ウインドウの横軸)。全コースウインドウ・アニメーション・摩擦円の車両位置もこれに合わせる
  const [compareAxis, setCompareAxis] = useState<CompareAxis>('distance');

  // セクターの同時スタートの動作: base = 基準車をそのセクター線へ移すだけ / all = 全車がそのセクター線を同時に通るよう時刻をそろえる
  const [sectorStartMode, setSectorStartMode] = useState<'base' | 'all'>('base');
  // all のときに時刻をそろえているセクター線 (sectors の添字。セクター k の始まりは線 k-1)。周や車を選び直したら解除する
  const [alignedSector, setAlignedSector] = useState<number | null>(null);
  const carsKey = selectedCars.map(c => `${c.slot}:${c.sessionId}:${c.lapNumber}`).join('|');
  useEffect(() => {
    setAlignedSector(null);
  }, [carsKey]);
  // そろえるのは時間基準で比べるときだけ。距離基準に戻したら解除する (距離基準のタイム差がずれるため)
  useEffect(() => {
    if (compareAxis !== 'time') setAlignedSector(null);
  }, [compareAxis]);

  // 1 周の長さを基準車にそろえる (ロガーごとの距離の測り方の差を吸収する)
  const [alignLapLength, setAlignLapLength] = useState(false);

  // セクターにそろえるときの、比較車両の時刻のずらし量 (秒)。そろえていなければ 0、線を通過していなければ undefined
  const alignGate = alignedSector !== null ? currentSectors[alignedSector] : undefined;
  // 通過の向きは、基準車のセッション全体で決める (1 周だけだと、スピンなどの逆向きの通過しかない周で向きを取り違えるため)
  const alignDirection = useMemo(
    () => (alignGate && baseSession ? gateDirection(baseSession.points, alignGate) : undefined),
    [alignGate, baseSession]
  );
  const baseAlignTime = alignGate && baseLap ? firstGateCrossingTime(baseLap.points, alignGate, alignDirection) : undefined;
  const alignShiftOf = (lap: Lap): number | undefined => {
    if (!alignGate) return 0;
    const t = firstGateCrossingTime(lap.points, alignGate, alignDirection);
    return t !== undefined && baseAlignTime !== undefined ? t - baseAlignTime : undefined;
  };

  // G のならし方。変えたら、読み込み済みのログの G を計算し直す (周回の区切りは変わらないが、周の点も作り直す)
  const [gFilterLevel, setGFilterLevelState] = useState<GFilterLevel>(getGFilterLevel());
  const handleChangeGFilterLevel = (level: GFilterLevel) => {
    if (level === gFilterLevel) return;
    setGFilterLevel(level);
    setGFilterLevelState(level);
    const updated = new Map(latestRef.current.sessions.map(s => {
      const points = applyGFilter(s.points.map(p => ({ ...p })), level);
      const { laps, bestLapIndex, theoreticalBestTime } = extractLaps(points, s.controlLine, s.sectors);
      return [s.id, { points, laps, bestLapIndex, theoreticalBestTime }] as const;
    }));
    setSessions(prev => prev.map(s => (updated.has(s.id) ? { ...s, ...updated.get(s.id)! } : s)));
  };

  // 有効な選択中車両一覧。比較車両には、距離の手動補正と 1 周の長さの伸縮をここで適用する
  const activeCars = useMemo(() => [...selectedCars]
    .sort((a, b) => a.slot - b.slot)
    .map(slot => {
      const session = sessions.find(s => s.id === slot.sessionId);
      const lap = session?.laps.find(l => l.lapNumber === slot.lapNumber);
      if (!lap) return null;
      // 基準車には補正をかけない
      if (slot.slot === baseSelected?.slot) return { slot, lap };
      // 伸縮は、基準車と比較車両がどちらも計測線から計測線までの 1 周のときだけ行う
      const isFullLap = (l: Lap) => !l.isWholeSession && !l.isPartialLap && l.distance > 0;
      const scale = alignLapLength && baseLap && isFullLap(baseLap) && isFullLap(lap) ? baseLap.distance / lap.distance : 1;
      const offsetKm = (slot.distanceOffsetM || 0) / 1000;
      // 距離を補正したときは、補正後の 0 m (計測線) を通った時刻を 0 秒にする (タイム差・時間基準の比較が補正後の計測線から始まるように)
      const zeroTime = offsetKm !== 0 ? timeAtDistanceZero(lap.points, scale, offsetKm) : 0;
      // セクターにそろえるときは、そのセクター線を通った時刻が基準車と同じになるよう時刻をずらす。
      // 線は基準車のセッションのもの (表示中のセクター) を使い、各車の軌跡が通った時刻を直接求める
      // (比較車両のセッションに同じセクターがない・数が違う場合でもそろえられるように)
      // (そろえていない・そろえられないときは、距離の補正に合わせた時刻のずらし量を使う)
      const alignShift = alignGate ? alignShiftOf(lap) : undefined;
      const shiftSec = alignShift ?? zeroTime;
      if (scale === 1 && offsetKm === 0 && shiftSec === 0) return { slot, lap };
      return {
        slot,
        lap: {
          ...lap,
          distance: lap.distance * scale,
          points: lap.points.map(p => ({ ...p, distance: p.distance * scale + offsetKm, time: p.time - shiftSec }))
        }
      };
    })
    .filter(Boolean) as { slot: SelectedCarSlot; lap: Lap }[], [selectedCars, sessions, baseSelected?.slot, baseLap, alignLapLength, alignGate, alignDirection, baseAlignTime]);

  // そろえていて、時刻をずらせなかった比較車両の数 (セクター線を通過していない周など)。表示に出す
  // 基準車がその線を通っていなければ、どの車もそろえられない (表示を分ける)
  const alignBaseMissing = alignGate !== undefined && baseAlignTime === undefined;
  const alignFailedCount = alignedSector === null || alignBaseMissing ? 0 : [...selectedCars]
    .filter(c => c.slot !== baseSelected?.slot)
    .map(c => findLap(c))
    .filter(l => l && alignShiftOf(l) === undefined).length;

  // 再生・コマ送りの終わりの時刻。時間基準では、比較車両 (遅い車・時刻をずらした車) が走り終わるまで
  const playEndTime = !baseLap ? 0 : compareAxis === 'time'
    ? Math.max(baseLap.lapTime, ...activeCars.map(c => c.lap.points[c.lap.points.length - 1]?.time ?? 0))
    : baseLap.lapTime;

  const handleSetDistanceOffset = (slotIndex: number, offsetM: number) => {
    setSelectedCars(prev => prev.map(c => (c.slot === slotIndex ? { ...c, distanceOffsetM: offsetM } : c)));
  };

  // アニメーションループ (requestAnimationFrame)
  const animRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(performance.now());

  // 再生の基準はこのループだけにする。動画のウインドウは、この時刻に合わせて動画を再生する (動画の有無にかかわらず時刻が進む)
  // 時刻の基準: グラフ画面では選んでいる周の中の時刻 ('lap')、動画同期タブではセッション全体の時刻 ('session')。
  // データ管理などほかのタブでは直前の基準のままにする (行って戻っても再生位置が変わらないように)
  // 動画同期タブでは、ログがなくても (動画だけでも) 再生できるよう、表示している動画の終わりまで進める
  const isVideoTab = !isCompact && currentTab === 'video';
  const videoTracks = useVideoTracks();
  const videoView = useVideoView();
  const shownVideoIds = [videoView.selectedTrackId, videoView.viewMode !== 'single' ? videoView.subTrackId : null];
  const sessionEndTime = Math.max(
    baseSession?.points.length ? baseSession.points[baseSession.points.length - 1].time : 0,
    ...videoTracks.filter(t => shownVideoIds.includes(t.id)).map(videoEndSessionSec)
  );
  const [clockBase, setClockBase] = useState<'lap' | 'session'>(() => (isVideoTab ? 'session' : 'lap'));
  const wantClockBase: 'lap' | 'session' = isVideoTab ? 'session' : currentTab === 'graph' ? 'lap' : clockBase;
  if (wantClockBase !== clockBase) {
    // 基準が変わったら、時刻と距離を読み替える。描画の途中で直し、ウインドウが古い基準の時刻を受け取らないようにする
    setClockBase(wantClockBase);
    const lapStart = baseLap?.startTime ?? 0;
    // 周の外のセッション時刻からグラフ画面に戻ったときは、周の始め・終わりに寄せる
    const next = wantClockBase === 'session' ? currentTimeSec + lapStart : Math.max(0, Math.min(playEndTime, currentTimeSec - lapStart));
    setCurrentTimeSec(next);
    const pts = wantClockBase === 'session' ? baseSession?.points : baseLap?.points;
    if (pts && pts.length > 0) {
      const curPt = interpolatePoint(pts, 'time', next);
      if (curPt) setCurrentDistanceKm(curPt.distance);
    }
  }
  const isSessionClock = wantClockBase === 'session';

  // セッション全体の時刻で、終わりまで再生したあとに再生を押したら、始めから再生する
  useEffect(() => {
    if (isPlaying && isSessionClock) setCurrentTimeSec(t => (t >= sessionEndTime - 1e-3 ? 0 : t));
  }, [isPlaying]);

  useEffect(() => {
    const pts = isSessionClock ? baseSession?.points : baseLap?.points;
    const endTime = isSessionClock ? sessionEndTime : playEndTime;
    if (!isPlaying || (!isSessionClock && (!pts || pts.length === 0)) || !(endTime > 0)) {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      return;
    }

    lastTimeRef.current = performance.now();

    const loop = (now: number) => {
      // requestAnimationFrame の時刻はフレームの開始時刻なので、再生開始時に記録した時刻より前のことがある (負にしない)
      const dtSec = Math.max(0, ((now - lastTimeRef.current) / 1000) * playbackSpeed);
      lastTimeRef.current = now;

      setCurrentTimeSec(prevTime => {
        let nextTime = prevTime + dtSec;
        if (nextTime > endTime) {
          if (isSessionClock) {
            // セッション全体の時刻では、終わりで止める
            nextTime = endTime;
            setIsPlaying(false);
          } else {
            nextTime = 0; // ループ
            // 周の始めに戻ったら、セクターにそろえるのをやめ、全車を計測線から同時に走らせる
            setAlignedSector(null);
          }
        }

        // タイムに対応する距離を計算 (O(log N) 二分探索)
        const curPt = pts && pts.length > 0 ? interpolatePoint(pts, 'time', nextTime) : null;

        if (curPt) {
          setCurrentDistanceKm(curPt.distance);
        }

        return nextTime;
      });

      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [isPlaying, playbackSpeed, baseLap, baseSession, playEndTime, sessionEndTime, isSessionClock]);

  // キーボードショートカット (Space: 再生/停止, F / →: コマ送り, B / ←: コマ戻し, Shift で 1 秒単位)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 入力フォーム操作中は無視
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const step = e.shiftKey ? 1 : 0.1;
      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying(p => !p);
      } else if (e.code === 'KeyF' || e.code === 'ArrowRight') {
        e.preventDefault();
        handleStep(step);
      } else if (e.code === 'KeyB' || e.code === 'ArrowLeft') {
        e.preventDefault();
        handleStep(-step);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [baseLap, baseSession, isSessionClock, playEndTime, sessionEndTime]);

  // Electron ネイティブメニューからのファイルオープン受信
  useEffect(() => {
    const nav = window as any;
    const unsubscribers: Array<() => void> = [];
    if (nav.electronAPI?.onOpenFiles && nav.electronAPI?.readFileBuffer) {
      const off = nav.electronAPI.onOpenFiles(async (filePaths: string[]) => {
        for (const fp of filePaths) {
          if (/\.(mp4|mov)$/i.test(fp)) {
            alert(tr('GoPro の動画は、画面の「ファイル読込」から開いてください', 'Open GoPro videos with "Open file" in the app window'));
            continue;
          }
          try {
            const res = await nav.electronAPI.readFileBuffer(fp);
            if (res.success) {
              const buffer = new Uint8Array(res.dataArray).buffer;
              // 最新のコース設定で読み込む (登録時点の関数を使い続けない)
              await loadFileDataRef.current(res.name, buffer);
            } else {
              alert(`${tr('ファイルの読み込みに失敗しました', 'Could not load the file')}: ${res.error}`);
            }
          } catch (err: any) {
            console.error('Electron file open error:', err);
            alert(`${tr('ファイルの読み込みに失敗しました', 'Could not load the file')}: ${err?.message || err}`);
          }
        }
      });
      if (typeof off === 'function') unsubscribers.push(off);
    }

    if (nav.electronAPI?.onOpenDonateModal) {
      const off = nav.electronAPI.onOpenDonateModal(() => {
        setIsDonateModalOpen(true);
      });
      if (typeof off === 'function') unsubscribers.push(off);
    }
    return () => unsubscribers.forEach(off => off());
  }, []);

  const handleStep = (stepSec: number) => {
    // 動画同期タブでは、ログがなくても (動画だけでも) コマ送りできる
    if (isSessionClock ? !(sessionEndTime > 0) : !baseLap) return;
    setIsPlaying(false);
    setCurrentTimeSec(prev => {
      // 動画タブではセッション全体の時間 (動画の終わりまで)、それ以外では選択中ラップの時間が上限
      const maxLimit = isSessionClock ? sessionEndTime : playEndTime;
      const next = Math.max(0, Math.min(maxLimit, prev + stepSec));
      const pts = (isSessionClock ? baseSession?.points : baseLap?.points) || baseSession?.points;
      if (pts && pts.length > 0) {
        const curPt = interpolatePoint(pts, 'time', next);
        if (curPt) setCurrentDistanceKm(curPt.distance);
      }
      return next;
    });
  };

  // シーク操作 (動画タブ時はセッション全体のタイムラインを参照)
  const handleSeekTime = (timeSec: number) => {
    setCurrentTimeSec(timeSec);
    const pts = (isSessionClock ? baseSession?.points : baseLap?.points) || baseSession?.points;
    if (pts && pts.length > 0) {
      const curPt = interpolatePoint(pts, 'time', timeSec);
      if (curPt) setCurrentDistanceKm(curPt.distance);
    }
  };

  const handleSeekDistance = (distKm: number) => {
    if (!baseLap) return;
    setCurrentDistanceKm(distKm);
    const pts = baseLap.points;
    const curPt = interpolatePoint(pts, 'distance', distKm);
    if (curPt) setCurrentTimeSec(curPt.time);
  };

  // セクター同時スタート
  const handleSyncSectorStart = (sectorIndex: number) => {
    if (!baseLap) return;
    // セクター線 k は「セクター k の終わり」。セクター k の始まりは 1 つ前の線 (S1 は計測線 = 周の始め)
    const startLine = sectorIndex > 0 ? baseLap.sectors[sectorIndex - 1] : undefined;
    if (sectorIndex > 0 && !startLine) return;
    // 全車をそろえるモードでは、全車がセクターの始まりの線を同時に通るよう時刻をそろえ、時間基準で比べる
    // (S1 は計測線から始まるので、もともと全車がそろっている)
    if (sectorStartMode === 'all') {
      setAlignedSector(sectorIndex > 0 ? sectorIndex - 1 : null);
      setCompareAxis('time');
    } else {
      setAlignedSector(null);
    }
    // セクターの始まりの位置 (計測線からの累積距離) から一斉スタートする
    handleSeekDistance(startLine ? startLine.splitDistance : 0);
    setIsPlaying(true);
  };

  // ファイル読み込み処理
  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // 読み込みの間に選び直せるよう、先に一覧を写してから入力を空にする
    const list = Array.from(files);
    e.target.value = '';
    await loadFiles(list);
  };

  // GoPro の動画 (.mp4 / .mov) は数 GB あるので、全体を読み込まず、GPS の記録だけを読む
  const isVideoFileName = (name: string) => /\.(mp4|mov)$/i.test(name);

  // 選んだファイルを読み込む。動画は 1 回の撮影ごと (チャプターをまとめて) に 1 つのログにする。失敗したファイルは知らせて続ける
  const loadFiles = async (files: File[]) => {
    const groups = new Map<string, File[]>();
    for (const file of files) {
      if (!isVideoFileName(file.name)) {
        try {
          await loadFileData(file.name, await file.arrayBuffer());
        } catch (err: any) {
          alert(tr(`ファイル ${file.name} の読み込みに失敗しました: ${err.message}`, `Could not load ${file.name}: ${err.message}`));
        }
        continue;
      }
      const rec = goproRecording(file.name);
      const key = rec ? `rec:${rec.id}` : `file:${file.name}`;
      groups.set(key, [...(groups.get(key) ?? []), file]);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => (goproRecording(a.name)?.chapter ?? 0) - (goproRecording(b.name)?.chapter ?? 0));
      try {
        await loadGoproVideos(group);
      } catch (err: any) {
        alert(tr(`ファイル ${group.map(f => f.name).join('・')} の読み込みに失敗しました: ${err.message}`, `Could not load ${group.map(f => f.name).join(', ')}: ${err.message}`));
      }
    }
  };

  // GoPro の動画 (1 回の撮影のチャプター、順に並べたもの) の GPS を走行ログとして読み込み、同じ動画を動画同期にも登録する。
  // GPS と映像は同じ時計なので、撮影時刻からの照合でなく、GPS の時刻から求めたずれで合わせる
  const loadGoproVideos = async (files: File[]) => {
    let log;
    try {
      log = await parseGoproGps(files.map(blobByteSource));
    } catch (err) {
      // GPS の記録がない動画 (GoPro 以外の動画など) は、走行ログにはせず、動画同期に登録するだけにする (撮影時刻で照合)
      if (!(err instanceof NoGoproGpsError)) throw err;
      const existing = videoSyncManager.getTracks();
      const toAdd = files.filter(f => !existing.some(t => t.objectUrl && t.fileName === f.name && t.fileSize === f.size));
      if (toAdd.length > 0) await videoSyncManager.addVideoFiles(toAdd, latestRef.current.sessions);
      return;
    }
    const session = (await loadFileData(files[0].name, null, log))[0];
    if (!session?.points[0]?.timestamp) return;
    const t0 = Date.parse(session.points[0].timestamp);

    // 動画同期に登録済みの同じ動画は、もう一度は登録しない (同期を二重にしない)。
    // 同じ撮影のチャプターが一部だけ登録済みのときも登録しない (登録済みのチャプターの同期と食い違うため)
    const existing = videoSyncManager.getTracks();
    const toAdd = files.filter(f => !existing.some(t => t.objectUrl && t.fileName === f.name && t.fileSize === f.size));
    if (toAdd.length < files.length) return;
    const before = new Set(existing.map(t => t.id));
    const tracks = await videoSyncManager.addVideoFiles(toAdd, [...latestRef.current.sessions.filter(s => s.id !== session.id), session]);
    // 新しく加わった動画だけを合わせる (同期プロジェクトから戻した動画は、保存した同期のまま)
    const added = files
      .map((f, i) => ({ track: tracks.find(t => !before.has(t.id) && t.file === f), startMs: log.videoStartUtcMs[i] }))
      .filter((a): a is { track: NonNullable<typeof a.track>; startMs: number } => !!a.track);
    if (added.length === 0) return;
    for (const a of added) videoSyncManager.setMatchedSession(a.track.id, session.id);
    // チャプターのずれは動画の長さでそろうので、測位できた最初の動画で合わせる
    const first = added.find(a => Number.isFinite(a.startMs));
    if (first) videoSyncManager.updateOffset(first.track.id, (first.startMs - t0) / 1000);
  };

  // データファイル読み込みロジック。読み込んだログはセッションとして加え、加えたセッションを返す
  // (parsedLog を渡したときは、ファイルを読まずにその点列を使う)
  const loadFileData = async (
    fileName: string,
    buffer: ArrayBuffer | null,
    parsedLog?: { points: any[]; samplingRate: number; startDate?: Date }
  ): Promise<Session[]> => {
    let rawPoints: any[] = [];
    let samplingRate = 10;
    let startDate: Date | undefined;
    // 1 つのファイルに走行が複数入っているとき (生ログ) は、走行ごとに別のセッションにする
    let parts: { points: any[]; samplingRate: number; startDate?: Date }[] | null = null;
    // ログに記録されている車両名・ドライバー名・コース名 (iRacing の .ibt)
    let meta: { vehicleName?: string; driverName?: string; trackName?: string } = {};

    const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : '';
    const added: Session[] = [];

    if (parsedLog) {
      rawPoints = parsedLog.points;
      samplingRate = parsedLog.samplingRate;
      startDate = parsedLog.startDate;
    } else if (!buffer) {
      throw new Error(tr('ファイルの中身がありません', 'The file is empty'));
    } else if (ext === 'dtb') {
      const parsed = parseDtb(buffer);
      rawPoints = parsed.points;
      samplingRate = parsed.samplingRate;
      startDate = parsed.startDate;
    } else if (ext === 'bnx4' || ext === 'bon4' || ext === 'binx' || ext === 'bon') {
      parts = parseDigispiceRawBinary(fileName, buffer);
    } else if (ext === 'xrk' || ext === 'xrz') {
      // AiM のロガーのファイル (.xrz は圧縮したもの)
      const bytes = await inflateXrz(new Uint8Array(buffer));
      if (!isXrk(bytes)) throw new Error(tr('AiM の .xrk / .xrz として読めませんでした', 'Could not read this as an AiM .xrk / .xrz file'));
      const parsed = parseXrk(bytes);
      rawPoints = parsed.points;
      samplingRate = parsed.samplingRate;
      startDate = parsed.startDate;
    } else if (ext === 'fit') {
      // Garmin などの FIT (腕時計・サイクルコンピューターの記録)
      const parsed = parseFit(new Uint8Array(buffer));
      rawPoints = parsed.points;
      samplingRate = parsed.samplingRate;
      startDate = parsed.startDate;
    } else if (ext === 'ibt') {
      // iRacing のテレメトリ。コースに出ていた間ごとに分ける (ピットへの移動などで区切る)
      const bytes = new Uint8Array(buffer);
      if (!isIbt(bytes)) throw new Error(tr('iRacing の .ibt として読めませんでした', 'Could not read this as an iRacing .ibt file'));
      const parsed = parseIbt(bytes);
      parts = parsed.parts;
      meta = { vehicleName: parsed.vehicleName, driverName: parsed.driverName, trackName: parsed.trackName };
    } else if (['vbo', 'csv', 'txt', 'gpx', 'tcx', 'nmea', 'log'].includes(ext || '')) {
      // テキストの形式は拡張子で決めつけず、中身の先頭で判別する (.txt の NMEA・VBO、.log の CSV なども読めるように)。
      // 判別できないときは拡張子に従う
      const text = new TextDecoder('utf-8').decode(buffer);
      // NMEA は受信機の起動時の文などの後から始まることがあるので、先頭から広めに (64 KB) 探す
      const head = text.slice(0, 65536);
      // CSV の見出し行 (緯度・経度の列がある行) があるか
      const csvLike = isRaceChronoCsv(text) || isMotecCsv(text) || isAimCsv(text) ||
        /^(?=[^\n]*(lat|緯度))(?=[^\n]*(lon|lng|経度))[^\n]*,/im.test(text.slice(0, 4000));
      const kind =
        isGpx(text) ? 'gpx'
        : isTcx(text) ? 'tcx'
        : isVbo(text) ? 'vbo'
        : /^\s*\$G[PNLAB][A-Z]{3},/m.test(head) ? 'nmea'
        : csvLike ? 'csv'
        : ext === 'vbo' || ext === 'gpx' || ext === 'tcx' || ext === 'nmea' ? ext
        : ext === 'log' ? 'nmea'
        : 'csv';
      let parsed: { points: any[]; samplingRate: number; startDate?: Date };
      if (kind === 'gpx') parsed = parseGpx(text);
      else if (kind === 'tcx') parsed = parseTcx(text);
      else if (kind === 'vbo') parsed = parseVbo(text);
      else if (kind === 'nmea') parsed = parseNmea(text);
      else {
        // 他社形式の CSV は先頭の書式で判別する
        // MoTeC CSV は単位行などの構造が汎用 CSV と違うため、無効の間は汎用の読み込みに回さず断る
        if (isMotecCsv(text) && !MOTEC_CSV_ENABLED) {
          throw new Error(tr('MoTeC CSV の読み込みには現在対応していません', 'Loading MoTeC CSV is not supported at the moment'));
        }
        parsed = isRaceChronoCsv(text) ? parseRaceChronoCsv(text)
          : isAimCsv(text) ? parseAimCsv(text)
          : isMotecCsv(text) ? parseMotecCsv(text)
          : parseCsv(text);
      }
      rawPoints = parsed.points;
      samplingRate = parsed.samplingRate;
      startDate = parsed.startDate;
    } else {
      throw new Error(`${tr('未対応のファイル形式です', 'Unsupported file type')}: ${ext ? `.${ext}` : tr('(拡張子なし)', '(no extension)')}`);
    }

    if (!parts) parts = [{ points: rawPoints, samplingRate, startDate }];
    // 位置として正しい点が 2 点に満たない走行は捨てる (違う中身のファイルを生ログなどとして読むと、でたらめな 1 点ができることがあるため)
    const validPos = (p: any) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180 && !(p.latitude === 0 && p.longitude === 0);
    parts = parts.filter(p => p.points.filter(validPos).length >= 2);
    if (parts.length === 0 || parts.every(p => p.points.length === 0)) {
      throw new Error(tr('有効なGPS位置データが見つかりませんでした', 'No valid GPS position data was found'));
    }

    const baseName = fileName.replace(/\.[^/.]+$/, '');
    for (const [partIndex, part] of parts.entries()) {
      if (part.points.length === 0) continue;
      await addParsedSession(part.points, part.samplingRate, part.startDate, parts.length > 1 ? `${baseName}_${partIndex + 1}` : baseName);
    }

    // 読み込んだ点列から周回を計算し、セッションとして加える
    async function addParsedSession(rawPoints: any[], samplingRate: number, startDate: Date | undefined, sessionName: string) {
      // サーキット自動判定
      // 保存済みのユーザーコースの読み込みが終わってから判定する (起動直後に開いたファイルでも使えるように)
      await userCircuitStorage.ready;
      let matchedCircuit = findMatchingCircuit(rawPoints[0].latitude, rawPoints[0].longitude, rawPoints);
      // 同じ場所のコースの手がかり: 読み込み済みのセッションのうち、計測線がこのログの近くにあるもの (基準車を優先)。
      // なければ直前に決まったコース (一度に複数のファイルを読み込むときは、まだセッション一覧に入っていないため)
      const prev = courseRef.current;
      const loaded = latestRef.current.sessions;
      const samePlace = [...(courseSession ? [courseSession] : []), ...loaded]
        .find(s => s.controlLine && passesNearControlLine(rawPoints, s.controlLine));
      const hint: CourseHint = samePlace
        ? { cl: samePlace.controlLine, sec: samePlace.sectors, name: samePlace.circuitName, polylines: samePlace.pathPolylines, polylinesSource: samePlace.pathPolylinesSource }
        : prev;
      let cl = hint.cl;
      let sec = hint.sec;
      let circName = hint.name;

      // 手がかりが判定したコースと同じコース (コース編集で計測線・セクターを直したものなど) なら、その設定を引き継ぐ
      const sameCourse = !!matchedCircuit && hint.name === matchedCircuit.name && !!hint.cl && passesNearControlLine(rawPoints, hint.cl);
      if (matchedCircuit && !sameCourse) {
        // 計測線を持たないコース (名阪など) では、同じ場所で先に決めた計測線 (仮の計測線・コース編集で置いた線) を引き継ぐ
        cl = matchedCircuit.controlLine ?? (hint.cl && passesNearControlLine(rawPoints, hint.cl) ? hint.cl : undefined);
        sec = matchedCircuit.sectors;
        circName = matchedCircuit.name;
      }

      // コースを判定できず、手がかりの計測線がこのログの近くにない (または計測線がない) ときは、その計測線・セクター・コース名は使わない
      if (!matchedCircuit && !(cl && passesNearControlLine(rawPoints, cl))) {
        cl = undefined;
        sec = [];
        circName = '';
      }

      // 手がかりのコース図 (先に読み込んだ .pth など) がこのログの近くにあれば、このセッションに付ける
      // 別のコースと判定した手がかり (同じ施設の隣のコースなど) のコース図は使わない (コース名のない、先に読み込んだ .pth は使う)
      const hintForThisCourse = !matchedCircuit || !hint.name || hint.name === matchedCircuit.name;
      const hintPolylines = hintForThisCourse && hint.polylines && passesNearPolylines({ points: rawPoints } as Session, hint.polylines, 2000) ? hint.polylines : undefined;

      // コースが分からず計測線もないときは、このログの走り始めに仮の計測線を置く。
      // 後から読み込むログもこの線の通過点を 0 m にそろえるので、開始位置の違うログを重ねてもずれない
      if (!cl) cl = createVirtualControlLine(rawPoints);
      // 出どころの分からない手がかりのコース図は、手で読み込んだものとして扱う (一括設置で置き換えないように)
      const hintSource: PolylineSource | undefined = hintPolylines ? (hint.polylinesSource ?? 'manual') : undefined;
      courseRef.current = { cl, sec, name: circName, polylines: hintPolylines, polylinesSource: hintSource };

      // ラップ分割とセクタータイム計算
      const { laps, bestLapIndex, theoreticalBestTime, sectors: lapSectors } = extractLaps(rawPoints, cl, sec);

      const newSession: Session = {
        id: `sess_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        fileName,
        sessionName,
        date: startDate ? startDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        // コースを判定できないときは、ログに記録されたコース名を使う
        circuitName: circName || meta.trackName || '',
        ...(meta.vehicleName ? { vehicleName: meta.vehicleName } : {}),
        ...(meta.driverName ? { driverName: meta.driverName } : {}),
        samplingRate,
        totalDistance: rawPoints[rawPoints.length - 1].distance,
        points: rawPoints,
        laps,
        bestLapIndex,
        theoreticalBestTime,
        controlLine: cl,
        // 走る向きに並べ直したセクター (並びが逆だったとき)
        sectors: lapSectors,
        ...(hintPolylines ? { pathPolylines: hintPolylines, pathPolylinesSource: hintSource } : {})
      };

      setSessions(prev => [...prev, newSession]);
      added.push(newSession);
      // コース図の自動読込 (ユーザー設置 → OpenStreetMap)。このセッションにだけ設定する。手で読み込んだコース図を付けたときは取りに行かない
      if (matchedCircuit && !hintPolylines) requestPolylines([newSession.id], matchedCircuit);

      // 最初のセッションであれば Car 1 (基準車: 赤) に自動割り当て
      setSelectedCars(prev => {
        const bestLapNum = laps[bestLapIndex]?.lapNumber || 1;
        if (prev.length === 0) {
          return [
            {
              slot: 0,
              sessionId: newSession.id,
              lapNumber: bestLapNum,
              colorHex: '#ef4444',
              label: `${newSession.sessionName} (L${bestLapNum})`
            }
          ];
        } else if (prev.length === 1 && prev[0].slot === 0) {
          // 2台目を Car 2 (青) に自動割り当て
          return [
            ...prev,
            {
              slot: 1,
              sessionId: newSession.id,
              lapNumber: bestLapNum,
              colorHex: '#3b82f6',
              label: `${newSession.sessionName} (L${bestLapNum})`
            }
          ];
        }
        return prev;
      });
    }

    // 変換ページから読み込んだときは、そのまま変換ページに留まる
    if (currentTabRef.current !== 'convert') setCurrentTab('graph');
    return added;
  };

  const loadFileDataRef = useRef(loadFileData);
  loadFileDataRef.current = loadFileData;

  // 計測線・セクターを差し替えて、読み込み済みの全セッションの周回を計算し直す。
  // 周回数が変わって選択中の周が無くなった車両は、そのセッションのベストラップへ移す (画面から消えないように)
  // resolve が null を返したセッションは変えない (同じ場所のログだけにコースの変更を反映するため)
  const recalcSessions = (
    resolve: (s: Session) => { cl?: ControlLine; sec: Sector[]; name?: string } | null
  ) => {
    const updated = latestRef.current.sessions.map(s => {
      const r = resolve(s);
      if (!r) return s;
      const { cl, sec, name } = r;
      const { laps, bestLapIndex, theoreticalBestTime, sectors: lapSectors } = extractLaps(s.points, cl, sec);
      return {
        ...s, laps, bestLapIndex, theoreticalBestTime, controlLine: cl, sectors: lapSectors,
        ...(name !== undefined ? { circuitName: name } : {})
      };
    });
    const byId = new Map(updated.map(s => [s.id, s]));
    // コース図は非同期に届くので、その間に設定されたものを消さないよう、今の値を引き継ぐ
    setSessions(prev => prev.map(p => {
      const u = byId.get(p.id);
      return u ? { ...u, pathPolylines: p.pathPolylines, pathPolylinesSource: p.pathPolylinesSource } : p;
    }));
    setSelectedCars(prev =>
      prev.map(c => {
        const s = updated.find(x => x.id === c.sessionId);
        if (!s || s.laps.some(l => l.lapNumber === c.lapNumber)) return c;
        const lapNumber = s.laps[s.bestLapIndex]?.lapNumber ?? s.laps[0]?.lapNumber ?? 1;
        return { ...c, lapNumber, label: `${s.sessionName} (L${lapNumber})` };
      })
    );
  };

  // サーキットプリセット選択
  const handleSelectCircuitPreset = (presetId: string) => {
    const p = CIRCUIT_PRESETS.find(c => c.id === presetId);
    if (!p) return;
    // そのコースの近く (15 km 以内) のログだけに反映する。近くのログがなければ、基準車のセッションに反映する (利用者の指定を優先)
    const ids = targetSessionIds(s => passesNearPoint(s.points, p.centerLat, p.centerLon, COURSE_MATCH_RADIUS_M));
    // 計測線を持たないプリセット (名阪) では、各セッションの計測線 (仮の計測線・コース編集で置いた線) を残す
    const keepLine = (s?: Session) => p.controlLine ?? s?.controlLine;
    const first = latestRef.current.sessions.find(s => s.id === ids[0]);
    setCourseHint({ cl: keepLine(first), sec: p.sectors, name: p.name });
    recalcSessions(s => (ids.includes(s.id) ? { cl: keepLine(s), sec: p.sectors, name: p.name } : null));
    // 前のコースのコース図を消し、選んだコースのコース図を読み込む
    setSessionPolylines(ids, undefined);
    requestPolylines(ids, p);
    // ログを読み込む前なら、画面と次に読み込むログのために、選んだコースのコース図を手がかりに入れる
    if (ids.length === 0) {
      resolveCircuitPolylines(p).then(polylines => {
        if (polylines && polylines.length > 0 && courseRef.current.name === p.name && !courseRef.current.polylines) {
          setCourseHint({ ...courseRef.current, polylines, polylinesSource: 'auto' });
        }
      }).catch(console.warn);
    }
  };

  // ---- コースの設定をセッションごとに反映するための補助 ----

  // 条件に合うセッションの id。1 つもなければ基準車のセッション (なければ最初のセッション)
  const targetSessionIds = (pred: (s: Session) => boolean): string[] => {
    const { sessions: list, courseSessionId } = latestRef.current;
    const ids = list.filter(pred).map(s => s.id);
    if (ids.length > 0) return ids;
    return courseSessionId ? [courseSessionId] : [];
  };

  // ログがコース図の近く (maxMeters 以内) を走ったか。コース図の頂点と軌跡を間引いて比べる (コース図の端の 1 点だけでは、長いコースで外れるため)
  const passesNearPolylines = (s: Session, polylines: Array<Array<[number, number]>>, maxMeters: number): boolean => {
    const vertices = polylines.flat();
    const vStep = Math.max(1, Math.floor(vertices.length / 200));
    const pStep = Math.max(1, Math.floor(s.points.length / 500));
    const pts = s.points.filter((_, i) => i % pStep === 0);
    for (let i = 0; i < vertices.length; i += vStep) {
      const [lon, lat] = vertices[i]; // コース図の点は [経度, 緯度] の順
      if (passesNearPoint(pts, lat, lon, maxMeters)) return true;
    }
    return false;
  };

  // セッションのコース図を設定する。受付番号を進めるので、取得中の古いコース図は後から届いても使わない
  const setSessionPolylines = (ids: string[], polylines: Array<Array<[number, number]>> | undefined, source?: PolylineSource) => {
    for (const id of ids) polylineRequestRef.current.set(id, (polylineRequestRef.current.get(id) ?? 0) + 1);
    setSessions(prev => prev.map(s => (ids.includes(s.id) ? { ...s, pathPolylines: polylines, pathPolylinesSource: polylines ? source : undefined } : s)));
  };

  // コースのコース図を取得して、指定のセッションに設定する (取得の間に別のコース図を設定したセッションには使わない)
  const requestPolylines = (ids: string[], circuit: CircuitPreset) => {
    const tokens = new Map(ids.map(id => {
      const t = (polylineRequestRef.current.get(id) ?? 0) + 1;
      polylineRequestRef.current.set(id, t);
      return [id, t] as const;
    }));
    resolveCircuitPolylines(circuit).then(polylines => {
      if (!polylines || polylines.length === 0) return;
      setSessions(prev => prev.map(s =>
        tokens.has(s.id) && polylineRequestRef.current.get(s.id) === tokens.get(s.id) ? { ...s, pathPolylines: polylines, pathPolylinesSource: 'auto' } : s
      ));
    }).catch(console.warn);
  };

  // スロット選択
  const handleSelectCarSlot = (slotIndex: number, sessionId: string, lapNumber: number) => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    const colors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b'];
    const updated = selectedCars.filter(c => c.slot !== slotIndex);
    updated.push({
      slot: slotIndex,
      sessionId,
      lapNumber,
      colorHex: colors[slotIndex],
      label: `${session.sessionName} (L${lapNumber})`
    });

    updated.sort((a, b) => a.slot - b.slot);
    setSelectedCars(updated);
  };

  // グラフ解析タブのウインドウ (パソコン向けの分割表示とスマートフォン向けの切り替え表示の両方で使う)
  const speedGraphEl = (
    <SpeedGraphWindow
      cars={activeCars}
      sectors={currentSectors}
      currentTime={currentTimeSec}
      currentDistance={currentDistanceKm}
      onSeekTime={handleSeekTime}
      onSeekDistance={handleSeekDistance}
      xAxisMode={compareAxis}
      onChangeXAxisMode={setCompareAxis}
      alignStartTime={baseAlignTime}
    />
  );
  const replayEl = (
    <ReplayWindow
      cars={activeCars}
      sectors={currentSectors}
      currentTime={currentTimeSec}
      currentDistance={currentDistanceKm}
      compareAxis={compareAxis}
      isPlaying={isPlaying}
      onTogglePlay={() => setIsPlaying(!isPlaying)}
      onStepForward={() => handleStep(0.1)}
      onStepBack={() => handleStep(-0.1)}
      onSeekDistance={handleSeekDistance}
      onSyncSectorStart={handleSyncSectorStart}
      sectorStartMode={sectorStartMode}
      onChangeSectorStartMode={mode => {
        setSectorStartMode(mode);
        if (mode === 'base') setAlignedSector(null);
      }}
      alignedSectorName={alignedSector !== null ? `S${alignedSector + 2}` : undefined}
      alignFailedCount={alignFailedCount}
      alignBaseMissing={alignBaseMissing}
      onClearAlignedSector={() => setAlignedSector(null)}
    />
  );
  const trackMapEl = (
    <TrackMapWindow
      cars={activeCars}
      controlLine={currentControlLine}
      sectors={currentSectors}
      pathPolylines={currentPthPolylines}
      currentDistance={currentDistanceKm}
      currentTime={currentTimeSec}
      compareAxis={compareAxis}
      onSeekDistance={handleSeekDistance}
    />
  );
  const frictionEl = (
    <FrictionCircleWindow
      cars={activeCars}
      currentDistance={currentDistanceKm}
      currentTime={currentTimeSec}
      compareAxis={compareAxis}
      smoothStrong={gFilterLevel === 'strong'}
      onToggleSmooth={() => handleChangeGFilterLevel(gFilterLevel === 'strong' ? 'standard' : 'strong')}
    />
  );
  const driftEl = (
    <DriftWindow cars={activeCars} currentDistance={currentDistanceKm} />
  );
  const cornerEl = (
    <CornerAnalysisWindow cars={activeCars} currentDistance={currentDistanceKm} onSeekDistance={handleSeekDistance} />
  );
  const brakingEl = (
    <BrakingAnalysisWindow cars={activeCars} currentDistance={currentDistanceKm} onSeekDistance={handleSeekDistance} />
  );

  return (
    <div className="flex flex-col h-dvh w-screen overflow-hidden bg-surface-0 text-slate-100">
      {/* 非表示ファイル入力 */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFilesSelected}
        multiple
        accept={fileAccept('.dtb,.bnx4,.bon4,.binx,.bon,.csv,.txt,.nmea,.log,.vbo,.gpx,.xrk,.xrz,.ibt,.fit,.tcx,.mp4,.mov')}
        className="hidden"
      />
      <input
        type="file"
        ref={pthInputRef}
        onChange={async e => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) {
            const txt = await f.text();
            const polylines = parsePth(txt);
            // コース図として読めないファイル (iPhone ではどのファイルでも選べる) は、空のコース図にせず知らせる
            if (polylines.length === 0) {
              alert(tr(`${f.name} をコース図 (.pth) として読めませんでした`, `Could not read ${f.name} as a track map (.pth)`));
              return;
            }
            // コース図の近く (2 km 以内) を走ったログだけに設定する (別のコースのログのコース図を置き換えないように)
            const ids = latestRef.current.sessions.filter(s => passesNearPolylines(s, polylines, 2000)).map(s => s.id);
            // 手動で読み込んだコース図を、遅れて届いた自動取得の結果で上書きしない
            setSessionPolylines(ids, polylines, 'manual');
            // 近くのログがなければ、次に読み込む近くのログに付けるよう覚えておく (ログを読み込む前なら画面にもそのまま出す)
            if (ids.length === 0) {
              setCourseHint({ ...courseRef.current, polylines, polylinesSource: 'manual' });
              if (latestRef.current.sessions.length > 0) alert(tr('このコース図の近くを走ったログがないため、次に読み込む近くのログに使います。', 'No loaded log runs near this track map, so it will be used for the next log you load nearby.'));
            }
          }
        }}
        accept={fileAccept('.pth')}
        className="hidden"
      />
      <input
        type="file"
        ref={clnInputRef}
        onChange={async e => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) {
            const txt = await f.text();
            let cl;
            try {
              cl = parseCln(txt, f.name);
            } catch (err: any) {
              alert(tr(`${f.name} を計測線 (.cln) として読めませんでした: ${err.message}`, `Could not read ${f.name} as a timing line (.cln): ${err.message}`));
              return;
            }
            // 計測線の近く (1 km 以内) を走ったログだけに反映する (セクターは各セッションのものを保つ)。
            // 近くのログがなければどのセッションも変えない (別のコースのログの周回が崩れるため)。次に読み込む近くのログで使う
            const ids = latestRef.current.sessions.filter(s => passesNearControlLine(s.points, cl)).map(s => s.id);
            // 次に読むログの手がかりも、計測線を反映したセッションのコースにそろえる (別のコースのセクター・コース名と混ぜない)
            const target = latestRef.current.sessions.find(s => s.id === ids[0]);
            setCourseHint({ cl, sec: target?.sectors ?? [], name: target?.circuitName ?? '', polylines: target ? target.pathPolylines : courseRef.current.polylines, polylinesSource: target ? target.pathPolylinesSource : courseRef.current.polylinesSource });
            recalcSessions(s => (ids.includes(s.id) ? { cl, sec: s.sectors || [] } : null));
          }
        }}
        accept={fileAccept('.cln')}
        className="hidden"
      />
      <input
        type="file"
        ref={folderInputRef}
        onChange={async e => {
          const files = e.target.files;
          if (files && files.length > 0) {
            const r = await userCircuitStorage.importFiles(files);
            const lines = [
              r.saved
                ? tr('ユーザーコースデータを登録しました。', 'Course data installed.')
                : tr('⚠ ユーザーコースデータを読み込みましたが、保存できませんでした（アプリを閉じると消えます）。', '⚠ Course data was loaded but could not be saved (it will be lost when you close the app).'),
              tr(`コース: ${r.circuits} 件（コース図あり ${r.withPolylines} 件 / セクターあり ${r.withSectors} 件）`,
                `Courses: ${r.circuits} (${r.withPolylines} with a track map / ${r.withSectors} with sectors)`)
            ];
            if (r.loosePolylines > 0) lines.push(tr(`コントロールラインと組み合わせられなかったコース図: ${r.loosePolylines} 件（近くの内蔵コースのコース図として使います）`, `Track maps not matched to a timing line: ${r.loosePolylines} (used as track maps for nearby built-in courses)`));
            if (r.unusedSectors.length > 0) lines.push(tr(`どのコースとも組み合わせられなかったセクター: ${r.unusedSectors.length} 件（${r.unusedSectors.slice(0, 5).join(', ')}${r.unusedSectors.length > 5 ? ' ほか' : ''}）`, `Sectors not matched to any course: ${r.unusedSectors.length} (${r.unusedSectors.slice(0, 5).join(', ')}${r.unusedSectors.length > 5 ? ' and more' : ''})`));
            if (r.failed.length > 0) lines.push(tr(`読み込めなかったファイル: ${r.failed.length} 件（${r.failed.slice(0, 5).map(f => `${f.path}: ${f.reason}`).join(' / ')}${r.failed.length > 5 ? ' ほか' : ''}）`, `Files that could not be read: ${r.failed.length} (${r.failed.slice(0, 5).map(f => `${f.path}: ${f.reason}`).join(' / ')}${r.failed.length > 5 ? ' and more' : ''})`));
            if (!r.saved && r.saveError) lines.push(`${tr('保存できなかった理由', 'Reason it could not be saved')}: ${r.saveError}`);
            alert(lines.join('\n'));
            // 読み込み済みのログにも反映する: 各ログの位置で改めてコースを引き当て、周回を計算し直す
            const matches = new Map(latestRef.current.sessions.map(s => [
              s.id,
              s.points[0] ? findMatchingCircuit(s.points[0].latitude, s.points[0].longitude, s.points) : undefined
            ]));
            // 反映するのは、ユーザーコースに当たったセッションだけ。内蔵のコースに当たったセッションは、
            // 手で直した計測線・セクターを消さないよう変えない
            const isUser = (m?: CircuitPreset) => !!m && m.id.startsWith('user:');
            recalcSessions(s => {
              const m = matches.get(s.id);
              return isUser(m) ? { cl: m!.controlLine ?? s.controlLine, sec: m!.sectors, name: m!.name } : null;
            });
            for (const [id, m] of matches) {
              if (!m) continue;
              const s = latestRef.current.sessions.find(x => x.id === id);
              if (!s) continue;
              // 利用者が読み込んだコース図 (.pth) は変えない
              if (s.pathPolylinesSource === 'manual') continue;
              if (isUser(m) || (!s.pathPolylines && s.circuitName === m.name)) {
                // コース図を取り直す。見つからなければ (通信できないときなど) 今のコース図を残す
                requestPolylines([id], m);
              } else if (s.pathPolylinesSource === 'auto' && s.circuitName === m.name) {
                // アプリが自動で取得したコース図 (OpenStreetMap など) は、読み込んだコース図にこのログが乗っていれば置き換える。
                // (利用者が別のコースを選んだセッション・メインストレートを共有する別のコースのコース図には置き換えない。通信もしない)
                const p = findUserPolylines(m);
                if (p && p !== s.pathPolylines && runsOnPolylines(s.points, p)) setSessionPolylines([id], p, 'auto');
              }
            }
            // 次に読み込むログの手がかり (ログを読み込む前なら画面にも出す) のコース図も、自動で取得したものなら読み込んだコース図に置き換える
            const hint = courseRef.current;
            const hintCircuit = hint.name ? ALL_CIRCUITS.find(c => c.name === hint.name) : undefined;
            if (hintCircuit && hint.polylinesSource !== 'manual') {
              const p = findUserPolylines(hintCircuit);
              if (p && p !== hint.polylines) setCourseHint({ ...hint, polylines: p, polylinesSource: 'auto' });
            }
            setUserCircuitCount(userCircuitStorage.getCircuitCount());
          }
          e.target.value = '';
        }}
        // @ts-ignore
        webkitdirectory=""
        // @ts-ignore
        directory=""
        multiple
        className="hidden"
      />

      {/* ヘッダー */}
      <Header
        currentTab={currentTab}
        setCurrentTab={setCurrentTab}
        sessions={sessions}
        selectedCars={selectedCars}
        isPlaying={isPlaying}
        onTogglePlay={() => setIsPlaying(!isPlaying)}
        onStepForward={() => handleStep(0.1)}
        onStepBack={() => handleStep(-0.1)}
        playbackSpeed={playbackSpeed}
        onChangePlaybackSpeed={setPlaybackSpeed}
        onOpenFile={() => fileInputRef.current?.click()}
        onOpenDonate={() => setIsDonateModalOpen(true)}
        compact={isCompact}
      />

      {/* メインコンテンツ */}
      <main className={`flex-1 overflow-hidden ${isCompact ? 'p-2' : 'p-3'}`}>
        {/* グラフ解析タブ */}
        {isCompact ? (
          // スマートフォン: 速度ウインドウを上 (横向きでは左) に固定し、もう片方は切り替えて 1 つずつ表示する
          <div className={`h-full w-full gap-2 overflow-hidden ${currentTab === 'graph' ? 'flex' : 'hidden'} ${isLandscape ? 'flex-row' : 'flex-col'}`}>
            <div className={isLandscape ? 'w-1/2 h-full min-w-0' : 'h-[42%] min-h-[180px] shrink-0'}>
              {speedGraphEl}
            </div>
            <div className="flex-1 min-h-0 min-w-0 flex flex-col bg-surface-1 rounded border border-line-1 overflow-hidden">
              <div className="flex gap-1 p-1 bg-surface-2 border-b border-line-1 whitespace-nowrap shrink-0">
                {MOBILE_PANELS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => setMobilePanel(p.id)}
                    className={`flex-1 px-1 py-1.5 rounded text-xs font-bold transition-colors ${
                      mobilePanel === p.id ? 'bg-red-600 text-white' : 'text-slate-400'
                    }`}
                  >
                    {T(...p.label)}
                  </button>
                ))}
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                {/* 切り替えても表示の設定 (色分け・拡大・追従など) が消えないよう、外さずに隠すだけにする */}
                {([['map', trackMapEl], ['replay', replayEl], ['gg', frictionEl], ['corner', cornerEl], ['braking', brakingEl], ['drift', driftEl]] as const)
                  .filter(([id]) => MOBILE_PANELS.some(p => p.id === id))
                  .map(([id, el]) => (
                    <div key={id} className={mobilePanel === id ? 'h-full' : 'hidden'}>
                      {el}
                    </div>
                  ))}
              </div>
            </div>
          </div>
        ) : (
          <div
            ref={horizSplit.containerRef}
            className={`flex-row h-full w-full overflow-hidden select-none ${currentTab === 'graph' ? 'flex' : 'hidden'}`}
          >
            {/* 左側 / メイン: 速度ウインドウ & アニメーション/動画 (上下分割) */}
            <div
              ref={leftVertSplit.containerRef}
              // 右の列を両方たたんだときは、左の列を横いっぱいにする
              style={rightCollapsed ? undefined : { width: `${horizSplit.ratio * 100}%` }}
              className={`flex flex-col h-full overflow-hidden min-w-[200px] ${rightCollapsed ? 'flex-1' : ''}`}
            >
              {/* 上部: 速度グラフ (下をたたんだときは縦いっぱい) */}
              <div
                style={collapsed.anim ? undefined : { height: `${leftVertSplit.ratio * 100}%` }}
                className={`min-h-[120px] overflow-hidden ${collapsed.anim ? 'flex-1 mb-2' : ''}`}
              >
                {speedGraphEl}
              </div>

              {/* 左上下スプリッター */}
              {!collapsed.anim && (
                <SplitResizer
                  direction="vertical"
                  isDragging={leftVertSplit.isDragging}
                  {...leftVertSplit.resizerProps}
                />
              )}

              {/* 下部: 走行アニメーション or 車載動画 切替エリア (たたむとタブの帯だけ残す) */}
              <div
                style={collapsed.anim ? undefined : { height: `${(1 - leftVertSplit.ratio) * 100}%` }}
                className={`overflow-hidden flex flex-col bg-surface-1 rounded border border-line-1 ${collapsed.anim ? 'shrink-0' : 'min-h-[120px]'}`}
              >
                {/* 左下タブバー */}
                <div className={`flex items-center bg-surface-2 p-1 text-[11px] gap-1 shrink-0 ${collapsed.anim ? '' : 'border-b border-line-1'}`}>
                  <button
                    onClick={() => { setLeftBottomMode('replay'); toggleCollapsed('anim', false); }}
                    className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                      leftBottomMode === 'replay'
                        ? 'bg-red-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {T('走行アニメーション', 'Animation')}
                  </button>
                  <button
                    onClick={() => { setLeftBottomMode('video'); toggleCollapsed('anim', false, 'video'); }}
                    className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                      leftBottomMode === 'video'
                        ? 'bg-red-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {T('車載動画 (GoPro/MP4)', 'Onboard video (GoPro/MP4)')}
                  </button>
                  <CollapseButton collapsed={collapsed.anim} onClick={() => toggleCollapsed('anim')} />
                </div>

                {/* たたんでも中身の設定 (拡大率など) が消えないよう、外さずに隠す。動画だけは隠したまま再生されないよう外す */}
                {!(collapsed.anim && leftBottomMode === 'video') && (
                <div className={`flex-1 min-h-0 overflow-hidden ${collapsed.anim ? 'hidden' : ''}`}>
                  {leftBottomMode === 'replay' ? (
                    replayEl
                  ) : (
                    <VideoSyncWindow
                      sessions={sessions}
                      selectedCars={selectedCars}
                      currentTimeSec={currentTimeSec}
                      currentDistanceKm={currentDistanceKm}
                      isPlaying={isPlaying}
                      onSeekTime={handleSeekTime}
                      onTogglePlay={() => setIsPlaying(!isPlaying)}
                      circuitName={currentCircuitName}
                      targetSessionId={baseSession?.id}
                      targetLap={baseLap}
                      isGraphEmbedded={true}
                      isVisible={currentTab === 'graph'}
                      playbackSpeed={playbackSpeed}
                      onChangePlaybackSpeed={setPlaybackSpeed}
                    />
                  )}
                </div>
                )}
              </div>
            </div>

            {/* 左右スプリッター */}
            {!rightCollapsed && (
              <SplitResizer
                direction="horizontal"
                isDragging={horizSplit.isDragging}
                {...horizSplit.resizerProps}
              />
            )}

            {/* 右の列を両方たたんだとき: 細い縦の帯にして、押すと開く */}
            {rightCollapsed && (
              <div className="w-9 shrink-0 ml-2 flex flex-col gap-2">
                {([['map', T('全コース', 'Track map')], ['sub', T('GG・コーナー・ブレーキング', 'GG / corners / braking')]] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => toggleCollapsed(key, false)}
                    title={T(`${label}を開く`, `Open ${label}`)}
                    className="flex-1 flex items-center justify-center rounded border border-line-1 bg-surface-2 hover:bg-surface-4 text-[11px] font-bold text-slate-400 hover:text-slate-200 [writing-mode:vertical-rl] tracking-wider cursor-pointer"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {/* 右側: 全コースウインドウ ＆ フリクションサークル / ドリフト */}
            <div
              ref={rightVertSplit.containerRef}
              style={{ width: `${(1 - horizSplit.ratio) * 100}%` }}
              className={`flex-col h-full overflow-hidden min-w-[200px] ${rightCollapsed ? 'hidden' : 'flex'}`}
            >
              {/* 右上: 全コースウインドウ。下のウインドウと同じく上に帯を付け、たたむと帯だけ残す (表示の設定を消さないよう、外さずに隠す) */}
              <div
                style={collapsed.map || collapsed.sub ? undefined : { height: `${rightVertSplit.ratio * 100}%` }}
                className={`overflow-hidden flex flex-col bg-surface-1 rounded border border-line-1 ${
                  collapsed.map ? 'shrink-0 mb-2' : collapsed.sub ? 'flex-1 min-h-[120px]' : 'min-h-[120px]'
                }`}
              >
                <div className={`flex items-center bg-surface-2 p-1 text-[11px] gap-1 shrink-0 ${collapsed.map ? '' : 'border-b border-line-1'}`}>
                  <button
                    onClick={() => toggleCollapsed('map', false)}
                    className="px-3 py-0.5 rounded font-bold bg-emerald-600 text-white cursor-pointer"
                  >
                    {T('全コースウインドウ', 'Track map')}
                  </button>
                  <CollapseButton collapsed={collapsed.map} onClick={() => toggleCollapsed('map')} />
                </div>
                <div className={`flex-1 min-h-0 overflow-hidden ${collapsed.map ? 'hidden' : ''}`}>
                  {trackMapEl}
                </div>
              </div>

              {/* 右上下スプリッター */}
              {!collapsed.map && !collapsed.sub && (
                <SplitResizer
                  direction="vertical"
                  isDragging={rightVertSplit.isDragging}
                  {...rightVertSplit.resizerProps}
                />
              )}

              {/* 右下: サブウインドウ切替タブ (たたむとタブの帯だけ残す) */}
              <div
                style={collapsed.map || collapsed.sub ? undefined : { height: `${(1 - rightVertSplit.ratio) * 100}%` }}
                className={`overflow-hidden flex flex-col bg-surface-1 rounded border border-line-1 ${
                  collapsed.sub ? `shrink-0 ${collapsed.map ? '' : 'mt-2'}` : collapsed.map ? 'flex-1 min-h-[120px]' : 'min-h-[120px]'
                }`}
              >
                <div className={`flex items-center bg-surface-2 p-1 text-[11px] gap-1 shrink-0 whitespace-nowrap ${collapsed.sub ? '' : 'border-b border-line-1'}`}>
                  <div className="flex gap-1 overflow-x-auto no-scrollbar min-w-0">
                  <button
                    onClick={() => { setSubWindowMode('all'); toggleCollapsed('sub', false); }}
                    className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                      subWindowMode === 'all'
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {T('フリクションサークル (GG)', 'Friction circle (GG)')}
                  </button>
                  {SHOW_DRIFT && (
                    <button
                      onClick={() => { setSubWindowMode('track_friction'); toggleCollapsed('sub', false); }}
                      className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                        subWindowMode === 'track_friction'
                          ? 'bg-orange-600 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {T('ドリフト採点・評価', 'Drift scoring')}
                    </button>
                  )}
                  <button
                    onClick={() => { setSubWindowMode('corner'); toggleCollapsed('sub', false); }}
                    className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                      subWindowMode === 'corner'
                        ? 'bg-amber-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {T('コーナー解析', 'Corners')}
                  </button>
                  <button
                    onClick={() => { setSubWindowMode('braking'); toggleCollapsed('sub', false); }}
                    className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                      subWindowMode === 'braking'
                        ? 'bg-rose-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {T('ブレーキング', 'Braking')}
                  </button>
                  <button
                    onClick={() => { setSubWindowMode('video'); toggleCollapsed('sub', false, 'video'); }}
                    className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                      subWindowMode === 'video'
                        ? 'bg-red-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {T('車載動画同期', 'Onboard video')}
                  </button>
                  </div>
                  <CollapseButton collapsed={collapsed.sub} onClick={() => toggleCollapsed('sub')} />
                </div>

                {/* たたんでも中身の設定が消えないよう、外さずに隠す。動画だけは隠したまま再生されないよう外す */}
                {!(collapsed.sub && subWindowMode === 'video') && (
                <div className={`flex-1 min-h-0 overflow-hidden ${collapsed.sub ? 'hidden' : ''}`}>
                  {subWindowMode === 'all' && (
                    frictionEl
                  )}
                  {subWindowMode === 'track_friction' && (
                    driftEl
                  )}
                  {subWindowMode === 'corner' && (
                    cornerEl
                  )}
                  {subWindowMode === 'braking' && (
                    brakingEl
                  )}
                  {subWindowMode === 'video' && (
                    <VideoSyncWindow
                      sessions={sessions}
                      selectedCars={selectedCars}
                      currentTimeSec={currentTimeSec}
                      currentDistanceKm={currentDistanceKm}
                      isPlaying={isPlaying}
                      onSeekTime={handleSeekTime}
                      onTogglePlay={() => setIsPlaying(!isPlaying)}
                      circuitName={currentCircuitName}
                      targetSessionId={baseSession?.id}
                      targetLap={baseLap}
                      isGraphEmbedded={true}
                      isVisible={currentTab === 'graph'}
                      playbackSpeed={playbackSpeed}
                      onChangePlaybackSpeed={setPlaybackSpeed}
                    />
                  )}
                </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 動画同期タブ。スマートフォン向けの配置では出さない (隠したまま動画が再生され続けないよう、外す) */}
        {!isCompact && (
          <div className={`h-full w-full overflow-hidden ${currentTab === 'video' ? 'block' : 'hidden'}`}>
            <VideoSyncWindow
              sessions={sessions}
              selectedCars={selectedCars}
              currentTimeSec={currentTimeSec}
              currentDistanceKm={currentDistanceKm}
              isPlaying={isPlaying}
              onSeekTime={handleSeekTime}
              onTogglePlay={() => setIsPlaying(!isPlaying)}
              circuitName={currentCircuitName}
              targetSessionId={baseSession?.id}
              targetLap={baseLap}
              isGraphEmbedded={false}
              isVisible={currentTab === 'video'}
              playbackSpeed={playbackSpeed}
              onChangePlaybackSpeed={setPlaybackSpeed}
            />
          </div>
        )}

        {/* データ管理タブ */}
        <div className={`h-full w-full overflow-hidden ${currentTab === 'data' ? 'block' : 'hidden'}`}>
          <DataTab
            sessions={sessions}
            selectedCars={selectedCars}
            onSelectCarSlot={handleSelectCarSlot}
            onClearCarSlot={slotIndex => setSelectedCars(prev => prev.filter(c => c.slot !== slotIndex))}
            onSetDistanceOffset={handleSetDistanceOffset}
            alignLapLength={alignLapLength}
            onSetAlignLapLength={setAlignLapLength}
            baseSlot={baseSelected?.slot}
            userCircuitCount={userCircuitCount}
            onOpenInConvert={id => {
              setConvertSessionId(id);
              setCurrentTab('convert');
            }}
            onRemoveSession={id => {
              polylineRequestRef.current.delete(id);
              setConvertSessionId(prev => (prev === id ? '' : prev));
              setSessions(prev => prev.filter(s => s.id !== id));
              setSelectedCars(prev => prev.filter(c => c.sessionId !== id));
            }}
            onEditSessionName={(id, name) => {
              setSessions(prev => prev.map(s => (s.id === id ? { ...s, sessionName: name } : s)));
            }}
            onSelectCircuitPreset={handleSelectCircuitPreset}
            onOpenCircuitEditor={() => setIsCircuitEditorOpen(true)}
            onLoadPthFile={() => pthInputRef.current?.click()}
            onLoadClnFile={() => clnInputRef.current?.click()}
            onLoadCircuitFolder={() => folderInputRef.current?.click()}
            onOpenFile={() => fileInputRef.current?.click()}
            gFilterLevel={gFilterLevel}
            onChangeGFilterLevel={handleChangeGFilterLevel}
          />
        </div>

        {/* ログ変換タブ */}
        {currentTab === 'convert' && (
          <ConvertTab
            sessions={sessions}
            sessionId={convertSessionId}
            defaultSessionId={baseSession?.id}
            onSelectSession={setConvertSessionId}
            gFilterLevel={gFilterLevel}
            onOpenFile={() => fileInputRef.current?.click()}
            onDropFiles={files => loadFiles(Array.from(files))}
          />
        )}

        {/* ロガー設定タブ (マウント状態を維持し、USBシリアル切断を防止)。スマートフォン・タブレットでは出さない */}
        {canUseLoggerUsb && (
          <div className={`h-full w-full overflow-hidden ${currentTab === 'logger' ? 'block' : 'hidden'}`}>
            <LoggerTab
              onLoadSession={(fileName, buffer) => loadFileData(fileName, buffer)}
              onNavigateToGraph={() => setCurrentTab('graph')}
            />
          </div>
        )}
      </main>

      {/* スマートフォン: グラフ解析タブのシークバーと、画面下のタブバー */}
      {isCompact && currentTab === 'graph' && baseLap && (
        <MobileSeekBar currentTime={currentTimeSec} endTime={playEndTime} onSeekTime={handleSeekTime} />
      )}
      {isCompact && <BottomTabBar currentTab={currentTab} setCurrentTab={setCurrentTab} sessionCount={sessions.length} />}

      {/* コース編集モーダル */}
      {isCircuitEditorOpen && (
      <CircuitEditorModal
        isOpen={isCircuitEditorOpen}
        onClose={() => setIsCircuitEditorOpen(false)}
        currentCircuitName={currentCircuitName}
        controlLine={currentControlLine}
        defaultPosition={
          (baseSession ?? sessions[0])?.points[0]
            ? {
                lat: (baseSession ?? sessions[0]).points[0].latitude,
                lon: (baseSession ?? sessions[0]).points[0].longitude
              }
            : undefined
        }
        sectors={currentSectors}
        onSavedCircuitsChange={() => setUserCircuitCount(userCircuitStorage.getCircuitCount())}
        onSaveCircuit={(name, cl, sec, remember) => {
          // アプリに保存して、次から同じ場所のログに使う (閉じても消えない)
          if (remember) {
            userCircuitStorage.saveEditedCircuit(name, cl, sec, baseSession && passesNearControlLine(baseSession.points, cl) ? baseSession.pathPolylines : undefined).then(r => {
              if (!r.saved) alert(`${tr('コースを保存できませんでした (この画面には反映しています)', 'Could not save the course (it is applied on this screen)')}: ${r.saveError ?? ''}`);
              setUserCircuitCount(userCircuitStorage.getCircuitCount());
            });
          }
          // 編集したコースは、その計測線を通過したログに反映する。なければ基準車のセッションに反映する
          // (近くを走っただけのログ (筑波 2000 を直したときの 1000 のログなど) には反映しない)
          const ids = targetSessionIds(s => !!cl && countGateCrossings(s.points, cl) > 0);
          // ログを読み込む前に保存したときも、画面と次に読み込むログに使う (コース図は反映したセッションのものを引き継ぐ)
          const target = latestRef.current.sessions.find(s => s.id === ids[0]);
          setCourseHint({ cl, sec, name, polylines: target ? target.pathPolylines : courseRef.current.polylines, polylinesSource: target ? target.pathPolylinesSource : courseRef.current.polylinesSource });
          recalcSessions(s => (ids.includes(s.id) ? { cl, sec, name } : null));
        }}
      />
      )}

      {/* 開発支援 (Buy Me a Coffee) モーダル */}
      <DonateModal
        isOpen={isDonateModalOpen}
        onClose={() => setIsDonateModalOpen(false)}
      />
    </div>
  );
};
export default App;
