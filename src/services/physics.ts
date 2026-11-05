import * as core from '../engine/physics';
import type { TelemetryPoint } from '../types/telemetry';
import type { GFilterLevel } from '../engine/physics';
export * from '../engine/physics';
// G のならし方の設定 (端末に保存する)
const G_FILTER_STORAGE_KEY = 'ds_g_filter';
let gFilterLevel: GFilterLevel = (() => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(G_FILTER_STORAGE_KEY) : null;
    if (v === 'weak' || v === 'standard' || v === 'strong') return v;
  } catch {
    // 保存先が使えないときは既定のまま
  }
  // 既定は「強」(フリクションサークルの「なめらか」。持ち主、2026-11-01。前は「標準」)
  return 'strong';
})();

export function getGFilterLevel(): GFilterLevel {
  return gFilterLevel;
}

export function setGFilterLevel(level: GFilterLevel) {
  gFilterLevel = level;
  try {
    localStorage.setItem(G_FILTER_STORAGE_KEY, level);
  } catch {
    // 保存できなくても、この画面では使う
  }
}

export function calculatePhysics(points: TelemetryPoint[], level = getGFilterLevel()) { return core.calculatePhysics(points, level); }
export function applyGFilter(points: TelemetryPoint[], level = getGFilterLevel()) { return core.applyGFilter(points, level); }
