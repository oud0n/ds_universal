import { describe, expect, it } from 'vitest';
import type { CameraLens } from '../../native/contract';
import { DEFAULT_CAMERA, dualPlan, frontParams, type CameraSettings } from './phoneCamera';

const lens = (id: string, kind: CameraLens['kind'], multi: CameraLens['presets']): CameraLens => ({
  id, kind, position: kind === 'front' ? 'front' : 'back', zoom: kind === 'ultraWide' ? 0.5 : kind === 'tele' ? 5 : 1,
  isoMin: 32, isoMax: 3200, presets: ['1080p30', '1080p60', '2160p30', '2160p60'], multiCamPresets: multi
});
const LENSES = [lens('uw', 'ultraWide', ['1080p30', '1080p60']), lens('w', 'wide', ['1080p30', '1080p60']), lens('t', 'tele', []), lens('f', 'front', ['1080p30'])];
const settings = (p: Partial<CameraSettings>): CameraSettings => ({ ...DEFAULT_CAMERA, enabled: true, ...p });

describe('前と後ろを同時に撮る', () => {
  it('同時に撮れない端末では、前は撮らない', () => {
    const s = settings({ front: { enabled: true, preset: '1080p30', iso: null } });
    expect(dualPlan(s, LENSES, false)).toBeNull();
    expect(frontParams(s, dualPlan(s, LENSES, false))).toBeNull();
  });

  it('後ろのレンズは、同時に撮れるものにする (望遠・前を選んでいたら広角)', () => {
    expect(dualPlan(settings({ lensId: 't' }), LENSES, true)?.back.id).toBe('w');
    expect(dualPlan(settings({ lensId: 'f' }), LENSES, true)?.back.id).toBe('w');
    expect(dualPlan(settings({ lensId: 'uw' }), LENSES, true)?.back.id).toBe('uw');
  });

  it('前の画質は同時に撮れるものに直し、ISO は前の設定のもの', () => {
    const s = settings({ front: { enabled: true, preset: '1080p60', iso: 400 } });
    expect(frontParams(s, dualPlan(s, LENSES, true))).toEqual({ preset: '1080p30', iso: 400 });
    expect(frontParams(settings({}), dualPlan(settings({}), LENSES, true))).toBeNull();
  });
});
