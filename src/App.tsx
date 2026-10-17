import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { CompareAxis, Lap, Session, SelectedCarSlot, ControlLine, Sector, CircuitPreset } from './types/telemetry';
import { parseDtb } from './services/dtbParser';
import { parseDigispiceRawBinary } from './services/rawBinaryParser';
import { parseCsv } from './services/csvParser';
import { parseNmea } from './services/nmeaParser';
import { MOTEC_CSV_ENABLED, isGpx, isMotecCsv, isRaceChronoCsv, isVbo, parseMotecCsv, parseGpx, parseRaceChronoCsv, parseVbo } from './services/externalFormats';
import { parsePth, parseCln } from './services/pthParser';
import { createVirtualControlLine, extractLaps, firstGateCrossingTime, passesNearControlLine, passesNearPoint } from './services/lapCalculator';
import { ConvertTab } from './components/ConvertTab';
import { CIRCUIT_PRESETS, ALL_CIRCUITS, findMatchingCircuit, resolveCircuitPolylines } from './services/circuitDatabase';
import { userCircuitStorage } from './services/userCircuitStorage';

import { Header } from './components/Header';
import { SpeedGraphWindow } from './components/SpeedGraphWindow';
import { TrackMapWindow } from './components/TrackMapWindow';
import { ReplayWindow } from './components/ReplayWindow';
import { FrictionCircleWindow } from './components/FrictionCircleWindow';
import { DriftWindow } from './components/DriftWindow';
import { CornerAnalysisWindow } from './components/CornerAnalysisWindow';
import { BrakingAnalysisWindow } from './components/BrakingAnalysisWindow';
import { VideoSyncWindow } from './components/VideoSyncWindow';
import { DataTab } from './components/DataTab';
import { LoggerTab } from './components/LoggerTab';
import { CircuitEditorModal } from './components/CircuitEditorModal';
import { DonateModal } from './components/DonateModal';
import { useResizableSplit } from './hooks/useResizableSplit';
import { SplitResizer } from './components/SplitResizer';
import { exportSessionToNmea, triggerFileDownload } from './services/nmeaExporter';
import { interpolatePoint } from './utils/telemetrySearch';

// コースのプリセットを、近くのログだけに反映するときの範囲 (自動判定と同じ 15 km)
const COURSE_MATCH_RADIUS_M = 15000;
// 空の値は毎回同じものを渡す (描画の再計算を減らすため)
const NO_SECTORS: Sector[] = [];
const NO_POLYLINES: Array<Array<[number, number]>> = [];

export const App: React.FC = () => {
  // タブ
  // 公開ページでは URL の末尾 (#convert など) で最初に開くタブを指定できる
  const [currentTab, setCurrentTab] = useState<'graph' | 'data' | 'logger' | 'video' | 'convert'>(() => {
    const h = typeof window !== 'undefined' ? window.location.hash.replace('#', '') : '';
    return h === 'convert' || h === 'data' || h === 'logger' || h === 'video' ? h : 'graph';
  });
  const currentTabRef = useRef(currentTab);
  currentTabRef.current = currentTab;

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
  type CourseHint = { cl?: ControlLine; sec: Sector[]; name: string; polylines?: Array<Array<[number, number]>> };
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

  // 1 周の長さを基準車にそろえる (ロガーごとの距離の測り方の差を吸収する)
  const [alignLapLength, setAlignLapLength] = useState(false);

  // セクターにそろえるときの、比較車両の時刻のずらし量 (秒)。そろえていなければ 0、線を通過していなければ undefined
  const alignGate = alignedSector !== null ? currentSectors[alignedSector] : undefined;
  const baseAlignTime = alignGate && baseLap ? firstGateCrossingTime(baseLap.points, alignGate) : undefined;
  const alignShiftOf = (lap: Lap): number | undefined => {
    if (!alignGate) return 0;
    const t = firstGateCrossingTime(lap.points, alignGate);
    return t !== undefined && baseAlignTime !== undefined ? t - baseAlignTime : undefined;
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
      // セクターにそろえるときは、そのセクター線を通った時刻が基準車と同じになるよう時刻をずらす。
      // 線は基準車のセッションのもの (表示中のセクター) を使い、各車の軌跡が通った時刻を直接求める
      // (比較車両のセッションに同じセクターがない・数が違う場合でもそろえられるように)
      const shiftSec = alignShiftOf(lap) ?? 0;
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
    .filter(Boolean) as { slot: SelectedCarSlot; lap: Lap }[], [selectedCars, sessions, baseSelected?.slot, baseLap, alignLapLength, alignGate, baseAlignTime]);

  // そろえていて、時刻をずらせなかった比較車両の数 (セクター線を通過していない周など)。表示に出す
  const alignFailedCount = alignedSector === null ? 0 : [...selectedCars]
    .filter(c => c.slot !== baseSelected?.slot)
    .map(c => findLap(c))
    .filter(l => l && alignShiftOf(l) === undefined).length;

  const handleSetDistanceOffset = (slotIndex: number, offsetM: number) => {
    setSelectedCars(prev => prev.map(c => (c.slot === slotIndex ? { ...c, distanceOffsetM: offsetM } : c)));
  };

  // アニメーションループ (requestAnimationFrame)
  const animRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(performance.now());

  useEffect(() => {
    // 動画表示時は <video> 要素が再生マスターとなるため、lapTimeでのrequestAnimationFrameループは停止する
    const isVideoModeActive = currentTab === 'video' || (currentTab === 'graph' && (leftBottomMode === 'video' || subWindowMode === 'video'));
    if (!isPlaying || !baseLap || isVideoModeActive) {
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
        if (nextTime > baseLap.lapTime) {
          nextTime = 0; // ループ
          // 周の始めに戻ったら、セクターにそろえるのをやめ、全車を計測線から同時に走らせる
          setAlignedSector(null);
        }

        // タイムに対応する距離を計算 (O(log N) 二分探索)
        const pts = baseLap.points;
        const curPt = interpolatePoint(pts, 'time', nextTime);

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
  }, [isPlaying, playbackSpeed, baseLap, currentTab, subWindowMode, leftBottomMode]);

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
  }, [baseLap, baseSession, currentTab]);

  // Electron ネイティブメニューからのファイルオープン受信
  useEffect(() => {
    const nav = window as any;
    const unsubscribers: Array<() => void> = [];
    if (nav.electronAPI?.onOpenFiles && nav.electronAPI?.readFileBuffer) {
      const off = nav.electronAPI.onOpenFiles(async (filePaths: string[]) => {
        for (const fp of filePaths) {
          try {
            const res = await nav.electronAPI.readFileBuffer(fp);
            if (res.success) {
              const buffer = new Uint8Array(res.dataArray).buffer;
              // 最新のコース設定で読み込む (登録時点の関数を使い続けない)
              await loadFileDataRef.current(res.name, buffer);
            } else {
              alert(`ファイルの読み込みに失敗しました: ${res.error}`);
            }
          } catch (err: any) {
            console.error('Electron file open error:', err);
            alert(`ファイルの読み込みに失敗しました: ${err?.message || err}`);
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
    if (!baseLap) return;
    setIsPlaying(false);
    setCurrentTimeSec(prev => {
      // 動画タブではセッション全体の時間、それ以外では選択中ラップの時間が上限
      const sessionEnd = baseSession?.points.length ? baseSession.points[baseSession.points.length - 1].time : 99999;
      const maxLimit = currentTab === 'video' ? sessionEnd : baseLap.lapTime;
      const next = Math.max(0, Math.min(maxLimit, prev + stepSec));
      const pts = (currentTab === 'video' ? baseSession?.points : baseLap?.points) || baseSession?.points;
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
    const pts = (currentTab === 'video' ? baseSession?.points : baseLap?.points) || baseSession?.points;
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

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        await loadFileData(file.name, await file.arrayBuffer());
      } catch (err: any) {
        alert(`ファイル ${file.name} の読み込みに失敗しました: ${err.message}`);
      }
    }
    e.target.value = '';
  };

  // データファイル読み込みロジック
  const loadFileData = async (fileName: string, buffer: ArrayBuffer) => {
    let rawPoints: any[] = [];
    let samplingRate = 10;
    let startDate: Date | undefined;

    const ext = fileName.split('.').pop()?.toLowerCase();

    if (ext === 'dtb') {
      const parsed = parseDtb(buffer);
      rawPoints = parsed.points;
      samplingRate = parsed.samplingRate;
      startDate = parsed.startDate;
    } else if (ext === 'bnx4' || ext === 'bon4' || ext === 'binx' || ext === 'bon') {
      const parsed = parseDigispiceRawBinary(fileName, buffer);
      rawPoints = parsed.points;
      samplingRate = parsed.samplingRate;
      startDate = parsed.startDate;
    } else if (['vbo', 'csv', 'txt', 'gpx', 'nmea', 'log'].includes(ext || '')) {
      // テキストの形式は拡張子で決めつけず、中身の先頭で判別する (.txt の NMEA・VBO、.log の CSV なども読めるように)。
      // 判別できないときは拡張子に従う
      const text = new TextDecoder('utf-8').decode(buffer);
      // NMEA は受信機の起動時の文などの後から始まることがあるので、先頭から広めに (64 KB) 探す
      const head = text.slice(0, 65536);
      // CSV の見出し行 (緯度・経度の列がある行) があるか
      const csvLike = isRaceChronoCsv(text) || isMotecCsv(text) ||
        /^[^\n]*(lat|緯度)[^\n]*,[^\n]*(lon|lng|経度)/im.test(text.slice(0, 4000));
      const kind =
        isGpx(text) ? 'gpx'
        : isVbo(text) ? 'vbo'
        : /^\s*\$G[PNLAB][A-Z]{3},/m.test(head) ? 'nmea'
        : csvLike ? 'csv'
        : ext === 'vbo' || ext === 'gpx' || ext === 'nmea' ? ext
        : ext === 'log' ? 'nmea'
        : 'csv';
      let parsed: { points: any[]; samplingRate: number; startDate?: Date };
      if (kind === 'gpx') parsed = parseGpx(text);
      else if (kind === 'vbo') parsed = parseVbo(text);
      else if (kind === 'nmea') parsed = parseNmea(text);
      else {
        // 他社形式の CSV は先頭の書式で判別する
        // MoTeC CSV は単位行などの構造が汎用 CSV と違うため、無効の間は汎用の読み込みに回さず断る
        if (isMotecCsv(text) && !MOTEC_CSV_ENABLED) {
          throw new Error('MoTeC CSV の読み込みには現在対応していません');
        }
        parsed = isRaceChronoCsv(text) ? parseRaceChronoCsv(text)
          : isMotecCsv(text) ? parseMotecCsv(text)
          : parseCsv(text);
      }
      rawPoints = parsed.points;
      samplingRate = parsed.samplingRate;
      startDate = parsed.startDate;
    } else {
      throw new Error(`未対応のファイル形式です: .${ext}`);
    }

    if (rawPoints.length === 0) {
      throw new Error('有効なGPS位置データが見つかりませんでした');
    }

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
      ? { cl: samePlace.controlLine, sec: samePlace.sectors, name: samePlace.circuitName, polylines: samePlace.pathPolylines }
      : prev;
    let cl = hint.cl;
    let sec = hint.sec;
    let circName = hint.name;

    if (matchedCircuit) {
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
    const hintPolylines = hint.polylines && passesNearPolylines({ points: rawPoints } as Session, hint.polylines, 2000) ? hint.polylines : undefined;

    // コースが分からず計測線もないときは、このログの走り始めに仮の計測線を置く。
    // 後から読み込むログもこの線の通過点を 0 m にそろえるので、開始位置の違うログを重ねてもずれない
    if (!cl) cl = createVirtualControlLine(rawPoints);
    courseRef.current = { cl, sec, name: circName, polylines: hintPolylines };

    // ラップ分割とセクタータイム計算
    const { laps, bestLapIndex, theoreticalBestTime } = extractLaps(rawPoints, cl, sec);

    const newSession: Session = {
      id: `sess_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      fileName,
      sessionName: fileName.replace(/\.[^/.]+$/, ''),
      date: startDate ? startDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      circuitName: circName,
      samplingRate,
      totalDistance: rawPoints[rawPoints.length - 1].distance,
      points: rawPoints,
      laps,
      bestLapIndex,
      theoreticalBestTime,
      controlLine: cl,
      sectors: sec,
      ...(hintPolylines ? { pathPolylines: hintPolylines } : {})
    };

    setSessions(prev => [...prev, newSession]);
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

    // 変換ページから読み込んだときは、そのまま変換ページに留まる
    if (currentTabRef.current !== 'convert') setCurrentTab('graph');
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
      const { laps, bestLapIndex, theoreticalBestTime } = extractLaps(s.points, cl, sec);
      return {
        ...s, laps, bestLapIndex, theoreticalBestTime, controlLine: cl, sectors: sec,
        ...(name !== undefined ? { circuitName: name } : {})
      };
    });
    const byId = new Map(updated.map(s => [s.id, s]));
    // コース図は非同期に届くので、その間に設定されたものを消さないよう、今の値を引き継ぐ
    setSessions(prev => prev.map(p => {
      const u = byId.get(p.id);
      return u ? { ...u, pathPolylines: p.pathPolylines } : p;
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
  const setSessionPolylines = (ids: string[], polylines: Array<Array<[number, number]>> | undefined) => {
    for (const id of ids) polylineRequestRef.current.set(id, (polylineRequestRef.current.get(id) ?? 0) + 1);
    setSessions(prev => prev.map(s => (ids.includes(s.id) ? { ...s, pathPolylines: polylines } : s)));
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
        tokens.has(s.id) && polylineRequestRef.current.get(s.id) === tokens.get(s.id) ? { ...s, pathPolylines: polylines } : s
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

  // NMEA-0183 (RaceChrono互換) エクスポート
  const handleExportCurrentNmea = () => {
    const targetSession = baseSession || sessions[0];
    if (!targetSession) return;
    const nmea = exportSessionToNmea(targetSession);
    triggerFileDownload(`${targetSession.sessionName}.nmea`, nmea, 'text/plain;charset=utf-8');
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#0f1117] text-slate-100">
      {/* 非表示ファイル入力 */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFilesSelected}
        multiple
        accept=".dtb,.bnx4,.bon4,.binx,.bon,.csv,.txt,.nmea,.log,.vbo,.gpx"
        className="hidden"
      />
      <input
        type="file"
        ref={pthInputRef}
        onChange={async e => {
          const f = e.target.files?.[0];
          if (f) {
            const txt = await f.text();
            const polylines = parsePth(txt);
            // コース図の近く (2 km 以内) を走ったログに設定する。なければ基準車のセッションに設定する
            const ids = targetSessionIds(s => passesNearPolylines(s, polylines, 2000));
            // 手動で読み込んだコース図を、遅れて届いた自動取得の結果で上書きしない
            setSessionPolylines(ids, polylines);
            // ログを読み込む前なら、次に読み込む近くのログに付けるよう覚えておく (画面にもそのまま出す)
            if (ids.length === 0) setCourseHint({ ...courseRef.current, polylines });
          }
          e.target.value = '';
        }}
        accept=".pth"
        className="hidden"
      />
      <input
        type="file"
        ref={clnInputRef}
        onChange={async e => {
          const f = e.target.files?.[0];
          if (f) {
            const txt = await f.text();
            const cl = parseCln(txt, f.name);
            // 計測線の近く (1 km 以内) を走ったログだけに反映する (セクターは各セッションのものを保つ)。
            // 近くのログがなければどのセッションも変えない (別のコースのログの周回が崩れるため)。次に読み込む近くのログで使う
            const ids = latestRef.current.sessions.filter(s => passesNearControlLine(s.points, cl)).map(s => s.id);
            // 次に読むログの手がかりも、計測線を反映したセッションのコースにそろえる (別のコースのセクター・コース名と混ぜない)
            const target = latestRef.current.sessions.find(s => s.id === ids[0]);
            setCourseHint({ cl, sec: target?.sectors ?? [], name: target?.circuitName ?? '' });
            recalcSessions(s => (ids.includes(s.id) ? { cl, sec: s.sectors || [] } : null));
          }
          e.target.value = '';
        }}
        accept=".cln"
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
              r.saved ? 'ユーザーコースデータを登録しました。' : '⚠ ユーザーコースデータを読み込みましたが、保存できませんでした（アプリを閉じると消えます）。',
              `コース: ${r.circuits} 件（コース図あり ${r.withPolylines} 件 / セクターあり ${r.withSectors} 件）`
            ];
            if (r.loosePolylines > 0) lines.push(`コントロールラインと組み合わせられなかったコース図: ${r.loosePolylines} 件（近くの内蔵コースのコース図として使います）`);
            if (r.unusedSectors.length > 0) lines.push(`どのコースとも組み合わせられなかったセクター: ${r.unusedSectors.length} 件（${r.unusedSectors.slice(0, 5).join(', ')}${r.unusedSectors.length > 5 ? ' ほか' : ''}）`);
            if (r.failed.length > 0) lines.push(`読み込めなかったファイル: ${r.failed.length} 件（${r.failed.slice(0, 5).map(f => `${f.path}: ${f.reason}`).join(' / ')}${r.failed.length > 5 ? ' ほか' : ''}）`);
            if (!r.saved && r.saveError) lines.push(`保存できなかった理由: ${r.saveError}`);
            alert(lines.join('\n'));
            // 読み込み済みのログにも反映する: 各ログの位置で改めてコースを引き当て、周回を計算し直す
            const matches = new Map(latestRef.current.sessions.map(s => [
              s.id,
              s.points[0] ? findMatchingCircuit(s.points[0].latitude, s.points[0].longitude, s.points) : undefined
            ]));
            // 反映するのは、ユーザーコースに当たったセッションだけ。内蔵のコースに当たったセッションは、
            // 手で直した計測線・セクター・コース図を消さないよう変えない (コース図がまだなければ、読み込んだコース図を探す)
            const isUser = (m?: CircuitPreset) => !!m && m.id.startsWith('user:');
            recalcSessions(s => {
              const m = matches.get(s.id);
              return isUser(m) ? { cl: m!.controlLine ?? s.controlLine, sec: m!.sectors, name: m!.name } : null;
            });
            for (const [id, m] of matches) {
              if (!m) continue;
              const s = latestRef.current.sessions.find(x => x.id === id);
              if (isUser(m)) {
                // 同じ名前のコースでも、読み込み直したデータにコース図がなくなっていることがあるので、前のコース図は先に消す
                setSessionPolylines([id], undefined);
                requestPolylines([id], m);
              } else if (!s?.pathPolylines) {
                requestPolylines([id], m);
              }
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
        onExportNmea={sessions.length > 0 ? handleExportCurrentNmea : undefined}
        onOpenDonate={() => setIsDonateModalOpen(true)}
      />

      {/* メインコンテンツ */}
      <main className="flex-1 overflow-hidden p-3">
        {/* グラフ解析タブ */}
        <div
          ref={horizSplit.containerRef}
          className={`flex-row h-full w-full overflow-hidden select-none ${currentTab === 'graph' ? 'flex' : 'hidden'}`}
        >
          {/* 左側 / メイン: 速度ウインドウ & アニメーション/動画 (上下分割) */}
          <div
            ref={leftVertSplit.containerRef}
            style={{ width: `${horizSplit.ratio * 100}%` }}
            className="flex flex-col h-full overflow-hidden min-w-[200px]"
          >
            {/* 上部: 速度グラフ */}
            <div
              style={{ height: `${leftVertSplit.ratio * 100}%` }}
              className="min-h-[120px] overflow-hidden"
            >
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
            </div>

            {/* 左上下スプリッター */}
            <SplitResizer
              direction="vertical"
              isDragging={leftVertSplit.isDragging}
              {...leftVertSplit.resizerProps}
            />

            {/* 下部: 走行アニメーション or 車載動画 切替エリア (フラットデザイン) */}
            <div
              style={{ height: `${(1 - leftVertSplit.ratio) * 100}%` }}
              className="min-h-[120px] overflow-hidden flex flex-col bg-[#12141c] rounded border border-[#22293a]"
            >
              {/* 左下タブバー */}
              <div className="flex bg-[#161a25] p-1 border-b border-[#22293a] text-[11px] gap-1 shrink-0">
                <button
                  onClick={() => setLeftBottomMode('replay')}
                  className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                    leftBottomMode === 'replay'
                      ? 'bg-red-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  走行アニメーション
                </button>
                <button
                  onClick={() => setLeftBottomMode('video')}
                  className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                    leftBottomMode === 'video'
                      ? 'bg-red-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  車載動画 (GoPro/MP4)
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-hidden">
                {leftBottomMode === 'replay' ? (
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
                    onClearAlignedSector={() => setAlignedSector(null)}
                  />
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
                  />
                )}
              </div>
            </div>
          </div>

          {/* 左右スプリッター */}
          <SplitResizer
            direction="horizontal"
            isDragging={horizSplit.isDragging}
            {...horizSplit.resizerProps}
          />

          {/* 右側: 全コースウインドウ ＆ フリクションサークル / ドリフト */}
          <div
            ref={rightVertSplit.containerRef}
            style={{ width: `${(1 - horizSplit.ratio) * 100}%` }}
            className="flex flex-col h-full overflow-hidden min-w-[200px]"
          >
            {/* 右上: 全コースウインドウ */}
            <div
              style={{ height: `${rightVertSplit.ratio * 100}%` }}
              className="min-h-[120px] overflow-hidden"
            >
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
            </div>

            {/* 右上下スプリッター */}
            <SplitResizer
              direction="vertical"
              isDragging={rightVertSplit.isDragging}
              {...rightVertSplit.resizerProps}
            />

            {/* 右下: サブウインドウ切替タブ (フラットデザイン) */}
            <div
              style={{ height: `${(1 - rightVertSplit.ratio) * 100}%` }}
              className="min-h-[120px] overflow-hidden flex flex-col bg-[#12141c] rounded border border-[#22293a]"
            >
              <div className="flex bg-[#161a25] p-1 border-b border-[#22293a] text-[11px] gap-1 shrink-0 overflow-x-auto whitespace-nowrap">
                <button
                  onClick={() => setSubWindowMode('all')}
                  className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                    subWindowMode === 'all'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  フリクションサークル (GG)
                </button>
                <button
                  onClick={() => setSubWindowMode('track_friction')}
                  className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                    subWindowMode === 'track_friction'
                      ? 'bg-orange-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  ドリフト採点・評価
                </button>
                <button
                  onClick={() => setSubWindowMode('corner')}
                  className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                    subWindowMode === 'corner'
                      ? 'bg-amber-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  コーナー解析
                </button>
                <button
                  onClick={() => setSubWindowMode('braking')}
                  className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                    subWindowMode === 'braking'
                      ? 'bg-rose-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  ブレーキング
                </button>
                <button
                  onClick={() => setSubWindowMode('video')}
                  className={`px-3 py-0.5 rounded font-bold transition-colors cursor-pointer ${
                    subWindowMode === 'video'
                      ? 'bg-red-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  車載動画同期
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-hidden">
                {subWindowMode === 'all' && (
                  <FrictionCircleWindow cars={activeCars} currentDistance={currentDistanceKm} currentTime={currentTimeSec} compareAxis={compareAxis} />
                )}
                {subWindowMode === 'track_friction' && (
                  <DriftWindow cars={activeCars} currentDistance={currentDistanceKm} />
                )}
                {subWindowMode === 'corner' && (
                  <CornerAnalysisWindow cars={activeCars} currentDistance={currentDistanceKm} onSeekDistance={handleSeekDistance} />
                )}
                {subWindowMode === 'braking' && (
                  <BrakingAnalysisWindow cars={activeCars} currentDistance={currentDistanceKm} onSeekDistance={handleSeekDistance} />
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
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 動画同期タブ */}
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
          />
        </div>

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
            onRemoveSession={id => {
              polylineRequestRef.current.delete(id);
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
          />
        </div>

        {/* ログ変換タブ */}
        {currentTab === 'convert' && (
          <ConvertTab
            sessions={sessions}
            onOpenFile={() => fileInputRef.current?.click()}
            onDropFiles={async files => {
              for (let i = 0; i < files.length; i++) {
                try {
                  await loadFileData(files[i].name, await files[i].arrayBuffer());
                } catch (err: any) {
                  alert(`ファイル ${files[i].name} の読み込みに失敗しました: ${err.message}`);
                }
              }
            }}
          />
        )}

        {/* ロガー設定タブ (マウント状態を維持し、USBシリアル切断を防止) */}
        <div className={`h-full w-full overflow-hidden ${currentTab === 'logger' ? 'block' : 'hidden'}`}>
          <LoggerTab
            onLoadSession={(fileName, buffer) => loadFileData(fileName, buffer)}
            onNavigateToGraph={() => setCurrentTab('graph')}
          />
        </div>
      </main>

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
        onSaveCircuit={(name, cl, sec) => {
          // 編集したコースは、その計測線の近くを走ったログに反映する。なければ基準車のセッションに反映する
          const ids = targetSessionIds(s => !!cl && passesNearControlLine(s.points, cl));
          // ログを読み込む前に保存したときも、画面と次に読み込むログに使う
          setCourseHint({ cl, sec, name, polylines: courseRef.current.polylines });
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
