/**
 * ネイティブのふりをする窓口 (開発・試験用)。開発サーバーで `?native=mock` を付けると入る。
 *
 * 本物と同じく、やりとりはすべて JSON の文字列で通す (物をそのまま渡すと、undefined と null の違い・base64 の誤りなどが試験をすり抜けるため)。
 * デジスパイスIV のふりをした機器を 2 台出し、つなぐと 20 Hz で測位の通知 (パケット A・B) を 100 ms ごとにまとめて送る。
 * 走り始めの 2 秒は未測位、そのあとは半径 150 m の円を 60 km/h で回る
 */

import { CONTRACT_VERSION, type NativeEvent, type NativeEvents, type NativeRequest, type NativeResponse, type StorageInfo } from './contract';
import { fromBase64, toBase64 } from './bridge';

export interface MockNativeOptions {
  /** Bluetooth の許可の状態 (既定は granted) */
  permission?: 'granted' | 'denied';
  /** 返事を遅らせる (ミリ秒) */
  latencyMs?: number;
}

export interface MockNativeController {
  /** 届いた呼び出し (試験で見る) */
  readonly requests: NativeRequest[];
  /** 共有の画面に渡したもの (試験で見る) */
  readonly shared: Array<{ fileName: string; text?: string }>;
  /** 電波が切れたふり。autoReconnect なら 2 秒後につなぎ直す */
  dropConnection(): void;
  uninstall(): void;
}

export const MOCK_DEVICES = [
  { deviceId: 'mock-ds4-1', name: 'DS4B0012345', rssi: -58 },
  { deviceId: 'mock-ds4-2', name: 'DS4B0098765', rssi: -81 }
];

const CENTER_LAT = 35.0;
const CENTER_LON = 137.0;
const RADIUS_M = 150;
const SPEED_MS = 60 / 3.6;
const FIX_HZ = 20;
const INVALID_SEC = 2;

function packetA(valid: boolean, speedMs: number, lat: number, lon: number, altM: number): Uint8Array {
  const v = new DataView(new ArrayBuffer(16));
  v.setUint16(0, valid ? 1 << 7 : 0, true);
  v.setUint16(2, Math.round(speedMs * 100), true);
  v.setInt32(4, Math.round(lat * 1e7), true);
  v.setInt32(8, Math.round(lon * 1e7), true);
  v.setInt32(12, Math.round(altM * 100), true);
  return new Uint8Array(v.buffer);
}

function packetB(valid: boolean, t: Date): Uint8Array {
  const v = new DataView(new ArrayBuffer(10));
  v.setUint16(0, valid ? 1 << 7 : 0, true);
  v.setUint16(2, t.getUTCFullYear(), true);
  v.setUint8(4, t.getUTCMonth() + 1);
  v.setUint8(5, t.getUTCDate());
  v.setUint8(6, t.getUTCHours());
  v.setUint8(7, t.getUTCMinutes());
  v.setUint8(8, t.getUTCSeconds());
  v.setUint8(9, Math.floor(t.getUTCMilliseconds() / 10));
  return new Uint8Array(v.buffer);
}

/** 測位の 2 つのパケット。runSec は走った秒 (円の上の位置を決める)、utcMs は測位の時刻 */
export function mockFixPackets(runSec: number, utcMs: number, valid: boolean): [Uint8Array, Uint8Array] {
  const angle = (SPEED_MS * runSec) / RADIUS_M;
  const mPerDegLat = 111_320;
  const mPerDegLon = mPerDegLat * Math.cos((CENTER_LAT * Math.PI) / 180);
  const lat = CENTER_LAT + (RADIUS_M * Math.sin(angle)) / mPerDegLat;
  const lon = CENTER_LON + (RADIUS_M * Math.cos(angle)) / mPerDegLon;
  const t = new Date(Math.round(utcMs));
  return [packetA(valid, valid ? SPEED_MS : 0, lat, lon, 50), packetB(valid, t)];
}

export function installMockNative(options: MockNativeOptions = {}): MockNativeController {
  const latency = options.latencyMs ?? 5;
  const requests: NativeRequest[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const later = (ms: number, fn: () => void) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };
  const cancel = (id: ReturnType<typeof setTimeout> | null) => {
    if (id === null) return;
    clearTimeout(id);
    timers.delete(id);
  };
  const send = (message: NativeResponse | NativeEvent) => {
    later(latency, () => window.dsNative?.receive(JSON.stringify(message)));
  };
  // 記録 (ネイティブの recorder のふり。ファイルの代わりにメモリに書く)
  const files = new Map<string, { lines: string[]; modifiedMs: number }>();
  let recording: { fileName: string; deviceId: string; lines: string[]; count: number } | null = null;
  const shared: Array<{ fileName: string; text?: string }> = [];
  // ラップタイマーの記録のファイル (名前 → base64 をつないだもの。ふりなので、つなぎ方は気にしない)
  const concatBytes = (a: Uint8Array, b: Uint8Array) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
  const lapTimerFiles = new Map<string, string>();
  let mockCamera: { startWallMs: number; front: boolean } | null = null;
  let mockExposure: ReturnType<typeof setInterval> | null = null;
  let mockSpp: ReturnType<typeof setInterval> | null = null;
  /** 保管先 (選んだフォルダ) に写したファイル */
  const syncedFiles = new Map<string, string>();
  /** 書いている最中のファイル (system.closeFiles で閉じるまで) */
  const openFiles = new Set<string>();
  /** 走行の置き場に見えるファイル (選んだフォルダなら、移したものとアプリの中のもの) */
  const visibleFiles = () => (storage.kind === 'folder' ? new Map([...syncedFiles, ...lapTimerFiles]) : lapTimerFiles);
  let storage: StorageInfo = { kind: 'local', folderName: '', folderOk: false };
  const nowNs = () => Math.round(performance.now() * 1e6);
  const hex = (u8: Uint8Array) => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');

  const emit = <E extends keyof NativeEvents>(event: E, data: NativeEvents[E]) => {
    if (event === 'ble.state' && recording) {
      const st = data as NativeEvents['ble.state'];
      if (st.deviceId === recording.deviceId) recording.lines.push(`# state,${nowNs()},${st.state}`);
    }
    send({ event, data });
  };

  // 探している間
  let scanTimers: Array<ReturnType<typeof setTimeout>> = [];
  const stopScan = () => {
    if (scanTimers.length === 0) return;
    scanTimers.forEach(cancel);
    scanTimers = [];
    emit('ble.scanStopped', {});
  };

  // つないでいる機器 (1 台だけ)
  let link: {
    deviceId: string;
    autoReconnect: boolean;
    /** 送り始めた時刻 (ふりを始めてからの秒) */
    startSec: number;
    /** この時刻 (秒) から測位できている */
    validFromSec: number;
    stream: ReturnType<typeof setTimeout> | null;
    pending: ReturnType<typeof setTimeout> | null;
  } | null = null;
  const nowSec = () => (performance.now() - startPerf) / 1000;
  const startUtcMs = Date.now();
  const startPerf = performance.now();

  const startStream = () => {
    if (!link) return;
    const l = link;
    let sent = 0;
    const tick = () => {
      const now = nowSec();
      const items: Array<{ t: number; b: string }> = [];
      // 前の束からの分の測位 (20 Hz・100 ms ごとなら 2 つ)
      while (sent / FIX_HZ <= now - l.startSec) {
        const sec = l.startSec + sent / FIX_HZ;
        const valid = sec >= l.validFromSec;
        const [a, b] = mockFixPackets(valid ? sec - l.validFromSec : 0, startUtcMs + sec * 1000, valid);
        const tNs = Math.round(performance.now() * 1e6);
        items.push({ t: tNs, b: toBase64(a) }, { t: tNs, b: toBase64(b) });
        if (recording?.deviceId === l.deviceId) {
          recording.lines.push(`${tNs},${l.deviceId},2a67,${hex(a)}`, `${tNs},${l.deviceId},2a67,${hex(b)}`);
          recording.count += 2;
        }
        sent++;
      }
      if (items.length) emit('ble.notify', { deviceId: l.deviceId, characteristic: '2a67', items });
      l.stream = later(100, tick);
    };
    tick();
  };
  const stopStream = () => {
    if (!link) return;
    cancel(link.stream);
    cancel(link.pending);
    link.stream = null;
    link.pending = null;
  };

  const handle = (req: NativeRequest): unknown => {
    switch (req.method) {
      case 'caps.get':
        return { contractVersion: CONTRACT_VERSION, platform: 'mock', deviceKind: 'phone', features: { ble: true, iap: true, camera: true, spp: true, deleteFiles: true } };
      // アプリ内課金の模擬 (値段は日本円の例。買うとすぐ買えたことにする)
      case 'iap.products': {
        const { ids } = req.params as { ids: string[] };
        const prices: Record<string, string> = { gas1: '¥180', gas5: '¥900', gas10: '¥1,800' };
        return {
          products: ids.map(id => {
            const key = id.slice(id.lastIndexOf('.') + 1);
            const liters = key.replace('gas', '');
            return { id, displayName: `ガソリン ${liters}L 分の投げ銭`, description: '開発を応援する投げ銭です。', displayPrice: prices[key] ?? '¥0' };
          })
        };
      }
      case 'iap.purchase':
        return { status: 'purchased' };
      case 'ble.permission':
        return { state: options.permission ?? 'granted' };
      case 'ble.scan': {
        stopScan();
        const { namePrefixes } = req.params as { namePrefixes: string[] };
        scanTimers = MOCK_DEVICES
          .filter(d => namePrefixes.some(p => d.name.startsWith(p)))
          .map((d, i) => later(300 + i * 500, () => emit('ble.device', d)));
        scanTimers.push(later(10_000, stopScan));
        return {};
      }
      case 'ble.stopScan':
        stopScan();
        return {};
      case 'ble.connect': {
        const p = req.params as { deviceId: string; autoReconnect: boolean };
        if (!MOCK_DEVICES.some(d => d.deviceId === p.deviceId)) throw { code: 'not-found', message: 'unknown device' };
        stopStream();
        if (link && link.deviceId !== p.deviceId) emit('ble.state', { deviceId: link.deviceId, state: 'disconnected' });
        link = { deviceId: p.deviceId, autoReconnect: p.autoReconnect, startSec: 0, validFromSec: Infinity, stream: null, pending: null };
        emit('ble.state', { deviceId: p.deviceId, state: 'connecting' });
        link.pending = later(500, () => {
          if (!link) return;
          link.pending = null;
          link.startSec = nowSec();
          link.validFromSec = link.startSec + INVALID_SEC;
          emit('ble.state', { deviceId: link.deviceId, state: 'connected' });
          startStream();
        });
        return {};
      }
      case 'ble.disconnect': {
        const { deviceId } = req.params as { deviceId: string };
        if (recording?.deviceId === deviceId) {
          files.set(recording.fileName, { lines: recording.lines, modifiedMs: Date.now() });
          recording = null;
        }
        if (link?.deviceId === deviceId) {
          stopStream();
          link = null;
          emit('ble.state', { deviceId, state: 'disconnected' });
        }
        return {};
      }
      case 'ble.write': {
        // 書いたものは requests に残るので、試験ではそこを見る
        const p = req.params as { deviceId: string };
        if (link?.deviceId !== p.deviceId || link.pending) throw { code: 'not-connected', message: 'not connected' };
        return {};
      }
      case 'ble.read': {
        const p = req.params as { deviceId: string; service: string; characteristic: string };
        if (link?.deviceId !== p.deviceId || link.pending) throw { code: 'not-connected', message: 'not connected' };
        const name = MOCK_DEVICES.find(d => d.deviceId === p.deviceId)?.name ?? '';
        const info: Record<string, string> = { '2a29': 'Mock Maker', '2a24': 'DS4-MOCK', '2a25': name.slice(4), '2a26': '1.0.0' };
        const text = p.service === '180a' ? info[p.characteristic] : undefined;
        if (text === undefined) throw { code: 'not-found', message: 'no such characteristic' };
        return { b: toBase64(new TextEncoder().encode(text)) };
      }
      case 'recorder.start': {
        const p = req.params as { name: string; deviceId: string; header: string[] };
        if (link?.deviceId !== p.deviceId) throw { code: 'not-connected', message: 'not connected' };
        if (recording) files.set(recording.fileName, { lines: recording.lines, modifiedMs: Date.now() });
        let fileName = `${p.name}.csv`;
        for (let n = 2; files.has(fileName); n++) fileName = `${p.name}_${n}.csv`;
        const lines = ['# ds-ble-capture 1', ...p.header.map(h => `# ${h}`), `# started_utc_ms=${Date.now()} started_ns=${nowNs()}`, 't_ns,device,characteristic,hex'];
        recording = { fileName, deviceId: p.deviceId, lines, count: 0 };
        files.set(fileName, { lines, modifiedMs: Date.now() });
        return { fileName };
      }
      case 'recorder.stop': {
        if (!recording) return {};
        const r = recording;
        recording = null;
        files.set(r.fileName, { lines: r.lines, modifiedMs: Date.now() });
        return { fileName: r.fileName, notifications: r.count, bytes: r.lines.join('\n').length };
      }
      case 'recorder.status':
        return recording ? { recording: true, fileName: recording.fileName, deviceId: recording.deviceId, notifications: recording.count } : { recording: false };
      case 'recorder.list':
        return { files: [...files].map(([fileName, f]) => ({ fileName, bytes: f.lines.join('\n').length + 1, modifiedMs: f.modifiedMs })) };
      case 'recorder.read': {
        const f = files.get((req.params as { fileName: string }).fileName);
        if (!f) throw { code: 'not-found', message: 'no such file' };
        return { text: f.lines.join('\n') + '\n' };
      }
      case 'recorder.remove': {
        const { fileName } = req.params as { fileName: string };
        if (recording?.fileName === fileName) throw { code: 'busy', message: 'recording' };
        files.delete(fileName);
        return {};
      }
      case 'recorder.share':
        shared.push({ fileName: (req.params as { fileName: string }).fileName });
        return {};
      case 'system.shareText':
        shared.push(req.params as { fileName: string; text: string });
        return {};
      case 'system.openSettings':
        return {};
      case 'system.keepAwake':
        return {};
      // 内蔵カメラのふり (撮った動画は中身のない小さなファイルにする)
      case 'camera.permission':
        return { camera: 'granted', mic: 'granted' };
      case 'camera.lenses':
        return { lenses: [
          { id: 'mock-uw', position: 'back', kind: 'ultraWide', zoom: 0.5, isoMin: 32, isoMax: 2304, presets: ['1080p30', '1080p60', '2160p30'], multiCamPresets: ['1080p30', '1080p60'] },
          { id: 'mock-w', position: 'back', kind: 'wide', zoom: 1, isoMin: 32, isoMax: 3072, presets: ['1080p30', '1080p60', '2160p30', '2160p60'], multiCamPresets: ['1080p30', '1080p60'] },
          { id: 'mock-t', position: 'back', kind: 'tele', zoom: 5, isoMin: 32, isoMax: 2304, presets: ['1080p30', '2160p30'], multiCamPresets: [] },
          { id: 'mock-f', position: 'front', kind: 'front', zoom: 1, isoMin: 32, isoMax: 2304, presets: ['1080p30', '1080p60'], multiCamPresets: ['1080p30'] }
        ], multiCam: true };
      case 'camera.start': {
        const p = req.params as { lensId: string | null; preset: string; front?: unknown };
        mockCamera = { startWallMs: Date.now(), front: !!p.front };
        setTimeout(() => emit('camera.state', { recording: true }), 50);
        return { lensId: p.lensId ?? 'mock-w', preset: p.preset };
      }
      case 'camera.preview': {
        const { show, iso, front } = req.params as { show: boolean; iso?: number | null; front?: { iso: number | null } | null };
        if (mockExposure) clearInterval(mockExposure);
        mockExposure = null;
        const ev = (v: number | null | undefined, which: 'main' | 'front') => ({ iso: v ?? (which === 'main' ? 125 : 400), shutterSec: v ? 1 / Math.round(v * 2.5) : which === 'main' ? 1 / 320 : 1 / 60, which });
        if (show) mockExposure = setInterval(() => {
          emit('camera.exposure', ev(iso, 'main'));
          if (front) emit('camera.exposure', ev(front.iso, 'front'));
        }, 300);
        return {};
      }
      case 'camera.setIso':
      case 'camera.setEv':
        return {};
      // Bluetooth Classic の Drogger のふり (袖ヶ浦の近くで円を回る NMEA を 10 Hz で送る)
      case 'spp.pick':
        return { deviceId: '00:1A:7D:DA:71:13', name: 'DG-PRO1S_mock' };
      case 'spp.connect': {
        const { deviceId } = req.params as { deviceId: string };
        if (mockSpp) clearInterval(mockSpp);
        setTimeout(() => emit('spp.state', { deviceId, state: 'connecting' }), 30);
        setTimeout(() => emit('spp.state', { deviceId, state: 'connected' }), 400);
        let k = 0;
        mockSpp = setInterval(() => {
          const t = new Date();
          const a = (k++ / 600) * 2 * Math.PI;
          const lat = 35.3943 + 0.001 * Math.sin(a), lon = 140.0879 + 0.0013 * Math.cos(a);
          emit('spp.data', { deviceId, items: [{ t: performance.now() * 1e6, b: toBase64(new TextEncoder().encode(mockNmea(t, lat, lon, 60))) }] });
        }, 100);
        return {};
      }
      case 'spp.disconnect': {
        const { deviceId } = req.params as { deviceId: string };
        if (mockSpp) clearInterval(mockSpp);
        mockSpp = null;
        setTimeout(() => emit('spp.state', { deviceId, state: 'disconnected' }), 10);
        return {};
      }
      case 'spp.shareLog':
        return {};
      case 'camera.stop': {
        const { path, frontPath } = req.params as { path: string | null; frontPath?: string | null };
        const cam = mockCamera;
        mockCamera = null;
        if (!cam) return { files: [] };
        if (path) lapTimerFiles.set(path, '');
        if (cam.front && frontPath) lapTimerFiles.set(frontPath, '');
        const file = (p: string) => ({ path: p, startWallMs: cam.startWallMs, durationSec: (Date.now() - cam.startWallMs) / 1000, bytes: 0 });
        return { files: [file(path ?? 'cam.mov')], frontFiles: cam.front ? [file(frontPath ?? 'cam_front.mov')] : [] };
      }
      case 'system.motionStart':
      case 'system.motionStop':
        return {};
      case 'system.setOrientation': {
        return { orientation: 'portrait' };
      }
      case 'system.appendFile': {
        const { path, b64, truncate, createNew } = req.params as { path: string; b64: string; truncate?: boolean; createNew?: boolean };
        if (createNew && lapTimerFiles.has(path)) throw { code: 'busy', message: 'file exists' };
        // base64 の文字のまま足すと、前の分の末尾の = (詰め物) が途中に残って読めなくなる (4 MiB ずつ書く取り込みで壊れていた)。
        // バイト列に戻してからつなぎ、base64 にし直す
        const prev = truncate ? '' : lapTimerFiles.get(path) ?? '';
        lapTimerFiles.set(path, prev ? toBase64(concatBytes(fromBase64(prev), fromBase64(b64))) : b64);
        if (!path.startsWith('exports/')) openFiles.add(path);
        return {};
      }
      case 'system.storageInfo':
        return { ...storage };
      case 'system.pickStorageFolder':
        storage = { kind: 'folder', folderName: 'iCloud Drive/LapLoupe', folderOk: true };
        return { ...storage };
      case 'system.setStorageLocal':
        storage = { ...storage, kind: 'local' };
        return { ...storage };
      case 'system.syncLapFiles': {
        if (storage.kind !== 'folder') return { kind: 'local', copied: 0, skipped: 0, failed: 0 };
        // 書き終えたものは選んだフォルダへ移す (アプリの中から消す)。書いている最中のものは写すだけ
        let copied = 0;
        let moved = 0;
        let skipped = 0;
        for (const [path, b64] of [...lapTimerFiles]) {
          if (path.startsWith('exports/')) continue;
          const same = syncedFiles.get(path) === b64;
          syncedFiles.set(path, b64);
          if (!openFiles.has(path)) { lapTimerFiles.delete(path); moved++; } else if (same) skipped++; else copied++;
        }
        return { kind: 'folder', copied, moved, skipped, failed: 0 };
      }
      case 'system.closeFiles': {
        const { all, prefix, paths } = req.params as { all?: boolean; prefix?: string; paths?: string[] };
        if (all) openFiles.clear();
        for (const p of [...openFiles]) if ((prefix && p.startsWith(prefix)) || paths?.includes(p)) openFiles.delete(p);
        return { open: openFiles.size };
      }
      case 'system.deleteRunFiles': {
        const { paths } = req.params as { paths: string[] };
        const deleted: string[] = [];
        for (const p of paths) { lapTimerFiles.delete(p); syncedFiles.delete(p); deleted.push(p); }
        return { deleted, failed: [] };
      }
      case 'system.runRoot': {
        // 動画を読む URL の頭 (開発サーバーで、マニュアルの写真を撮るときだけ。?mockVideoBase=http://localhost:.../)
        const base = new URLSearchParams(window.location.search).get('mockVideoBase');
        if (!base) throw { code: 'not-supported', message: 'no video base' };
        return { urlBase: base };
      }
      case 'system.listRunFiles':
        return { files: [...visibleFiles().entries()].filter(([p]) => !p.startsWith('exports/')).map(([path, b64]) => ({ path, size: b64.length, mtimeMs: 0, local: true })) };
      case 'system.readRunFile': {
        const { path } = req.params as { path: string };
        const files = visibleFiles();
        if (!files.has(path)) throw { code: 'not-found', message: 'no file' };
        return { b64: files.get(path)! };
      }
      case 'system.writeRunFile': {
        // 走行の置き場 (選んだフォルダがあればそこ) に書く
        const { path, b64 } = req.params as { path: string; b64: string };
        if (storage.kind === 'folder') { syncedFiles.set(path, b64); lapTimerFiles.delete(path); }
        else lapTimerFiles.set(path, b64);
        return {};
      }
      case 'system.shareFile':
        shared.push({ fileName: (req.params as { path: string }).path });
        return {};
      default:
        throw { code: 'not-supported', message: `unknown method ${String(req.method)}` };
    }
  };

  const sink = {
    postMessage(message: string) {
      const req = JSON.parse(message) as NativeRequest;
      requests.push(req);
      if (req.v !== CONTRACT_VERSION) {
        send({ id: req.id, ok: false, error: { code: 'not-supported', message: `contract ${req.v}` } });
        return;
      }
      try {
        send({ id: req.id, ok: true, result: handle(req) });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        send({ id: req.id, ok: false, error: { code: (err.code ?? 'io') as 'io', message: err.message ?? String(e) } });
      }
    }
  };
  const prevWebkit = window.webkit;
  window.webkit = { messageHandlers: { dsNative: sink } };

  return {
    requests,
    shared,
    dropConnection() {
      if (!link) return;
      stopStream();
      const l = link;
      if (!l.autoReconnect) {
        link = null;
        emit('ble.state', { deviceId: l.deviceId, state: 'disconnected', error: { code: 'io', message: 'connection lost' } });
        return;
      }
      emit('ble.state', { deviceId: l.deviceId, state: 'reconnecting' });
      l.pending = later(2000, () => {
        l.pending = null;
        l.startSec = nowSec();
        emit('ble.state', { deviceId: l.deviceId, state: 'connected' });
        startStream();
      });
    },
    uninstall() {
      timers.forEach(clearTimeout);
      timers.clear();
      window.webkit = prevWebkit;
    }
  };
}

/** ふりの Drogger の NMEA (GGA と RMC) */
function mockNmea(t: Date, lat: number, lon: number, kmh: number): string {
  const pad = (n: number, w: number) => String(Math.floor(n)).padStart(w, '0');
  const tod = `${pad(t.getUTCHours(), 2)}${pad(t.getUTCMinutes(), 2)}${pad(t.getUTCSeconds(), 2)}.${pad(t.getUTCMilliseconds() / 10, 2)}`;
  const dm = (v: number, w: number) => { const d = Math.floor(Math.abs(v)); return `${pad(d, w)}${((Math.abs(v) - d) * 60).toFixed(5).padStart(8, '0')}`; };
  const date = `${pad(t.getUTCDate(), 2)}${pad(t.getUTCMonth() + 1, 2)}${pad(t.getUTCFullYear() % 100, 2)}`;
  const sum = (b: string) => { let x = 0; for (let i = 0; i < b.length; i++) x ^= b.charCodeAt(i); return x.toString(16).toUpperCase().padStart(2, '0'); };
  const gga = `GNGGA,${tod},${dm(lat, 2)},N,${dm(lon, 3)},E,4,24,0.6,30.0,M,39.0,M,,`;
  const rmc = `GNRMC,${tod},A,${dm(lat, 2)},N,${dm(lon, 3)},E,${(kmh / 1.852).toFixed(2)},90.0,${date},,,D`;
  return `$${gga}*${sum(gga)}\r\n$${rmc}*${sum(rmc)}\r\n`;
}

