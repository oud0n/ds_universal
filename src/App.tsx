import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight, FolderOpen, X } from 'lucide-react';
import { CompareAxis, Lap, Session, TelemetryPoint, SelectedCarSlot, ControlLine, Sector, CircuitPreset, PolylineSource } from './types/telemetry';
import { parseNmea } from './services/nmeaParser';
import { blobByteSource, goproRecording, NoGoproGpsError, parseGoproGps } from './services/gpmfParser';
import { sessionStartUtcMs, videoSyncManager, placeTracks, isProxyFileName } from './services/videoSyncManager';
import { getAddVideoGpsLog } from './services/videoPrefs';
import { referenceCandidates } from './services/clockOffsetEstimator';
import { analyseSessions, isSameRun } from './services/pairAnalysis';
import type { ClockEstimateResult } from './components/DataTab';
import { circuitLabel, tr, useT } from './utils/i18n';
import { parsePth, parseCln } from './services/pthParser';
import { parseLogBuffer } from './services/logLoader';
import { AUTO_CONTROL_LINE_NAME, createAutoControlLine, createEqualSectors } from './services/autoCourseLines';
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
import { XYGraphWindow } from './components/XYGraphWindow';
import { BrakingAnalysisWindow } from './components/BrakingAnalysisWindow';
import { VideoSyncWindow } from './components/VideoSyncWindow';
import { useVideoTracks, useVideoView, videoEndSessionSec } from './services/videoViewStore';
import { DataTab } from './components/DataTab';
import { LoggerTab } from './components/LoggerTab';
import { LapTimerScreen, type ReplayLog } from './components/LapTimerScreen';
import { CircuitEditorModal } from './components/CircuitEditorModal';
import { DonateModal } from './components/DonateModal';
import { TipModal } from './components/TipModal';
import { tipsAvailable } from './services/tips';
import { hasNative } from './native/bridge';
import { sameCourseName } from './utils/courseNames';
import { ChoiceDialogHost, askChoice } from './components/ChoiceDialog';
import { EmptyLoadPrompt } from './components/EmptyLoadPrompt';
import { RecentRunsList, RunsSheet, notifyRunsChanged } from './components/RecentRuns';
import { canUseRunStore, getRunStore } from './services/runStore';
import { attachCompanionVideos, attachRunVideos, closeOpenRun, companionRuns, dropCompanion, totalBytes, videoCandidates, type RunItem } from './services/runOpener';
import { useResizableSplit } from './hooks/useResizableSplit';
import { canUseLapTimer, canUseLogger, canUseLoggerBle, fileAccept, isWebKitBrowser, redrawIntervalOverride } from './utils/device';
import { bleLoggerLink } from './services/bleLoggerLink';
import { useWheelScrollX } from './hooks/useWheelScrollX';
import { isDialogOpen, useEscapeKey } from './hooks/useEscapeKey';
import { readClockMaster } from './services/clockMaster';
import { useCompactLayout, useLandscape } from './hooks/useCompactLayout';
import { Freeze } from './components/Freeze';
import { GFilterLevel, applyGFilter, getGFilterLevel, setGFilterLevel } from './services/physics';
import { BottomTabBar } from './components/MobileNav';
import { Sidebar } from './components/shell/Sidebar';
import { LibraryScreen } from './screens/LibraryScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { useAppProfile } from './app/appProfile';
import { navPlan } from './app/navPlan';
import { navStore, useNav } from './app/navStore';
import { PlayBar } from './components/PlayBar';
import { SplitResizer } from './components/SplitResizer';
import { interpolatePoint } from './utils/telemetrySearch';
import { ImportSheet } from './components/import/ImportSheet';
import { planImport, type ImportPlan } from './services/import/importPlan';
import { applyPlan, type PartResult } from './services/import/importApply';
import { electronWriter, nativeWriter } from './services/import/importWriters';
import { LOG_EXTENSIONS } from './services/logLoader';
import { getWriteBon4 } from './services/runFormatSettings';

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
type MobilePanel = 'map' | 'replay' | 'gg' | 'corner' | 'braking' | 'xy' | 'drift';
const MOBILE_PANELS: { id: MobilePanel; label: [string, string] }[] = ([
  { id: 'map', label: ['コース', 'Map'] },
  { id: 'replay', label: ['アニメ', 'Anim'] },
  { id: 'gg', label: ['GG', 'GG'] },
  { id: 'corner', label: ['コーナー', 'Corners'] },
  { id: 'braking', label: ['ブレーキ', 'Braking'] },
  { id: 'xy', label: ['X/Y', 'X/Y'] },
  { id: 'drift', label: ['ドリフト', 'Drift'] }
] as { id: MobilePanel; label: [string, string] }[]).filter(p => SHOW_DRIFT || p.id !== 'drift');

/** 文字を入れる欄か (そこに落とした文字・リンクは、ふつうどおり欄に入れる。ファイルはどこに落としても読み込む) */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number']);
const isTextField = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((t as HTMLInputElement).type)));

export const App: React.FC = () => {
  // 画面の文言 (言語を切り替えると描き直す)
  const T = useT();
  // タブ
  // 公開ページでは URL の末尾 (#convert など) で最初に開くタブを指定できる
  // 画面の組み方 (アプリ・デスクトップ版・ブラウザ、スマートフォンの幅か) と、出している画面 (app/navStore.ts。2026-10-21)
  const profile = useAppProfile();
  const plan = useMemo(() => navPlan(profile), [profile]);
  // はじめの描画の前に入れる (URL の末尾 #convert・#laptimer などで最初の画面を決める)。幅が変わって組み方が変わったら入れ直す
  useState(() => { navStore.init(plan); return 0; });
  useEffect(() => { navStore.init(plan); }, [plan]);
  const nav = useNav();
  // 解析の「走行とコース」の引き出し (今のデータの画面の中身。PLAN-24 の作る順番の 6)
  const [dataDrawer, setDataDrawer] = useState(false);
  const dataDrawerOpen = dataDrawer && nav.screen === 'analysis';
  // 解析から離れたら引き出しは閉じる (戻ったときに、グラフの上に出たままにならないように)
  useEffect(() => { if (nav.screen !== 'analysis') setDataDrawer(false); }, [nav.screen]);
  useEscapeKey(dataDrawerOpen, () => setDataDrawer(false));
  // 幅が変わって組み方が変わり、今の画面がなくなったときは、入れ直す (上の effect) までの間も最初の画面を出す
  const currentTab = plan.available.has(nav.screen) ? nav.screen : plan.home;
  // 変換画面で書き出すログ (データ管理の「変換画面で開く」で選ぶ。空なら基準車のログ)
  const [convertSessionId, setConvertSessionId] = useState('');

  // スマートフォン向けの配置 (画面の大きさで切り替える)。スマートフォンでは動画同期を出さない
  const isCompact = useCompactLayout();
  const isLandscape = useLandscape();
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('map');
  // グラフ解析の「周回を区切れていません」の注意を閉じたセッション
  const [wholeLapNoticeClosed, setWholeLapNoticeClosed] = useState('');

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

  // Bluetooth の層を用意する (つなぐのは、ロガー設定・ラップタイマーの画面を開いたとき)
  useEffect(() => {
    if (canUseLoggerBle) void bleLoggerLink.start();
  }, []);

  // グラフ画面・左下モード ('replay' | 'video')
  const [leftBottomMode, setLeftBottomMode] = useState<'replay' | 'video'>('replay');
  // 右下のタブの帯 (入りきらないときに横にスクロールする)
  const subTabsScrollRef = useWheelScrollX<HTMLDivElement>();
  // ファイルを画面の上に持ってきているか (落とせることを知らせる)。子の要素に入るたびに enter / leave が来るので、深さを数える
  const [fileDragOver, setFileDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  // 持ってきたのをやめたとき (Esc・ウインドウの外で離したとき) は、落とせる表示を消す
  useEffect(() => {
    const reset = () => { dragDepthRef.current = 0; setFileDragOver(false); };
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    return () => { window.removeEventListener('dragend', reset); window.removeEventListener('drop', reset); };
  }, []);

  // サブウインドウ表示モード ('all' | 'track_friction' | 'replay_focus' | 'video')
  const [subWindowMode, setSubWindowMode] = useState<'all' | 'track_friction' | 'replay_focus' | 'video' | 'corner' | 'braking' | 'xy'>('all');

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
  type CourseHint = { cl?: ControlLine; sec: Sector[]; name: string; fin?: ControlLine; polylines?: Array<Array<[number, number]>>; polylinesSource?: PolylineSource };
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
  // iPhone・Android のアプリでは、外の寄付のページ (Buy Me a Coffee) への案内を出さない
  // (App Store・Google Play の決まりで、開発者への投げ銭はアプリ内課金を通す必要がある。docs/app_store.md)。
  // アプリがアプリ内課金に対応していれば、ガソリンの投げ銭 (TipModal) を出す
  const inApp = hasNative();
  const [tipsOk, setTipsOk] = useState(false);
  useEffect(() => { if (inApp) void tipsAvailable().then(setTipsOk, () => setTipsOk(false)); }, [inApp]);
  const canDonate = !inApp || tipsOk;
  // 過去の走行 (保管場所。iPhone のアプリ・デスクトップ版): 全部の一覧を出しているか・開いている途中か
  const [runsSheetOpen, setRunsSheetOpen] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  /** 取り込みの確認 (ログを開いたとき、走行の保管場所があれば。2026-10-21、PLAN-24) */
  const [importing, setImporting] = useState<{
    plan: ImportPlan;
    name: string;
    bytes: Uint8Array;
    phase: 'confirm' | 'writing' | 'done';
    progress?: { done: number; total: number };
    results?: PartResult[];
  } | null>(null);
  /** 確認を閉じたら、次のファイルへ進む */
  const importDoneRef = useRef<(() => void) | null>(null);
  /** 確認は 1 つずつ (出ている間に別のファイルを開いたら、前のを閉じてから出す) */
  const importQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const runOpeningRef = useRef(false);
  // iCloud から取り込み中の動画 (取り込み終わったら、走行に付けて開く)。percent はふつう分からない (取り込み中とだけ出す)
  const [runDownload, setRunDownload] = useState<{ names: string[]; done: number } | null>(null);
  const runDownloadTokenRef = useRef(0);
  /** 保管場所から開いた走行の道と、そのログ (同じ名前のほかのフォルダの走行と取り違えないため) */
  const runSessionsRef = useRef(new Map<string, string[]>());
  /** 保管場所から開いた走行の一覧の行 (道 → 行)。Car 1 を替えたときに、その走行の動画を付け直すため */
  const runItemsRef = useRef(new Map<string, RunItem>());
  /** 今、動画を付けている走行の道 */
  const attachedRunRef = useRef<string | null>(null);
  /** 走行の一覧を出す: 走行の画面がある組み方ならそこへ、なければ重ねて出す */
  const showAllRuns = () => (plan.available.has('library') ? navStore.go('library') : setRunsSheetOpen(true));
  /** 読み込みのボタン: 保管場所があれば走行の一覧、なければファイルを選ぶ */
  // 走行の画面がある組み方では、ファイルを選ぶ (走行の一覧はタブ・サイドバーから)。ない組み方で保管場所があれば、走行の一覧を重ねて出す
  const openRunsOrFiles = () => (!plan.available.has('library') && canUseRunStore() ? setRunsSheetOpen(true) : fileInputRef.current?.click());
  // 開発サーバーで試すとき: #openrun=<フォルダ>/<ファイル> で、その走行を開く (画面を押せないシミュレーターで確かめるため)
  useEffect(() => {
    if (import.meta.env.DEV && window.location.hash === '#runsheet') {
      if (navPlan(profile).available.has('library')) navStore.go('library'); else setRunsSheetOpen(true);
    }
    if (!import.meta.env.DEV || !window.location.hash.startsWith('#openrun=')) return;
    const want = decodeURIComponent(window.location.hash.slice('#openrun='.length));
    void (async () => {
      const store = await getRunStore();
      if (!store) return;
      const { listRuns } = await import('./services/runOpener');
      const item = (await listRuns(store)).find(r => `${r.folder}/${r.file}` === want);
      if (item) await openRun(item);
      navStore.go('video');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ログを全部消したら、開いていた走行の動画と同期を覚えるのをやめる
  useEffect(() => { if (sessions.length === 0) closeOpenRun(); }, [sessions.length]);

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
  const currentFinishLine = courseSession ? courseSession.finishLine : idleCourse.fin;
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
      const { laps, bestLapIndex, theoreticalBestTime } = extractLaps(points, s.controlLine, s.sectors, s.finishLine);
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

  // 画面が隠れたら (ほかのアプリ・ウインドウの裏、iPhone のアプリを裏に回した) 再生を止める。
  // 時刻を進めるループ (requestAnimationFrame) は隠れている間は動かないのに、動画だけ進み続け、戻ったときや止めたときに動画が数秒戻っていた
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') setIsPlaying(false); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // アニメーションループ (requestAnimationFrame)
  const animRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(performance.now());
  // このループが最後に入れた時刻 (ほかで時刻を動かしたか (見ている位置を動かした) を見分ける)
  const loopTimeRef = useRef<number | null>(null);

  // 再生の基準はこのループだけにする。動画のウインドウは、この時刻に合わせて動画を再生する (動画の有無にかかわらず時刻が進む)
  // 時刻の基準: グラフ画面では選んでいる周の中の時刻 ('lap')、動画同期タブではセッション全体の時刻 ('session')。
  // データ管理などほかのタブでは直前の基準のままにする (行って戻っても再生位置が変わらないように)
  // 動画同期タブでは、ログがなくても (動画だけでも) 再生できるよう、表示している動画の終わりまで進める
  const isVideoTab = currentTab === 'video';
  const videoTracks = useVideoTracks();
  const videoView = useVideoView();
  const logEndTime = baseSession?.points.length ? baseSession.points[baseSession.points.length - 1].time : 0;
  // 出しているカメラを基準車のログの時刻に置いて、その終わりまで進める。メイン以外は、ログの間に始まるときだけ数える
  // (撮影日の違う動画で、再生の終わりが何日も先にならないように)
  const placedVideos = placeTracks(videoTracks, baseSession, sessions);
  const shownVideoEnds = videoView.cameraIds
    .map(id => placedVideos.find(t => t.id === id))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .filter((t, i) => i === 0 || !baseSession || t.syncOffsetSec < logEndTime)
    .map(videoEndSessionSec);
  const sessionEndTime = Math.max(logEndTime, ...shownVideoEnds);
  const [clockBase, setClockBase] = useState<'lap' | 'session'>(() => (isVideoTab ? 'session' : 'lap'));
  const wantClockBase: 'lap' | 'session' = isVideoTab ? 'session' : currentTab === 'analysis' ? 'lap' : clockBase;
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
    loopTimeRef.current = null;
    // スマートフォンでは、画面を描き直すのを 1 秒に 20 回までにする (毎コマ描き直すと、動画のコマが落ちる)。
    // パソコンの Safari (WebKit) も、毎コマ描き直すと動画のコマが落ちるので 1 秒に 30 回まで。Chrome・Electron は毎コマ。
    // 動画は自分で再生し、この時刻に合わせて少しずつ直すだけなので、なめらかなまま。URL の ?redraw=<ms> で試しに変えられる
    // 間隔はコマの間隔 (60 Hz で 16.7 ms) の倍数より少し短くする (ちょうどにすると、ぶれで 1 コマ多く待つことがある):
    // スマートフォンは 3 コマに 1 回 (45 ms)、パソコンの Safari は 2 コマに 1 回 (30 ms)
    const minStepMs = redrawIntervalOverride ?? (isCompact ? 45 : isWebKitBrowser ? 30 : 0);

    const loop = (now: number) => {
      if (now - lastTimeRef.current < minStepMs) {
        animRef.current = requestAnimationFrame(loop);
        return;
      }
      // requestAnimationFrame の時刻はフレームの開始時刻なので、再生開始時に記録した時刻より前のことがある (負にしない)
      const dtSec = Math.max(0, ((now - lastTimeRef.current) / 1000) * playbackSpeed);
      lastTimeRef.current = now;

      // 音を出している動画が再生しているときは、その動画の位置を時刻にする (clockMaster.ts)。読むのは state を変える関数の外で
      const master = readClockMaster();
      setCurrentTimeSec(prevTime => {
        let nextTime = prevTime + dtSec;
        // 動画が動き出すまでは待つ (戻しはしない)。1 秒より離れているとき (周の始めに戻した) と、
        // このループの外で時刻を動かした直後 (見ている位置を動かした) は、これまでどおり進め、動画のほうが付いてくる
        const movedOutside = loopTimeRef.current !== null && Math.abs(prevTime - loopTimeRef.current) > 1e-6;
        if (master !== null && !movedOutside && Math.abs(master - nextTime) < 1) nextTime = Math.max(prevTime, master);
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

        loopTimeRef.current = nextTime;
        return nextTime;
      });

      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [isPlaying, playbackSpeed, baseLap, baseSession, playEndTime, sessionEndTime, isSessionClock, isCompact]);

  // キーボードショートカット (Space: 再生/停止, F / →: コマ送り, B / ←: コマ戻し, Shift で 1 秒単位)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 入力フォーム操作中・ダイアログを開いているあいだは無視 (後ろの画面の再生が動かないように)
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;
      if (isDialogOpen()) return;
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
            alert(tr('GoPro の動画は、画面の上の「ファイルを開く」(スマートフォンは「開く」) から開いてください', 'Open GoPro videos with "Open file" in the app window'));
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
    // GoPro の低画質のファイル (.LRV) は、動画同期で元の動画と組にする (ログにはしない)
    const proxies = files.filter(f => isProxyFileName(f.name));
    for (const file of files.filter(f => !isProxyFileName(f.name))) {
      if (!isVideoFileName(file.name)) {
        try {
          // 保管場所があれば、走行ごとに分けて取り込むかを先に聞く (取り込まずに開くこともできる)
          if (await offerImport(file.name, await file.arrayBuffer())) continue;
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
    if (proxies.length > 0) await videoSyncManager.addVideoFiles(proxies, latestRef.current.sessions, false);
  };

  /**
   * ログを保管場所に取り込むかを聞く (確認のシートを出し、閉じるまで待つ)。保管場所がない・分けられない・全部取り込み済みなら
   * 聞かずに false (そのまま開く)。true なら、開くかどうかはシートの中で決まった
   */
  const offerImport = async (name: string, buffer: ArrayBuffer): Promise<boolean> => {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (!LOG_EXTENSIONS.includes(ext) || !canUseRunStore()) return false;
    let plan: ImportPlan;
    try {
      const store = await getRunStore();
      if (!store) return false;
      const existing = new Set((await store.list()).filter(f => /\.(nmea|bon4)$/i.test(f.path)).map(f => f.path.replace(/\.[^./]+$/, '')));
      plan = planImport(await parseLogBuffer(name, buffer.slice(0), tr), name, existing);
    } catch {
      return false;
    }
    if (plan.parts.length === 0 || plan.parts.every(p => p.already)) return false;
    const shown = importQueueRef.current.then(() => new Promise<void>(resolve => {
      importDoneRef.current = resolve;
      setImporting({ plan, name, bytes: new Uint8Array(buffer), phase: 'confirm' });
    }));
    importQueueRef.current = shown;
    await shown;
    return true;
  };

  const closeImport = () => {
    setImporting(null);
    importDoneRef.current?.();
    importDoneRef.current = null;
  };

  /** 取り込みのシートから開く (取り込まずに・取り込んだあとに) */
  const openImported = async () => {
    const cur = importing;
    closeImport();
    if (!cur) return;
    const b = cur.bytes;
    await loadFileData(cur.name, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    navStore.go('analysis');
  };

  const applyImport = async () => {
    const cur = importing;
    if (!cur || cur.phase !== 'confirm') return;
    const electron = electronWriter();
    // iPhone のアプリは、保管場所にもうあるファイルを書かない (選んだフォルダにだけある走行を上書きしないように)
    let have: Set<string> = new Set();
    if (!electron) {
      try {
        have = new Set((await (await getRunStore())?.list() ?? []).map(f => f.path));
      } catch (e) {
        alert(tr(`保管場所を読めないため、取り込めませんでした: ${e instanceof Error ? e.message : e}`, `Could not read the storage folder, so nothing was imported: ${e instanceof Error ? e.message : e}`));
        return;
      }
    }
    const native = electron ? null : nativeWriter(have);
    const writer = electron ?? native;
    if (!writer) return;
    setImporting({ ...cur, phase: 'writing', progress: { done: 0, total: cur.plan.parts.filter(p => p.checked).length } });
    try {
      const { results } = await applyPlan(cur.plan, { name: cur.name, bytes: cur.bytes }, writer, { writeBon4: getWriteBon4() },
        (done, total) => setImporting(s => (s ? { ...s, progress: { done, total } } : s)));
      if (native) await native.finish();
      setImporting(s => (s ? { ...s, phase: 'done', results } : s));
      // 開いている走行の一覧に、取り込んだ走行を出す (取り込みを走行の画面から始めると、画面が切り替わらず読み直されなかった)
      notifyRunsChanged();
    } catch (e) {
      // 途中で失敗しても、書いたファイルは閉じる (書いている最中のまま残さない)
      if (native) await native.finish().catch(() => {});
      alert(tr(`取り込めませんでした: ${e instanceof Error ? e.message : e}`, `Import failed: ${e instanceof Error ? e.message : e}`));
      setImporting(s => (s ? { ...s, phase: 'confirm' } : s));
    }
  };

  // GoPro の動画 (1 回の撮影のチャプター、順に並べたもの) の GPS を走行ログとして読み込み、同じ動画を動画同期にも登録する。
  // GPS と映像は同じ時計なので、撮影時刻からの照合でなく、GPS の時刻から求めたずれで合わせる
  const loadGoproVideos = async (files: File[]) => {
    // もう動画同期に登録してある動画なら何もしない (GPS のログを二重に読み込まない。動画同期のタブの「動画追加」から入れ直したときなど)
    const registered = videoSyncManager.getTracks();
    if (files.every(f => registered.some(t => t.objectUrl && t.fileName === f.name && t.fileSize === f.size))) return;
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
    // 同じ走行のログがすでにあるときは、動画の GPS を走行ログとして加えず、GPS の時刻で動画をそのログに合わせるだけにする (LATER-12)。
    // 「動画の GPS も走行ログとして加える」を切っていれば、より記録の細かいログに聞かずに合わせる。
    // 入れていれば (既定)、同じ走行のログがあるときだけ、加えるか聞く (同じ走行が 2 重になるため。2026-10-20)
    const addGps = getAddVideoGpsLog();
    {
      const first = log.points[0]?.timestamp, last = log.points[log.points.length - 1]?.timestamp;
      const a = first ? Date.parse(first) : NaN, b = last ? Date.parse(last) : NaN;
      const overlapping = latestRef.current.sessions
        .filter(s => addGps || (s.samplingRate || 0) > (log.samplingRate || 0))
        .filter(s => {
          const st = sessionStartUtcMs(s), lp = s.points[s.points.length - 1];
          return st !== null && lp && st < b && a < st + lp.time * 1000;
        })
        .sort((x, y) => (y.samplingRate || 0) - (x.samplingRate || 0));
      // 時刻が重なるだけでなく、同じ走行 (同じ車) と確かめられたログに付ける (同じ走行枠のチームメイトのログに付けない)
      const gpsAsLog = { id: `gopro-gps:${files[0].name}`, points: log.points } as Session;
      let better: Session | undefined;
      for (const s of overlapping) if (await isSameRun(s, gpsAsLog)) { better = s; break; }
      const betterStart = sessionStartUtcMs(better);
      // 加える設定のときは、同じ走行のログがあれば聞く (OK なら今までどおり加える)
      if (better && addGps) {
        const name = better.sessionName || better.fileName;
        const keep = await askChoice(
          tr('動画の GPS も取り込みますか？', 'Import the video GPS too?'),
          tr(
            `同じ走行のログ「${name}」がもう読み込まれています。\n\n取り込む: 動画の GPS も走行ログとして加えます (同じ走行が 2 つ並びます)\n取り込まない: 動画を「${name}」に合わせるだけにします`,
            `A log of the same run ("${name}") is already loaded.\n\nImport: add the video GPS as another log (the same run appears twice)\nDon't import: just sync the video to "${name}"`
          ),
          [
            { label: tr('取り込む', 'Import'), value: true },
            { label: tr('取り込まない', "Don't import"), value: false, primary: true }
          ],
          false
        );
        if (keep) better = undefined;
      }
      if (better && betterStart !== null) {
        const existing = videoSyncManager.getTracks();
        const toAdd = files.filter(f => !existing.some(t => t.objectUrl && t.fileName === f.name && t.fileSize === f.size));
        if (toAdd.length < files.length) return;
        const before = new Set(existing.map(t => t.id));
        const tracks = await videoSyncManager.addVideoFiles(toAdd, latestRef.current.sessions, false);
        const added = files
          .map((f, i) => ({ track: tracks.find(t => !before.has(t.id) && t.file === f), startMs: log.videoStartUtcMs[i] }))
          .filter((x): x is { track: NonNullable<typeof x.track>; startMs: number } => !!x.track);
        for (const x of added) videoSyncManager.setMatchedSession(x.track.id, better.id);
        // 動画の時刻は、動画自身の GPS の時刻 (UTC) で持つ (細かいログの時計の補正を変えても、動画の GPS の時刻のまま)
        const firstFix = added.find(x => Number.isFinite(x.startMs));
        if (firstFix) videoSyncManager.setGpsClock(firstFix.track.id, { utcMs: firstFix.startMs });
        return;
      }
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
    const tracks = await videoSyncManager.addVideoFiles(toAdd, [...latestRef.current.sessions.filter(s => s.id !== session.id), session], false);
    // 新しく加わった動画だけを合わせる (同期プロジェクトから戻した動画は、保存した同期のまま)
    const added = files
      .map((f, i) => ({ track: tracks.find(t => !before.has(t.id) && t.file === f), startMs: log.videoStartUtcMs[i] }))
      .filter((a): a is { track: NonNullable<typeof a.track>; startMs: number } => !!a.track);
    if (added.length === 0) return;
    for (const a of added) videoSyncManager.setMatchedSession(a.track.id, session.id);
    // チャプターのずれは動画の長さでそろうので、測位できた最初の動画で合わせる。時刻は GPS のログに付ける
    // (そのログの時計の補正を変えると、同じ時計の動画も一緒に動く)
    const first = added.find(a => Number.isFinite(a.startMs));
    if (first) videoSyncManager.setGpsClock(first.track.id, { session, offsetSec: (first.startMs - t0) / 1000 });
  };

  /**
   * 走行のいちばん速い周 (隠した周を除く) を、読み込んだログの周から探す。始まりの時刻がいちばん近く、タイムも同じ周
   * (1 つのログが 2 つ以上に分かれていても、分け方によらず探せる)。見つからなければ、そのログのベストラップ
   */
  const pickRunBestLap = (added: Session[], item: RunItem): { session: Session; lapNumber: number } => {
    const visible = item.laps.filter(l => !l.hidden);
    const best = visible.length ? visible.reduce((a, b) => (b.time < a.time ? b : a)) : null;
    let pick: { session: Session; lapNumber: number; gap: number } | null = null;
    if (best) {
      for (const s of added) {
        for (const l of s.laps) {
          if (l.isWholeSession || l.isPartialLap || Math.abs(l.lapTime - best.time) > 0.1) continue;
          const ts = s.points[l.startIndex]?.timestamp;
          const gap = ts ? Math.abs(Date.parse(ts) - best.startMs) : Infinity;
          if (!pick || gap < pick.gap) pick = { session: s, lapNumber: l.lapNumber, gap };
        }
      }
    }
    if (pick) return pick;
    const main = added.reduce((a, b) => ((b.laps[b.bestLapIndex]?.lapTime ?? Infinity) < (a.laps[a.bestLapIndex]?.lapTime ?? Infinity) ? b : a));
    return { session: main, lapNumber: main.laps[main.bestLapIndex]?.lapNumber ?? main.laps[0]?.lapNumber ?? 1 };
  };

  /**
   * 走行を比べる相手 (Car 2) として足す (走行の詳細の「Car 2 として足す」)。いま開いている走行と動画はそのまま。
   * その走行の動画は、Car が変わったときの処理 (companionChainRef) で足す。
   * 周は、その走行の隠していない周のうちいちばん速いもの (同じタイムの周を、読み込んだログの周から探す)
   */
  const addRunAsCar2 = async (item: RunItem) => {
    if (runOpeningRef.current) return;
    runOpeningRef.current = true;
    setRunBusy(true);
    try {
      const store = await getRunStore();
      if (!store) return;
      const runPath = `${item.folder}/${item.file}`;
      const openedIds = runSessionsRef.current.get(runPath) ?? [];
      let added = latestRef.current.sessions.filter(x => openedIds.includes(x.id));
      if (!added.length) {
        const bytes = await store.read(runPath);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        added = await loadFileData(item.file.slice(item.file.lastIndexOf('/') + 1), buffer);
        runSessionsRef.current.set(runPath, added.map(x => x.id));
      }
      runItemsRef.current.set(runPath, item);
      if (added.length === 0) return;
      const { session, lapNumber } = pickRunBestLap(added, item);
      setSelectedCars(prev => [
        ...prev.filter(c => c.slot !== 1),
        { slot: 1, sessionId: session.id, lapNumber, colorHex: '#3b82f6', label: `${session.sessionName} (L${lapNumber})` }
      ].sort((a, b) => a.slot - b.slot));
      navStore.go('analysis');
    } catch (e) {
      console.warn('[run] Car 2 として足せない:', e);
    } finally {
      runOpeningRef.current = false;
      setRunBusy(false);
    }
  };

  // 過去の走行を開く: ログを読み込み、同じフォルダの動画と同期をそろえる (runOpener.ts)
  const openRun = async (item: RunItem) => {
    // 続けて押しても 1 回だけ開く
    if (runOpeningRef.current) return;
    // ほかの走行を開いたら、前の走行の取り込み待ちはやめる
    runDownloadTokenRef.current++;
    setRunDownload(null);
    runOpeningRef.current = true;
    setRunBusy(true);
    try {
      const store = await getRunStore();
      if (!store) return;
      const bytes = await store.read(`${item.folder}/${item.file}`);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const runPath = `${item.folder}/${item.file}`;
      const openedIds = runSessionsRef.current.get(runPath) ?? [];
      const already = latestRef.current.sessions.filter(x => openedIds.includes(x.id));
      const added = already.length ? already : await loadFileData(item.file.slice(item.file.lastIndexOf('/') + 1), buffer);
      runSessionsRef.current.set(runPath, added.map(x => x.id));
      runItemsRef.current.set(runPath, item);
      attachedRunRef.current = runPath;
      setRunsSheetOpen(false);
      navStore.go('analysis');
      if (added.length === 0) return;
      // 開いた走行を Car 1 にする (いちばん速い周)。前に開いていた走行が Car 1 のままだと、解析と動画が別の走行になる。
      // Car 2〜4 は、同じコースのものだけ残す (違うコースと比べても意味がないため。比べるときは「Car 2 として足す」)
      {
        // 隠した周を除いた、いちばん速い周
        const { session: main, lapNumber } = pickRunBestLap(added, item);
        const byId = new Map(latestRef.current.sessions.map(x => [x.id, x]));
        setSelectedCars(prev => [
          { slot: 0, sessionId: main.id, lapNumber, colorHex: '#ef4444', label: `${main.sessionName} (L${lapNumber})` },
          ...prev.filter(c => c.slot !== 0 && c.sessionId !== main.id && sameCourseName(byId.get(c.sessionId)?.circuitName, main.circuitName))
        ].sort((a, b) => a.slot - b.slot));
        // 周の始めから見る (前に見ていた位置を、新しい周へ持ち込まない)
        setIsPlaying(false);
        setClockBase('lap');
        setCurrentTimeSec(0);
      }
      const sessionsNow = () => {
        const cur = latestRef.current.sessions;
        return [...cur, ...added.filter(a => !cur.some(c => c.id === a.id))];
      };
      const cand = await videoCandidates(store, item);
      if (cand.missing.length) {
        const gb = (totalBytes(cand.missing) / 1e9).toFixed(1);
        const download = await askChoice(
          tr('動画を iCloud から取り込みますか？', 'Download the videos from iCloud?'),
          tr(`この走行の動画 ${cand.missing.length} 本 (${gb} GB) が、まだこの端末にありません。\n\n取り込む: 取り込みを始めます。終わったら、この走行に自動で動画を付けます (この走行を開いている間)\n取り込まない: 端末にある動画とログだけで開きます`,
            `${cand.missing.length} video${cand.missing.length === 1 ? '' : 's'} of this run (${gb} GB) are not on this device yet.\n\nDownload: start downloading; the videos are attached automatically when done (while this run stays open)\nDon't download: open with the log and the videos on this device`),
          [
            { label: tr('取り込む', 'Download'), value: true },
            { label: tr('取り込まない', "Don't download"), value: false, primary: true }
          ],
          false
        );
        if (download) for (const m of cand.missing) await store.startDownload(m.path);
        // 取り込みが終わるのを待って、終わったら付ける (この走行を開いている間だけ)
        if (download) {
          const token = ++runDownloadTokenRef.current;
          const paths = cand.missing.map(m => m.path);
          setRunDownload({ names: paths.map(p => p.slice(p.lastIndexOf('/') + 1)), done: 0 });
          void (async () => {
            const started = Date.now();
            for (;;) {
              await new Promise(r => setTimeout(r, 3000));
              if (token !== runDownloadTokenRef.current) return;
              const st = await Promise.all(paths.map(p => store.fileStatus(p).catch(() => ({ local: false, downloading: false }))));
              const done = st.filter(s => s.local).length;
              setRunDownload(d => (d ? { ...d, done } : d));
              if (done === paths.length) break;
              // 1 時間で待つのをやめる (取り込みは「ファイル」アプリでも続く。終わってから開き直せば付く)
              if (Date.now() - started > 3600_000) { setRunDownload(null); return; }
            }
            // 待っている間に Car 1 を別の走行に替えた (走行とコースの引き出しなど) ときは付けない
            if (attachedRunRef.current !== runPath) { setRunDownload(null); return; }
            const refreshed: RunItem = { ...item, folderVideos: item.folderVideos.map(v => (paths.includes(v.path) ? { ...v, local: true } : v)) };
            const again = await videoCandidates(store, refreshed);
            if (token !== runDownloadTokenRef.current || attachedRunRef.current !== runPath) return;
            await attachRunVideos({
              store, item: refreshed, runSessions: added, videos: again.local, fromRuns: again.fromRuns,
              sessions: sessionsNow, circuitName: () => added[0]?.circuitName ?? '', setClockOffset: setSessionClockOffset
            }).catch(() => undefined);
            setRunDownload(null);
          })();
        }
      }
      await attachRunVideos({
        store, item, runSessions: added, videos: cand.local, fromRuns: cand.fromRuns,
        sessions: sessionsNow,
        circuitName: () => added[0]?.circuitName ?? '',
        setClockOffset: setSessionClockOffset
      });
    } catch (e) {
      alert(tr('走行を開けませんでした: ', 'Could not open the run: ') + (e instanceof Error ? e.message : String(e)));
    } finally {
      runOpeningRef.current = false;
      setRunBusy(false);
    }
  };

  // Car 1 を、保管場所から開いた別の走行に替えたら (走行とコースの引き出しなどで)、その走行の動画を付け直す
  // (前の走行の動画が残ったままだと、動画の画面が別の走行の動画を出す)。端末にある動画だけ (iCloud から取り込むかは聞かない)
  useEffect(() => {
    const id = baseSession?.id;
    if (!id || runOpeningRef.current) return;
    const entry = [...runSessionsRef.current.entries()].find(([, ids]) => ids.includes(id));
    if (!entry || entry[0] === attachedRunRef.current) return;
    const item = runItemsRef.current.get(entry[0]);
    if (!item) return;
    attachedRunRef.current = entry[0];
    void (async () => {
      const store = await getRunStore();
      if (!store) return;
      const added = latestRef.current.sessions.filter(x => entry[1].includes(x.id));
      const cand = await videoCandidates(store, item);
      if (attachedRunRef.current !== entry[0]) return;
      await attachRunVideos({
        store, item, runSessions: added, videos: cand.local, fromRuns: cand.fromRuns,
        sessions: () => latestRef.current.sessions,
        circuitName: () => added[0]?.circuitName ?? '',
        setClockOffset: setSessionClockOffset
      }).catch(e => console.warn('[run] 動画を付け直せない:', e));
    })();
    // 基準の走行が替わったときだけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSession?.id]);

  // Car 2〜4 に、開いている走行のほかの走行 (保管場所から開いたもの) の周を入れたら、その走行の動画も読む
  // (走行比較で、その車の枠にその車の動画を出すため。端末にある動画だけ)。どの Car にもいなくなった走行の動画は外す。
  // 走行を開いている間は待つ (開き終わってからそろえる)。順に 1 つずつ行う
  const companionChainRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (runBusy || runOpeningRef.current) return;
    const want = new Map<string, string[]>();
    for (const c of selectedCars) {
      if (c.slot === 0) continue;
      const entry = [...runSessionsRef.current.entries()].find(([, ids]) => ids.includes(c.sessionId));
      if (entry && entry[0] !== attachedRunRef.current) want.set(entry[0], entry[1]);
    }
    companionChainRef.current = companionChainRef.current.then(async () => {
      for (const p of companionRuns()) if (!want.has(p)) dropCompanion(p);
      const missing = [...want].filter(([p]) => !companionRuns().includes(p));
      if (!missing.length) return;
      const store = await getRunStore();
      if (!store) return;
      for (const [p, ids] of missing) {
        const item = runItemsRef.current.get(p);
        if (!item || p === attachedRunRef.current) continue;
        const cand = await videoCandidates(store, item);
        await attachCompanionVideos({
          item, runSessions: latestRef.current.sessions.filter(x => ids.includes(x.id)), videos: cand.local, fromRuns: cand.fromRuns,
          sessions: () => latestRef.current.sessions, setClockOffset: setSessionClockOffset
        });
      }
    }).catch(e => console.warn('[run] 比べる走行の動画を読めない:', e));
  }, [selectedCars, runBusy]);

  // データファイル読み込みロジック。読み込んだログはセッションとして加え、加えたセッションを返す
  // (parsedLog を渡したときは、ファイルを読まずにその点列を使う)
  const loadFileData = async (
    fileName: string,
    buffer: ArrayBuffer | null,
    parsedLog?: { points: any[]; samplingRate: number; startDate?: Date }
  ): Promise<Session[]> => {
    // 1 つのファイルに走行が複数入っているとき (生ログ・空きのある NMEA など) は、走行ごとに別のセッションにする (services/logLoader.ts)
    let parts: { points: any[]; samplingRate: number; startDate?: Date }[];
    // ログに記録されている車両名・ドライバー名・コース名 (iRacing の .ibt)
    let meta: { vehicleName?: string; driverName?: string; trackName?: string } = {};
    const added: Session[] = [];

    if (parsedLog) {
      parts = [{ points: parsedLog.points, samplingRate: parsedLog.samplingRate, startDate: parsedLog.startDate }];
    } else if (!buffer) {
      throw new Error(tr('ファイルの中身がありません', 'The file is empty'));
    } else {
      const parsed = await parseLogBuffer(fileName, buffer, tr);
      parts = parsed.parts;
      meta = parsed.meta;
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
      let fin = hint.fin;

      // 手がかりが判定したコースと同じコース (コース編集で計測線・セクターを直したものなど) なら、その設定を引き継ぐ
      const sameCourse = !!matchedCircuit && hint.name === matchedCircuit.name && !!hint.cl && passesNearControlLine(rawPoints, hint.cl);
      if (matchedCircuit && !sameCourse) {
        // 計測線を持たないコース (名阪など) では、同じ場所で先に決めた計測線 (仮の計測線・コース編集で置いた線) を引き継ぐ
        cl = matchedCircuit.controlLine ?? (hint.cl && passesNearControlLine(rawPoints, hint.cl) ? hint.cl : undefined);
        sec = matchedCircuit.sectors;
        circName = matchedCircuit.name;
        fin = matchedCircuit.finishLine;
      }

      // コースを判定できず、手がかりの計測線がこのログの近くにない (または計測線がない) ときは、その計測線・セクター・コース名は使わない
      if (!matchedCircuit && !(cl && passesNearControlLine(rawPoints, cl))) {
        cl = undefined;
        sec = [];
        circName = '';
        fin = undefined;
      }
      // ゴールの線がこのログの近くになければ使わない (計測線から計測線までを 1 周にする)
      if (fin && !passesNearControlLine(rawPoints, fin)) fin = undefined;

      // 手がかりのコース図 (先に読み込んだ .pth など) がこのログの近くにあれば、このセッションに付ける
      // 別のコースと判定した手がかり (同じ施設の隣のコースなど) のコース図は使わない (コース名のない、先に読み込んだ .pth は使う)
      const hintForThisCourse = !matchedCircuit || !hint.name || hint.name === matchedCircuit.name;
      const hintPolylines = hintForThisCourse && hint.polylines && passesNearPolylines({ points: rawPoints } as Session, hint.polylines, 2000) ? hint.polylines : undefined;

      // コースが分からず計測線もないときは、計測線を自動で置く (PLAN-12): 周回しているログなら、ピットロードの横の直線
      // (メインストレート) の真ん中に、毎周通ることを確かめて置く。セクターがなければ、速い周を距離で 3 等分した所に置く。
      // 周回していないログは、走り始めに仮の計測線を置く。後から読み込むログもこの線の通過点を 0 m にそろえるので、開始位置の違うログを重ねてもずれない
      if (!cl) {
        cl = createAutoControlLine(rawPoints) ?? createVirtualControlLine(rawPoints);
        if (cl?.name === AUTO_CONTROL_LINE_NAME && sec.length === 0) {
          const full = extractLaps(rawPoints, cl, []).laps.filter(l => !l.isPartialLap && !l.isWholeSession);
          const fastest = full.reduce<typeof full[number] | undefined>((a, l) => (!a || l.lapTime < a.lapTime ? l : a), undefined);
          if (fastest) sec = createEqualSectors(rawPoints, fastest, cl);
        }
      }
      // 出どころの分からない手がかりのコース図は、手で読み込んだものとして扱う (一括設置で置き換えないように)
      const hintSource: PolylineSource | undefined = hintPolylines ? (hint.polylinesSource ?? 'manual') : undefined;
      courseRef.current = { cl, sec, name: circName, fin, polylines: hintPolylines, polylinesSource: hintSource };

      // ラップ分割とセクタータイム計算 (ゴールの線があれば、スタートからゴールまでを 1 本にする)
      const { laps, bestLapIndex, theoreticalBestTime, sectors: lapSectors } = extractLaps(rawPoints, cl, sec, fin);

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
        ...(fin ? { finishLine: fin } : {}),
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
              label: `${newSession.sessionName} (L${bestLapNum})`,
              setBy: 'auto'
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
              label: `${newSession.sessionName} (L${bestLapNum})`,
              setBy: 'auto'
            }
          ];
        }
        return prev;
      });
    }

    // 変換ページ・動画同期から読み込んだときは、そのページに留まる (動画同期では、読み込んだ動画をそのまま見るため)
    if (navStore.getSnapshot().screen !== 'convert' && navStore.getSnapshot().screen !== 'video') navStore.go('analysis');
    return added;
  };

  const loadFileDataRef = useRef(loadFileData);
  loadFileDataRef.current = loadFileData;

  // 計測線・セクターを差し替えて、読み込み済みの全セッションの周回を計算し直す。
  // 周回数が変わって選択中の周が無くなった車両は、そのセッションのベストラップへ移す (画面から消えないように)
  // resolve が null を返したセッションは変えない (同じ場所のログだけにコースの変更を反映するため)
  const recalcSessions = (
    // fin: ゴールの線。渡さなければ今のゴールの線のまま、undefined を渡すと外す (計測線から計測線までにする)
    resolve: (s: Session) => { cl?: ControlLine; sec: Sector[]; name?: string; fin?: ControlLine } | null
  ) => {
    const updated = latestRef.current.sessions.map(s => {
      const r = resolve(s);
      if (!r) return s;
      const { cl, sec, name } = r;
      const fin = 'fin' in r ? r.fin : s.finishLine;
      const { laps, bestLapIndex, theoreticalBestTime, sectors: lapSectors } = extractLaps(s.points, cl, sec, fin);
      const { finishLine: _old, ...rest } = s;
      return {
        ...rest, laps, bestLapIndex, theoreticalBestTime, controlLine: cl, sectors: lapSectors,
        ...(fin ? { finishLine: fin } : {}),
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

  // 基準車 (Car 1) を別のログに切り替える (動画に合わせるログを選んだとき、LATER-12)。
  // 周は、今の Car 1 の周と同じ時刻に走った周 (同じ走行を別のロガーで記録したログなら同じ周) を選ぶ。なければベストラップ。
  // 元の Car 1 のログは空いているスロットに移す (空きがなければ外す)
  // auto: アプリが自動で切り替える (記録の細かいログへの付け替え)。そのときは、Car 1 が fromId のログで、
  // アプリが入れた Car 1 のときだけ切り替える (利用者が選んだ Car 1 は変えない)
  const setBaseSession = (sessionId: string, auto?: { fromId: string }) => {
    const list = latestRef.current.sessions;
    const target = list.find(s => s.id === sessionId);
    if (!target || target.laps.length === 0) return;
    setSelectedCars(prev => {
      const car1 = prev.find(c => c.slot === 0);
      if (car1?.sessionId === sessionId) return prev;
      if (auto && (car1?.sessionId !== auto.fromId || car1?.setBy !== 'auto')) return prev;
      const from = list.find(s => s.id === car1?.sessionId);
      const fromLap = from?.laps.find(l => l.lapNumber === car1?.lapNumber);
      let lap = target.laps[target.bestLapIndex] ?? target.laps[0];
      const fs = sessionStartUtcMs(from), ts = sessionStartUtcMs(target);
      if (fromLap && fs !== null && ts !== null) {
        const want = fs + fromLap.startTime * 1000;
        const near = [...target.laps].sort((a, b) => Math.abs(ts + a.startTime * 1000 - want) - Math.abs(ts + b.startTime * 1000 - want))[0];
        if (near && Math.abs(ts + near.startTime * 1000 - want) < 10000) lap = near;
      }
      const COLORS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b'];
      const rest = prev.filter(c => c.slot !== 0 && c.sessionId !== sessionId);
      const next: SelectedCarSlot[] = [...rest, { slot: 0, sessionId, lapNumber: lap.lapNumber, colorHex: COLORS[0], label: `${target.sessionName} (L${lap.lapNumber})`, ...(auto ? { setBy: 'auto' as const } : {}) }];
      if (car1) {
        const free = [1, 2, 3].find(slot => !next.some(c => c.slot === slot));
        if (free !== undefined) next.push({ ...car1, slot: free, colorHex: COLORS[free] });
      }
      return next.sort((a, b) => a.slot - b.slot);
    });
  };

  // ログの時計の補正 (BUG-08)。そのログに時刻を付けた動画 (そのログで合わせた動画・そのログの GPS の動画) は一緒に動き、
  // ほかの動画は動かない (mediaClock.ts)。動画のずれを直す処理は要らない
  const setSessionClockOffset = (sessionId: string, sec: number) => {
    const s = latestRef.current.sessions.find(x => x.id === sessionId);
    if (!s || !Number.isFinite(sec)) return;
    const value = Number(sec.toFixed(3));
    if (value === (s.clockOffsetSec ?? 0)) return;
    setSessions(prev => prev.map(x => (x.id === sessionId ? { ...x, clockOffsetSec: value } : x)));
  };

  // 同期プロジェクトから戻した動画の照合先を、後から読み込んだログに読み替え、保存したときのログの時計の補正も戻す。
  // 動画のウインドウが隠れていても (Freeze で描き直さない) 戻すよう、ここで行う
  useEffect(() => {
    for (const [id, sec] of videoSyncManager.remapImportedSessions(sessions)) setSessionClockOffset(id, sec);
  }, [sessions]);

  // 時計の補正を、同じ時間に記録したほかのログ (基準車のログ、なければ記録の細かいログ) との位置の比べから見積もる (BUG-08)。
  // 同じ走行と確かめられたログだけと比べる。確かな見積もり (quality 'auto') だけをそのまま入れ、ほかは案として返す
  const estimateSessionClockOffset = async (sessionId: string): Promise<ClockEstimateResult | string> => {
    const list = latestRef.current.sessions;
    const s = list.find(x => x.id === sessionId);
    if (!s) return tr('ログが見つかりません', 'Log not found');
    const candidates = referenceCandidates(s, list, baseSession?.id);
    if (candidates.length === 0) return tr('同じ時間に記録したほかのログがありません (1 分以上重なるログが要ります)', 'No other log covers the same time (at least 1 minute of overlap is needed)');
    let shortOnly = true;
    for (const ref of candidates) {
      const r = await analyseSessions(ref, s);
      if (r && r.reason !== 'short') shortOnly = false;
      if (!r || !r.sameRun || r.quality === 'reject') continue;
      // 見積もりは 2 つのログの時刻 (補正前) どうしの差。基準のログの補正を足すと、このログの補正になる
      const value = Number(((ref.clockOffsetSec ?? 0) + r.offsetSec).toFixed(3));
      if (r.quality === 'auto') setSessionClockOffset(sessionId, value);
      return { refName: ref.sessionName, offsetSec: value, medianDistanceM: r.medianDistanceM, quality: r.quality, applied: r.quality === 'auto' };
    }
    return shortOnly
      ? tr('走っている区間が短く、見積もれませんでした', 'Too little driving in common to estimate')
      : tr('同じ時間のログはありますが、同じ車の走行ではないようです (走った線や止まった時刻が合いません)', 'Other logs cover this time, but they do not seem to be the same car (the lines or stops do not match)');
  };

  // ログが増えたら、動画を、時間の重なるログのうち記録の細かい (Hz の高い) ログに付け替える (LATER-12)。
  // Car 1 が付け替える前のログなら、Car 1 も付け替える
  // 動画がログより後に加わったとき (ログと動画を一緒に読み込んだとき) も同じにする
  const sessionCountRef = useRef(0);
  const videoCountRef = useRef(0);
  useEffect(() => {
    const grew = sessions.length > sessionCountRef.current || videoTracks.length > videoCountRef.current;
    sessionCountRef.current = sessions.length;
    videoCountRef.current = videoTracks.length;
    if (!grew) return;
    // 同じ走行かを確かめてから付け替える (時刻が重なるだけのチームメイトのログには付け替えない)。比べは Web Worker で行う
    videoSyncManager.preferHighestRateSessions(sessions, isSameRun).then(changed => {
      for (const [from, to] of changed) setBaseSession(to, { fromId: from });
    });
  }, [sessions, videoTracks.length]);

  // サーキットプリセット選択。当てはめなかったときは false
  const handleSelectCircuitPreset = (presetId: string): boolean => {
    const p = CIRCUIT_PRESETS.find(c => c.id === presetId);
    if (!p) return false;
    // そのコースの近く (15 km 以内) のログだけに反映する。近くのログがなければ、基準車のセッションに反映する (利用者の指定を優先)
    const near = (s: Session) => passesNearPoint(s.points, p.centerLat, p.centerLon, COURSE_MATCH_RADIUS_M);
    // 読み込んだログがどれもそのコースを走っていないときは、当てはめる前に確かめる。
    // 違うコースの計測線は一度も通らないので、周回を区切れず、ログ全体が 1 周になる (issue #17)
    const loaded = latestRef.current.sessions;
    if (loaded.length > 0 && !loaded.some(near)) {
      const name = circuitLabel(p.name);
      const ok = window.confirm(tr(
        `読み込んだログに、「${name}」の近くを走ったものがありません。\n当てはめると計測線を通らないため、周回を区切れず、ログ全体が 1 周として表示されます。\n\nそれでも基準車のログに当てはめますか？`,
        `None of the loaded logs was driven near "${name}".\nIf you apply it, the timing line is never crossed, so laps cannot be split and the whole log is shown as one lap.\n\nApply it to the reference car's log anyway?`
      ));
      if (!ok) return false;
    }
    const ids = targetSessionIds(near);
    // 計測線を持たないプリセット (名阪) では、各セッションの計測線 (仮の計測線・コース編集で置いた線) を残す
    const keepLine = (s?: Session) => p.controlLine ?? s?.controlLine;
    const first = latestRef.current.sessions.find(s => s.id === ids[0]);
    setCourseHint({ cl: keepLine(first), sec: p.sectors, name: p.name, fin: p.finishLine });
    recalcSessions(s => (ids.includes(s.id) ? { cl: keepLine(s), sec: p.sectors, name: p.name, fin: p.finishLine } : null));
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
    return true;
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
      finishLine={currentFinishLine}
      sectors={currentSectors}
      pathPolylines={currentPthPolylines}
      currentDistance={currentDistanceKm}
      currentTime={currentTimeSec}
      compareAxis={compareAxis}
      onSeekDistance={handleSeekDistance}
      circuitName={baseSession?.circuitName}
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
    <CornerAnalysisWindow cars={activeCars} currentDistance={currentDistanceKm} onSeekDistance={handleSeekDistance} circuitName={baseSession?.circuitName} />
  );
  const brakingEl = (
    <BrakingAnalysisWindow cars={activeCars} currentDistance={currentDistanceKm} onSeekDistance={handleSeekDistance} />
  );
  const xyEl = <XYGraphWindow cars={activeCars} currentDistance={currentDistanceKm} />;

  // 開発サーバーだけ: 画面の通しの試験 (e2e/) と、画面を触って調べる道具が、今の様子を読むための窓口 (公開版には入らない)
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as unknown as { __laploupe?: unknown }).__laploupe = {
      screen: currentTab,
      // 寸法の試験で、全部の画面を順に開くため
      available: [...plan.available],
      go: (s: Parameters<typeof navStore.go>[0]) => navStore.go(s),
      // 走行とコースの引き出しの Car の割り当てと同じ (比べるを開いたまま Car を替える試験のため)
      selectCar: (slot: number, sessionId: string, lapNumber: number) => handleSelectCarSlot(slot, sessionId, lapNumber),
      clockBase,
      currentTimeSec,
      isPlaying,
      sessions: sessions.map(x => ({ id: x.id, fileName: x.fileName, sessionName: x.sessionName, circuitName: x.circuitName, laps: x.laps.length })),
      cars: selectedCars.map(c => ({ slot: c.slot, sessionId: c.sessionId, lapNumber: c.lapNumber })),
      baseLap: baseLap ? { lapNumber: baseLap.lapNumber, startTime: baseLap.startTime, lapTime: baseLap.lapTime, isWholeSession: !!baseLap.isWholeSession } : null,
      videos: placedVideos.map(v => ({ fileName: v.fileName, syncOffsetSec: v.syncOffsetSec, isPlaced: v.isPlaced, matchedSessionId: v.matchedSessionId }))
    };
  }

  return (
    <div
      className="relative flex flex-col h-dvh w-screen overflow-hidden bg-surface-0 text-slate-100"
      // ファイルは、どの画面に落としても読み込む (受け口のない所に落とすと、ブラウザ・Electron がそのファイルを開いてアプリの画面から離れてしまう)。
      // 動画同期・ログ変換の受け口が受け取ったもの (preventDefault 済み) は、ここでは読まない。
      // リンク・文字を落としたときも、ブラウザがそちらへ移らないよう止める (入力欄に落とす文字はそのまま)
      onDragEnter={e => { if (e.dataTransfer.types.includes('Files')) { dragDepthRef.current++; setFileDragOver(true); } }}
      onDragLeave={e => {
        if (!e.dataTransfer.types.includes('Files')) return;
        // ウインドウの外へ出たとき (relatedTarget がない) は、数え残しがあっても消す
        if (--dragDepthRef.current <= 0 || !e.relatedTarget) { dragDepthRef.current = 0; setFileDragOver(false); }
      }}
      onDragOver={e => { if (e.dataTransfer.types.includes('Files') || !isTextField(e.target)) e.preventDefault(); }}
      onDrop={e => {
        dragDepthRef.current = 0;
        setFileDragOver(false);
        if (e.defaultPrevented || (isTextField(e.target) && e.dataTransfer.files.length === 0)) return;
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) loadFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {fileDragOver && (
        <div className="absolute inset-0 z-[60] pointer-events-none border-4 border-dashed border-red-500/70 bg-black/30 flex items-center justify-center">
          <span className="px-4 py-2 rounded-lg bg-surface-2 border border-line-3 text-sm font-bold text-slate-100 shadow-lg">{T('ドロップして読み込む', 'Drop to load')}</span>
        </div>
      )}
      {/* 非表示ファイル入力 */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFilesSelected}
        multiple
        accept={fileAccept('.dtb,.bnx4,.bon4,.binx,.bon,.csv,.txt,.nmea,.log,.vbo,.gpx,.xrk,.xrz,.ibt,.fit,.tcx,.mp4,.mov,.lrv')}
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
            setCourseHint({ cl, sec: target?.sectors ?? [], name: target?.circuitName ?? '', fin: target?.finishLine, polylines: target ? target.pathPolylines : courseRef.current.polylines, polylinesSource: target ? target.pathPolylinesSource : courseRef.current.polylinesSource });
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
              return isUser(m) ? { cl: m!.controlLine ?? s.controlLine, sec: m!.sectors, name: m!.name, fin: m!.finishLine } : null;
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

      {/* 外枠: デスクトップ版・iPad は左のサイドバー、ヘッダーと中身と再生の段はその右 */}
      <div className="flex-1 min-h-0 flex flex-row">
      {plan.chrome === 'sidebar' && !nav.locked && (
        <Sidebar
          items={plan.primary}
          // データは解析の「走行とコース」から開くので、サイドバーには並べない
          bottom={plan.more.filter(s => s !== 'data')}
          current={currentTab}
          // 設定をもう一度押したら閉じる (来た画面へ戻る)
          onSelect={s => (s === 'settings' && currentTab === 'settings' ? navStore.back() : navStore.go(s))}
          badges={{ data: sessions.length }}
        />
      )}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      {/* ヘッダー (iPhone のアプリのタイマーのタブでは出さない。タイマーが上の段を持つ) */}
      {!(currentTab === 'timer' && profile.kind === 'app-phone') && <Header
        plan={plan}
        screen={currentTab}
        badges={{ data: sessions.length }}
        onOpenFile={openRunsOrFiles}
        onOpenDonate={canDonate ? () => setIsDonateModalOpen(true) : undefined}
        compact={isCompact}
        dataOpen={dataDrawerOpen}
        onToggleData={() => setDataDrawer(o => !o)}
      />}

      {/* メインコンテンツ */}
      <main className={`relative flex-1 overflow-hidden ${isCompact ? 'p-2' : 'p-3'}`}>
        {/* ログを読み込む前のグラフ解析: 読み込み方を案内する (何もない画面で、どうすればよいか分からないため) */}
        {currentTab === 'analysis' && sessions.length === 0 && (
          // 後ろの空のグラフ・コース図は隠す (動画・変換の画面と同じ見た目にする)
          <div className="absolute inset-0 z-40 bg-surface-0">
            <EmptyLoadPrompt
              title={T('走行ログを読み込む', 'Load a driving log')}
              text={isCompact
                // スマートフォンではファイルを落とせないので、ボタンだけを案内する
                ? T('ロガーのログ (.bnx4 / .bon4 / .dtb)・NMEA・CSV・VBO・GPX・AiM・iRacing・GoPro の動画を、ボタンから選んでください。',
                  'Choose a logger file (.bnx4 / .bon4 / .dtb), NMEA, CSV, VBO, GPX, AiM, iRacing or GoPro video with the button.')
                : T('ロガーのログ (.bnx4 / .bon4 / .dtb)・NMEA・CSV・VBO・GPX・AiM・iRacing・GoPro の動画を、ここにドロップするか、ボタンから選んでください。',
                  'Drop a logger file (.bnx4 / .bon4 / .dtb), NMEA, CSV, VBO, GPX, AiM, iRacing or GoPro video here, or choose one with the button.')}
              buttonLabel={T('ファイルを選ぶ', 'Choose files')}
              onClick={() => fileInputRef.current?.click()}
            >
              {canUseRunStore() && <RecentRunsList limit={5} onOpen={r => void openRun(r)} onShowAll={showAllRuns} busy={runBusy} />}
            </EmptyLoadPrompt>
          </div>
        )}
        {/* 計測線はあるのに周回を区切れず、ログ全体を 1 周として表示しているときの注意 (違うコースを当てはめた・計測線がコースの外にあるなど。issue #17) */}
        {currentTab === 'analysis' && baseLap?.isWholeSession && baseSession?.controlLine && wholeLapNoticeClosed !== baseSession.id && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 w-max max-w-[calc(100%-2rem)] flex items-start gap-2 px-3 py-2 rounded-lg text-xs text-amber-200 bg-surface-2/95 border border-amber-500/50 shadow-lg">
            <span>
              {T('計測線を 2 回以上通過していないため、周回を区切れず、ログ全体を 1 周として表示しています。データ管理で、コースと計測線の位置を確認してください。',
                'The timing line was not crossed twice or more, so laps could not be split and the whole log is shown as one lap. Check the course and the timing line position in Data.')}
            </span>
            <button onClick={() => setWholeLapNoticeClosed(baseSession.id)} className="shrink-0 text-amber-300 hover:text-amber-100 cursor-pointer" title={T('閉じる', 'Close')} aria-label={T('閉じる', 'Close')}>×</button>
          </div>
        )}
        {/* グラフ解析タブ */}
        {isCompact ? (
          // スマートフォン: 速度ウインドウを上 (横向きでは左) に固定し、もう片方は切り替えて 1 つずつ表示する
          <div className={`h-full w-full gap-2 overflow-hidden ${currentTab === 'analysis' ? 'flex' : 'hidden'} ${isLandscape ? 'flex-row' : 'flex-col'}`}>
            <Freeze active={currentTab === 'analysis'}>
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
                {([['map', trackMapEl], ['replay', replayEl], ['gg', frictionEl], ['corner', cornerEl], ['braking', brakingEl], ['xy', xyEl], ['drift', driftEl]] as const)
                  .filter(([id]) => MOBILE_PANELS.some(p => p.id === id))
                  .map(([id, el]) => (
                    <div key={id} className={mobilePanel === id ? 'h-full' : 'hidden'}>
                      {el}
                    </div>
                  ))}
              </div>
            </div>
            </Freeze>
          </div>
        ) : (
          <div
            ref={horizSplit.containerRef}
            className={`flex-row h-full w-full overflow-hidden select-none ${currentTab === 'analysis' ? 'flex' : 'hidden'}`}
          >
            <Freeze active={currentTab === 'analysis'}>
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
                      isVisible={currentTab === 'analysis'}
                      playbackSpeed={playbackSpeed}
                      onChangePlaybackSpeed={setPlaybackSpeed}
                      onChooseLog={setBaseSession}
                      onPickCompareLap={(sessionId, lapNumber) => handleSelectCarSlot(1, sessionId, lapNumber)}
                      onLoadFiles={loadFiles}
                      viewKey="graph-a"
                      onSetClockOffset={setSessionClockOffset}
                      compareCars={activeCars}
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
                  {/* 入りきらないタブは横にスクロールする (スクロールバーは出さないので、マウスのホイールでも動かせるようにする) */}
                  <div ref={subTabsScrollRef} className="flex gap-1 overflow-x-auto no-scrollbar min-w-0">
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
                    onClick={() => { setSubWindowMode('xy'); toggleCollapsed('sub', false); }}
                    className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                      subWindowMode === 'xy'
                        ? 'bg-teal-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {T('X/Y グラフ', 'X/Y graph')}
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
                  {subWindowMode === 'xy' && (
                    xyEl
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
                      isVisible={currentTab === 'analysis'}
                      playbackSpeed={playbackSpeed}
                      onChangePlaybackSpeed={setPlaybackSpeed}
                      onChooseLog={setBaseSession}
                      onPickCompareLap={(sessionId, lapNumber) => handleSelectCarSlot(1, sessionId, lapNumber)}
                      onLoadFiles={loadFiles}
                      viewKey="graph-b"
                      // 左下にも車載動画を出しているときは、こちらの音を消す (同じ動画の音が二重になるため)
                      muted={leftBottomMode === 'video' && !collapsed.anim}
                      onSetClockOffset={setSessionClockOffset}
                      compareCars={activeCars}
                    />
                  )}
                </div>
                )}
              </div>
            </div>
            </Freeze>
          </div>
        )}

        {/* 動画同期タブ。見えていないときは動画を止め、10 秒たったら動画を手放す (VideoTile) */}
        <div className={`h-full w-full overflow-hidden ${currentTab === 'video' ? 'block' : 'hidden'}`}>
          <Freeze active={currentTab === 'video'}>
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
            onChooseLog={setBaseSession}
            onPickCompareLap={(sessionId, lapNumber) => handleSelectCarSlot(1, sessionId, lapNumber)}
            onLoadFiles={loadFiles}
            viewKey="video-tab"
            onSetClockOffset={setSessionClockOffset}
            compareCars={activeCars}
          />
          </Freeze>
        </div>

        {/* データ管理タブ */}
        {/* データ (走行とコース): データの画面として出すか、解析の上に引き出しとして出す (中身は 1 つ。作り直さない) */}
        <div className={`overflow-hidden ${currentTab === 'data'
          ? 'h-full w-full block'
          : dataDrawerOpen
            ? `absolute z-[45] bg-surface-0 flex flex-col ${isCompact ? 'inset-0' : 'left-0 top-0 bottom-0 w-[460px] max-w-[92%] border-r border-line-2 shadow-2xl'}`
            : 'hidden'}`} data-testid={dataDrawerOpen ? 'data-drawer' : undefined}>
          {dataDrawerOpen && (
            <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-line-2">
              <span className="text-sm font-bold text-slate-200 flex-1">{T('走行とコース', 'Runs & course')}</span>
              <button onClick={() => setDataDrawer(false)} className="p-1.5 rounded hover:bg-surface-3 text-slate-400 cursor-pointer" aria-label={T('閉じる', 'Close')} data-testid="data-drawer-close"><X size={18} /></button>
            </div>
          )}
          <div className={dataDrawerOpen ? 'flex-1 min-h-0 overflow-auto' : 'h-full w-full'}>
          <Freeze active={currentTab === 'data' || dataDrawerOpen}>
          <DataTab
            sessions={sessions}
            onOpenLapRun={file => { setDataDrawer(false); void loadFiles([file]).then(() => navStore.go('analysis')); }}
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
              navStore.go('convert');
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
            onSetClockOffset={setSessionClockOffset}
            onEstimateClockOffset={estimateSessionClockOffset}
            onSelectCircuitPreset={handleSelectCircuitPreset}
            onOpenCircuitEditor={() => setIsCircuitEditorOpen(true)}
            onLoadPthFile={() => pthInputRef.current?.click()}
            onLoadClnFile={() => clnInputRef.current?.click()}
            onLoadCircuitFolder={() => folderInputRef.current?.click()}
            onOpenFile={() => fileInputRef.current?.click()}
            gFilterLevel={gFilterLevel}
            onChangeGFilterLevel={handleChangeGFilterLevel}
          />
          </Freeze>
          </div>
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

        {/* ロガー設定タブ (マウント状態を維持し、USBシリアル切断を防止)。USB も Bluetooth も使えない環境では出さない */}
        {canUseLogger && (
          <div className={`h-full w-full overflow-hidden ${currentTab === 'logger' ? 'block' : 'hidden'}`}>
            <Freeze active={currentTab === 'logger'}>
            <LoggerTab
              // 落としたログも、保管場所があれば走行ごとに分けて取り込むかを聞く (聞いたときは、開く・開かないはシートの中で決まる)
              onLoadSession={async (fileName, buffer) => {
                if (await offerImport(fileName, buffer)) return false;
                await loadFileData(fileName, buffer);
                return true;
              }}
              onNavigateToGraph={() => navStore.go('analysis')}
              active={currentTab === 'logger'}
              onOpenLapTimer={() => navStore.go('timer')}
            />
            </Freeze>
          </div>
        )}

        {/* 走行 (保管場所の一覧)・設定。開いたときだけ作る */}
        {plan.available.has('library') && (
          <LibraryScreen
            active={currentTab === 'library'}
            wide={profile.layout === 'wide'}
            onOpen={r => void openRun(r)}
            // 動画を見る: 走行を開いて (動画と同期もそろう)、動画の画面へ
            onOpenVideo={r => void openRun(r).then(() => navStore.go('video'))}
            // 走行がもう開いているときだけ、比べる相手として足せる
            onAddAsCar2={sessions.length > 0 ? (r => void addRunAsCar2(r)) : undefined}
            // 比べられるのは Car 1 と同じコースの走行だけ
            car1Course={baseSession?.circuitName ?? null}
            car1Run={baseSession ? ([...runSessionsRef.current].find(([, ids]) => ids.includes(baseSession.id))?.[0] ?? null) : null}
            onPickFiles={() => fileInputRef.current?.click()}
            onOpenFile={file => { void loadFiles([file]).then(() => navStore.go('analysis')); }}
            canTime={plan.available.has('timer') && profile.host === 'native'}
            busy={runBusy}
          />
        )}
        {currentTab === 'settings' && <SettingsScreen plan={plan} onOpenDonate={canDonate ? () => setIsDonateModalOpen(true) : undefined} />}

        {/* ラップタイマー。iPhone のアプリではタブの 1 つ (測っていない間はタブバーの上に収める)、ほかでは画面いっぱいに重ねる。
            ほかの画面へ行くと閉じる (Bluetooth・画面のロック止め・向きの固定も外れる。作る順番の 4 で、測るのを画面の外へ出す) */}
        {currentTab === 'timer' && canUseLapTimer && (
          <LapTimerScreen
            embedded={profile.kind === 'app-phone'}
            onMeasuringChange={on => navStore.setLocked(on)}
            onClose={() => navStore.back()}
            replayLogs={sessions.map((s): ReplayLog => ({ id: s.id, name: s.sessionName || s.fileName, points: s.points, startDate: s.points[0]?.timestamp ? new Date(s.points[0].timestamp) : undefined }))}
            // ラップタイムの記録から解析で開く (測っている途中でも、これまでどおりタイマーを閉じて開く)
            onOpenLog={(fileName, text) => {
              void loadFileData(fileName, null, parseNmea(text)).then(() => { navStore.setLocked(false); navStore.go('analysis'); });
            }}
            onOpenFile={file => {
              void loadFiles([file]).then(() => { navStore.setLocked(false); navStore.go('analysis'); });
            }}
          />
        )}
      </main>

      {/* グラフ解析の再生の段 (シークバーと再生のボタン。動画同期の画面の下の段と同じ並び)。スマートフォンでは、この下にタブバー */}
      {currentTab === 'analysis' && baseLap && (
        <PlayBar
          label={baseLap.isWholeSession ? tr('全体', 'All') : `L${baseLap.lapNumber}`}
          currentTime={currentTimeSec}
          endTime={playEndTime}
          isPlaying={isPlaying}
          onTogglePlay={() => setIsPlaying(!isPlaying)}
          onSeekTime={handleSeekTime}
          onStepBack={() => handleStep(-0.1)}
          onStepForward={() => handleStep(0.1)}
          playbackSpeed={playbackSpeed}
          onChangePlaybackSpeed={setPlaybackSpeed}
          compact={isCompact}
        />
      )}
      </div>
      </div>
      {plan.chrome === 'bottom' && !nav.locked && (
        <BottomTabBar items={plan.primary} current={currentTab} onSelect={s => navStore.go(s)} badges={{ data: sessions.length }} />
      )}

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
        finishLine={currentFinishLine}
        onSavedCircuitsChange={() => setUserCircuitCount(userCircuitStorage.getCircuitCount())}
        onSaveCircuit={(name, cl, sec, remember, extra) => {
          // アプリに保存して、次から同じ場所のログに使う (閉じても消えない)
          if (remember) {
            userCircuitStorage.saveEditedCircuit(name, cl, sec, baseSession && passesNearControlLine(baseSession.points, cl) ? baseSession.pathPolylines : undefined, extra).then(r => {
              if (!r.saved) alert(`${tr('コースを保存できませんでした (この画面には反映しています)', 'Could not save the course (it is applied on this screen)')}: ${r.saveError ?? ''}`);
              setUserCircuitCount(userCircuitStorage.getCircuitCount());
            });
          }
          // 編集したコースは、その計測線を通過したログに反映する。なければ基準車のセッションに反映する
          // (近くを走っただけのログ (筑波 2000 を直したときの 1000 のログなど) には反映しない)
          const ids = targetSessionIds(s => !!cl && countGateCrossings(s.points, cl) > 0);
          // ログを読み込む前に保存したときも、画面と次に読み込むログに使う (コース図は反映したセッションのものを引き継ぐ)
          const target = latestRef.current.sessions.find(s => s.id === ids[0]);
          setCourseHint({ cl, sec, name, fin: extra.finishLine, polylines: target ? target.pathPolylines : courseRef.current.polylines, polylinesSource: target ? target.pathPolylinesSource : courseRef.current.polylinesSource });
          recalcSessions(s => (ids.includes(s.id) ? { cl, sec, name, fin: extra.finishLine } : null));
        }}
      />
      )}

      {/* 開発支援 (Buy Me a Coffee) モーダル */}
      <ChoiceDialogHost />
      {runDownload && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-[56] max-w-[90vw] flex items-center gap-2 px-3 py-2 rounded-full bg-surface-2/95 border border-sky-500/50 text-xs text-sky-200 shadow-lg" data-testid="run-download">
          <span className="w-3 h-3 rounded-full border-2 border-sky-400 border-t-transparent animate-spin shrink-0" />
          <span className="truncate">
            {T(`動画をダウンロード中… (${runDownload.done}/${runDownload.names.length})`, `Downloading video… (${runDownload.done}/${runDownload.names.length})`)}
          </span>
        </div>
      )}
      {runsSheetOpen && (
        <RunsSheet
          onClose={() => setRunsSheetOpen(false)}
          onOpen={r => void openRun(r)}
          onPickFiles={() => { setRunsSheetOpen(false); fileInputRef.current?.click(); }}
          busy={runBusy}
        />
      )}
      {importing && (
        <ImportSheet
          plan={importing.plan}
          phase={importing.phase}
          progress={importing.progress}
          results={importing.results}
          onToggle={id => setImporting(s => (s && s.phase === 'confirm' ? { ...s, plan: { ...s.plan, parts: s.plan.parts.map(p => (p.id === id ? { ...p, checked: !p.checked } : p)) } } : s))}
          onApply={() => void applyImport()}
          onOpenOnly={() => void openImported()}
          onOpenAfter={() => void openImported()}
          onClose={closeImport}
        />
      )}
      {inApp ? (
        <TipModal isOpen={isDonateModalOpen} onClose={() => setIsDonateModalOpen(false)} />
      ) : (
      <DonateModal
        isOpen={isDonateModalOpen}
        onClose={() => setIsDonateModalOpen(false)}
      />
      )}
    </div>
  );
};
export default App;
