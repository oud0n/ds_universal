/**
 * ラップタイマーの測位の出どころ (2026-10-21、PLAN-24 の作る順番の 4 の 1 段目)。
 * 画面 (LapTimerScreen) の effect から、そのまま切り出したもの。どれも「測位を onFix に渡し続け、戻り値で止める」形。
 * RaceBox・Drogger は機器の部品 (useLapDevices) が渡すので、ここには無い
 */

import { bleLoggerLink } from '../bleLoggerLink';
import type { LiveFix } from '../liveLapTimer';
import type { TelemetryPoint } from '../../types/telemetry';

export type StopFeed = () => void;

/** デジスパイス (Bluetooth)。BLE の層を用意して測位を受け取るだけで、つなぎはしない (つなぐのは出どころの印・測定開始) */
export function digspiceFeed(onFix: (f: LiveFix) => void): StopFeed {
  void bleLoggerLink.start();
  return bleLoggerLink.onFix(fix => onFix({
    tMs: fix.timestamp.getTime(),
    latitude: fix.latitude,
    longitude: fix.longitude,
    speedKmh: fix.speedKmh,
    altitude: fix.altitude,
    valid: fix.valid
  }));
}

/** 2 点の間の距離 (km。短い距離向けの平面の近似。ラップタイマーで使ってきたもの) */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lon2 - lon1) * cosLat * 111.32, (lat2 - lat1) * 111.32);
}

export interface PhoneInfo {
  accuracy: number | null;
  error: string | null;
}

/** この端末の GPS (1 Hz 前後)。誤差の大きい測位 (30 m より粗い) は valid: false */
export function phoneFeed(
  onFix: (f: LiveFix) => void,
  onInfo: (i: PhoneInfo) => void,
  messages: { unavailable: string; denied: string }
): StopFeed {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    onInfo({ accuracy: null, error: messages.unavailable });
    return () => {};
  }
  onInfo({ accuracy: null, error: null });
  let prev: LiveFix | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let id = -1;
  // 許可が無いと知らされても、少し待って取り直す (Android は OS の許可の画面を出している間に、先に「許可なし」が届くことがある。
  // あとで許可されれば、そこから測位が始まる)
  const watch = () => { id = navigator.geolocation.watchPosition(
    pos => {
      onInfo({ accuracy: pos.coords.accuracy, error: null });
      // 速さが来ない (null・負) ときは、前の測位からの位置と時刻で求める (iPhone はよく来ない)
      const reported = pos.coords.speed;
      let speedKmh = reported !== null && reported >= 0 ? reported * 3.6 : 0;
      if ((reported === null || reported < 0) && prev && pos.timestamp > prev.tMs) {
        speedKmh = distanceKm(prev.latitude, prev.longitude, pos.coords.latitude, pos.coords.longitude) / ((pos.timestamp - prev.tMs) / 3600000);
      }
      const fix: LiveFix = {
        tMs: pos.timestamp,
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        speedKmh,
        altitude: pos.coords.altitude ?? undefined,
        ...(pos.coords.heading !== null && Number.isFinite(pos.coords.heading) && pos.coords.heading >= 0 ? { course: pos.coords.heading } : {}),
        // 誤差の大きい測位 (屋内・測位の始め) は使わない
        valid: pos.coords.accuracy <= 30
      };
      if (fix.valid) prev = fix;
      onFix(fix);
    },
    err => {
      onInfo({ accuracy: null, error: err.code === err.PERMISSION_DENIED ? messages.denied : err.message });
      if (err.code === err.PERMISSION_DENIED && !stopped && !retry) {
        navigator.geolocation.clearWatch(id);
        retry = setTimeout(() => { retry = null; if (!stopped) watch(); }, 3000);
      }
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  ); };
  watch();
  return () => { stopped = true; if (retry) clearTimeout(retry); navigator.geolocation.clearWatch(id); };
}

export interface ReplaySource {
  points: TelemetryPoint[];
  startDate?: Date;
}

/** 読み込んだログの再生 (試すため)。点を、時刻のとおり (速さの倍率をかけて) 渡す */
export function replayFeed(log: ReplaySource | undefined, speed: number, onFix: (f: LiveFix) => void): StopFeed {
  if (!log || log.points.length < 2) return () => {};
  const base = log.startDate?.getTime() ?? Date.now();
  const pts = log.points;
  const startPerf = performance.now();
  const t0 = pts[0].time;
  let i = 0;
  const iv = setInterval(() => {
    const simTime = t0 + ((performance.now() - startPerf) / 1000) * speed;
    while (i < pts.length && pts[i].time <= simTime) {
      const p = pts[i];
      onFix({ tMs: base + p.time * 1000, latitude: p.latitude, longitude: p.longitude, speedKmh: p.speed, altitude: p.altitude, valid: true });
      i++;
    }
    if (i >= pts.length) clearInterval(iv);
  }, 50);
  return () => clearInterval(iv);
}
