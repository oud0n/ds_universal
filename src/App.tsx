import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Session, SelectedCarSlot, ControlLine, Sector, CircuitPreset } from './types/telemetry';
import { parseDtb } from './services/dtbParser';
import { parseDigispiceRawBinary } from './services/rawBinaryParser';
import { parseCsv } from './services/csvParser';
import { parseNmea } from './services/nmeaParser';
import { parsePth, parseCln } from './services/pthParser';
import { extractLaps } from './services/lapCalculator';
import { CIRCUIT_PRESETS, ALL_CIRCUITS, findMatchingCircuit, resolveCircuitPolylines } from './services/circuitDatabase';
import { userCircuitStorage } from './services/userCircuitStorage';

import { Header } from './components/Header';
import { SpeedGraphWindow } from './components/SpeedGraphWindow';
import { TrackMapWindow } from './components/TrackMapWindow';
import { ReplayWindow } from './components/ReplayWindow';
import { FrictionCircleWindow } from './components/FrictionCircleWindow';
import { DriftWindow } from './components/DriftWindow';
import { VideoSyncWindow } from './components/VideoSyncWindow';
import { DataTab } from './components/DataTab';
import { LoggerTab } from './components/LoggerTab';
import { CircuitEditorModal } from './components/CircuitEditorModal';
import { useResizableSplit } from './hooks/useResizableSplit';
import { SplitResizer } from './components/SplitResizer';
import { exportSessionToNmea, triggerFileDownload } from './services/nmeaExporter';

export const App: React.FC = () => {
  // タブ
  const [currentTab, setCurrentTab] = useState<'graph' | 'data' | 'logger' | 'video'>('graph');

  // グラフ画面・左下モード ('replay' | 'video')
  const [leftBottomMode, setLeftBottomMode] = useState<'replay' | 'video'>('replay');

  // サブウインドウ表示モード ('all' | 'track_friction' | 'replay_focus' | 'video')
  const [subWindowMode, setSubWindowMode] = useState<'all' | 'track_friction' | 'replay_focus' | 'video'>('all');

  // ウィンドウ分割リサイズフック (左右、左側上下、右側上下)
  const horizSplit = useResizableSplit({ initialRatio: 0.58, direction: 'horizontal', storageKey: 'ds_split_horiz' });
  const leftVertSplit = useResizableSplit({ initialRatio: 0.60, direction: 'vertical', storageKey: 'ds_split_left_vert' });
  const rightVertSplit = useResizableSplit({ initialRatio: 0.55, direction: 'vertical', storageKey: 'ds_split_right_vert' });

  // セッション一覧
  const [sessions, setSessions] = useState<Session[]>([]);

  // 選択中の車両スロット (最大4台: 0:赤, 1:青, 2:緑, 3:橙)
  const [selectedCars, setSelectedCars] = useState<SelectedCarSlot[]>([]);

  // コース・コントロールライン・セクター
  const [currentControlLine, setCurrentControlLine] = useState<ControlLine | undefined>(
    CIRCUIT_PRESETS[0].controlLine
  );
  const [currentSectors, setCurrentSectors] = useState<Sector[]>(CIRCUIT_PRESETS[0].sectors);
  const [currentCircuitName, setCurrentCircuitName] = useState<string>(CIRCUIT_PRESETS[0].name);
  const [currentPthPolylines, setCurrentPthPolylines] = useState<Array<Array<[number, number]>>>([]);

  // 再生アニメーション状態
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [currentDistanceKm, setCurrentDistanceKm] = useState(0);

  // モーダル
  const [isCircuitEditorOpen, setIsCircuitEditorOpen] = useState(false);

  // 非表示ファイルインプット参照
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pthInputRef = useRef<HTMLInputElement | null>(null);
  const clnInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // 基準車 (Car 1: 赤)
  const baseSelected = selectedCars.find(c => c.slot === 0);
  const baseSession = sessions.find(s => s.id === baseSelected?.sessionId);
  const baseLap = baseSession?.laps.find(l => l.lapNumber === baseSelected?.lapNumber);

  // 有効な選択中車両一覧
  const activeCars = selectedCars
    .map(slot => {
      const session = sessions.find(s => s.id === slot.sessionId);
      const lap = session?.laps.find(l => l.lapNumber === slot.lapNumber);
      return lap ? { slot, lap } : null;
    })
    .filter(Boolean) as { slot: SelectedCarSlot; lap: any }[];

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
      const dtSec = ((now - lastTimeRef.current) / 1000) * playbackSpeed;
      lastTimeRef.current = now;

      setCurrentTimeSec(prevTime => {
        let nextTime = prevTime + dtSec;
        if (nextTime > baseLap.lapTime) {
          nextTime = 0; // ループ
        }

        // タイムに対応する距離を計算
        const pts = baseLap.points;
        const curPt = pts.reduce((prev, curr) => {
          return Math.abs(curr.time - nextTime) < Math.abs(prev.time - nextTime) ? curr : prev;
        }, pts[0]);

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

  // キーボードショートカット (Space: 再生/停止, F: コマ送り, B: コマ戻し)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 入力フォーム操作中は無視
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying(p => !p);
      } else if (e.code === 'KeyF') {
        e.preventDefault();
        handleStep(0.1);
      } else if (e.code === 'KeyB') {
        e.preventDefault();
        handleStep(-0.1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [baseLap]);

  // Electron ネイティブメニューからのファイルオープン受信
  useEffect(() => {
    const nav = window as any;
    if (nav.electronAPI?.onOpenFiles && nav.electronAPI?.readFileBuffer) {
      nav.electronAPI.onOpenFiles(async (filePaths: string[]) => {
        for (const fp of filePaths) {
          try {
            const res = await nav.electronAPI.readFileBuffer(fp);
            if (res.success) {
              const buffer = new Uint8Array(res.dataArray).buffer;
              await loadFileData(res.name, buffer);
            }
          } catch (err: any) {
            console.error('Electron file open error:', err);
          }
        }
      });
    }
  }, []);

  const handleStep = (stepSec: number) => {
    if (!baseLap) return;
    setIsPlaying(false);
    setCurrentTimeSec(prev => {
      const maxLimit = currentTab === 'video' ? (baseSession?.totalDistance || 99999) : baseLap.lapTime;
      const next = Math.max(0, Math.min(maxLimit, prev + stepSec));
      const pts = (currentTab === 'video' ? baseSession?.points : baseLap?.points) || baseSession?.points;
      if (pts && pts.length > 0) {
        const curPt = pts.reduce((p, c) => (Math.abs(c.time - next) < Math.abs(p.time - next) ? c : p), pts[0]);
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
      const curPt = pts.reduce((p, c) => (Math.abs(c.time - timeSec) < Math.abs(p.time - timeSec) ? c : p), pts[0]);
      if (curPt) setCurrentDistanceKm(curPt.distance);
    }
  };

  const handleSeekDistance = (distKm: number) => {
    if (!baseLap) return;
    setCurrentDistanceKm(distKm);
    const pts = baseLap.points;
    const curPt = pts.reduce((p, c) => (Math.abs(c.distance - distKm) < Math.abs(p.distance - distKm) ? c : p), pts[0]);
    if (curPt) setCurrentTimeSec(curPt.time);
  };

  // セクター同時スタート
  const handleSyncSectorStart = (sectorIndex: number) => {
    if (!baseLap) return;
    const sec = baseLap.sectors[sectorIndex];
    if (sec) {
      handleSeekDistance(sec.distance);
      setIsPlaying(true);
    }
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
    } else if (ext === 'csv' || ext === 'txt') {
      const text = new TextDecoder('utf-8').decode(buffer);
      const parsed = parseCsv(text);
      rawPoints = parsed.points;
      samplingRate = parsed.samplingRate;
    } else if (ext === 'nmea' || ext === 'log') {
      const text = new TextDecoder('utf-8').decode(buffer);
      const parsed = parseNmea(text);
      rawPoints = parsed.points;
      samplingRate = parsed.samplingRate;
    } else {
      throw new Error(`未対応のファイル形式です: .${ext}`);
    }

    if (rawPoints.length === 0) {
      throw new Error('有効なGPS位置データが見つかりませんでした');
    }

    // サーキット自動判定
    let matchedCircuit = findMatchingCircuit(rawPoints[0].latitude, rawPoints[0].longitude);
    let cl = currentControlLine;
    let sec = currentSectors;
    let circName = currentCircuitName;

    if (matchedCircuit) {
      cl = matchedCircuit.controlLine;
      sec = matchedCircuit.sectors;
      circName = matchedCircuit.name;
      setCurrentControlLine(cl);
      setCurrentSectors(sec);
      setCurrentCircuitName(circName);

      // コース図ポリラインの自動読込 (ユーザー設置 -> OpenStreetMap 自動解決)
      resolveCircuitPolylines(matchedCircuit).then(polylines => {
        if (polylines && polylines.length > 0) {
          setCurrentPthPolylines(polylines);
        }
      }).catch(console.warn);
    }

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
      sectors: sec
    };

    setSessions(prev => [...prev, newSession]);

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

    setCurrentTab('graph');
  };

  // サーキットプリセット選択
  const handleSelectCircuitPreset = (presetId: string) => {
    const p = CIRCUIT_PRESETS.find(c => c.id === presetId);
    if (!p) return;
    setCurrentControlLine(p.controlLine);
    setCurrentSectors(p.sectors);
    setCurrentCircuitName(p.name);

    // 全セッションのラップを再計算
    setSessions(prev =>
      prev.map(s => {
        const { laps, bestLapIndex, theoreticalBestTime } = extractLaps(s.points, p.controlLine, p.sectors);
        return { ...s, laps, bestLapIndex, theoreticalBestTime, controlLine: p.controlLine, sectors: p.sectors };
      })
    );
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
        accept=".dtb,.bnx4,.bon4,.binx,.bon,.csv,.txt,.nmea,.log"
        className="hidden"
      />
      <input
        type="file"
        ref={pthInputRef}
        onChange={async e => {
          const f = e.target.files?.[0];
          if (f) {
            const txt = await f.text();
            setCurrentPthPolylines(parsePth(txt));
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
            setCurrentControlLine(cl);
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
            const { pthCount, clnCount, sciCount } = await userCircuitStorage.importFiles(files);
            alert(`ユーザーコースデータを登録しました:\nコース図 (.pth): ${pthCount} 件\nコントロールライン (.cln): ${clnCount} 件\nセクター (.sci): ${sciCount} 件`);
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
      />

      {/* メインコンテンツ */}
      <main className="flex-1 overflow-hidden p-3">
        {currentTab === 'graph' && (
          <div
            ref={horizSplit.containerRef}
            className="flex flex-row h-full w-full overflow-hidden select-none"
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
                />
              </div>

              {/* 左上下スプリッター */}
              <SplitResizer
                direction="vertical"
                isDragging={leftVertSplit.isDragging}
                {...leftVertSplit.resizerProps}
              />

              {/* 下部: 走行アニメーション or 車載動画 切替エリア */}
              <div
                style={{ height: `${(1 - leftVertSplit.ratio) * 100}%` }}
                className="min-h-[120px] overflow-hidden flex flex-col bg-[#12141c] rounded-lg border border-[#272f42]"
              >
                {/* 左下タブバー */}
                <div className="flex bg-[#181c26] p-1 border-b border-[#272f42] text-[11px] gap-1 shrink-0">
                  <button
                    onClick={() => setLeftBottomMode('replay')}
                    className={`px-3 py-1 rounded font-bold transition-all cursor-pointer ${
                      leftBottomMode === 'replay'
                        ? 'bg-red-600 text-white shadow'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    走行アニメーション
                  </button>
                  <button
                    onClick={() => setLeftBottomMode('video')}
                    className={`px-3 py-1 rounded font-bold transition-all cursor-pointer ${
                      leftBottomMode === 'video'
                        ? 'bg-purple-600 text-white shadow'
                        : 'text-slate-400 hover:text-white'
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
                      isPlaying={isPlaying}
                      onTogglePlay={() => setIsPlaying(!isPlaying)}
                      onStepForward={() => handleStep(0.1)}
                      onStepBack={() => handleStep(-0.1)}
                      onSeekDistance={handleSeekDistance}
                      onSyncSectorStart={handleSyncSectorStart}
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
                  onSeekDistance={handleSeekDistance}
                />
              </div>

              {/* 右上下スプリッター */}
              <SplitResizer
                direction="vertical"
                isDragging={rightVertSplit.isDragging}
                {...rightVertSplit.resizerProps}
              />

              {/* 右下: サブウインドウ切替タブ (フリクションサークル / ドリフト / 車載動画) */}
              <div
                style={{ height: `${(1 - rightVertSplit.ratio) * 100}%` }}
                className="min-h-[120px] overflow-hidden flex flex-col bg-[#12141c] rounded-lg border border-[#272f42]"
              >
                <div className="flex bg-[#181c26] p-1 border-b border-[#272f42] text-[11px] gap-1 shrink-0">
                  <button
                    onClick={() => setSubWindowMode('all')}
                    className={`px-3 py-1 rounded font-bold transition-all cursor-pointer ${
                      subWindowMode === 'all'
                        ? 'bg-cyan-600 text-white shadow'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    フリクションサークル (GG)
                  </button>
                  <button
                    onClick={() => setSubWindowMode('track_friction')}
                    className={`px-3 py-1 rounded font-bold transition-all cursor-pointer ${
                      subWindowMode === 'track_friction'
                        ? 'bg-orange-600 text-white shadow'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    ドリフト採点・評価
                  </button>
                  <button
                    onClick={() => setSubWindowMode('video')}
                    className={`px-3 py-1 rounded font-bold transition-all cursor-pointer ${
                      subWindowMode === 'video'
                        ? 'bg-purple-600 text-white shadow'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    車載動画同期
                  </button>
                </div>

                <div className="flex-1 min-h-0 overflow-hidden">
                  {subWindowMode === 'all' && (
                    <FrictionCircleWindow cars={activeCars} currentDistance={currentDistanceKm} />
                  )}
                  {subWindowMode === 'track_friction' && (
                    <DriftWindow cars={activeCars} currentDistance={currentDistanceKm} />
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
        )}

        {currentTab === 'video' && (
          <div className="h-full w-full overflow-hidden">
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
        )}

        {currentTab === 'data' && (
          <DataTab
            sessions={sessions}
            selectedCars={selectedCars}
            onSelectCarSlot={handleSelectCarSlot}
            onRemoveSession={id => {
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
        )}

        {currentTab === 'logger' && (
          <LoggerTab
            onLoadSession={(fileName, buffer) => loadFileData(fileName, buffer)}
            onNavigateToGraph={() => setCurrentTab('graph')}
          />
        )}
      </main>

      {/* コース編集モーダル */}
      <CircuitEditorModal
        isOpen={isCircuitEditorOpen}
        onClose={() => setIsCircuitEditorOpen(false)}
        currentCircuitName={currentCircuitName}
        controlLine={currentControlLine}
        sectors={currentSectors}
        onSaveCircuit={(name, cl, sec) => {
          setCurrentCircuitName(name);
          setCurrentControlLine(cl);
          setCurrentSectors(sec);
          setSessions(prev =>
            prev.map(s => {
              const { laps, bestLapIndex, theoreticalBestTime } = extractLaps(s.points, cl, sec);
              return { ...s, laps, bestLapIndex, theoreticalBestTime, controlLine: cl, sectors: sec };
            })
          );
        }}
      />
    </div>
  );
};
export default App;
