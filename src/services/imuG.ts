import type { GSource } from '../engine/imuG';
export * from '../engine/imuG';
const KEY = 'ds_g_source';
export function getGSource(): GSource {
  try { return localStorage.getItem(KEY) === 'calc' ? 'calc' : 'sensor'; } catch { return 'sensor'; }
}
export function setGSource(s: GSource): void {
  try { localStorage.setItem(KEY, s); } catch { /* 覚えられなくても使える */ }
}
