import { describe, expect, it } from 'vitest';
import { planRunDelete } from './runDelete';
import type { RunItem } from './runOpener';
import type { RunFileInfo } from './runStore';

const file = (path: string, size = 100): RunFileInfo => ({ path, size, mtimeMs: 0, local: true });
const run = (folder: string, f: string, videos: string[] = []): RunItem => ({
  folder, file: f, courseName: null, startMs: null, lapCount: 0, best: null, videos, synced: false, folderVideos: [], laps: [], pending: false,
  entry: videos.length ? { updatedAt: '', videos: videos.map(name => ({ name })) } : null
});
const paths = (xs: Array<{ path: string }>) => xs.map(x => x.path).sort();

describe('走行を消すときに消すファイル (同じ日に何本も走ったとき)', () => {
  const D = 'sodegaura/20261025/';
  const A = '20261025100000', B = '20261025110000';
  const files = [
    file(`${D}${A}.nmea`), file(`${D}${A}.bon4`), file(`${D}${A}.iphone_imu.csv`), file(`${D}${A}.hr_driver.csv`),
    file(`${D}${A}.mov`), file(`${D}${A}_2.mov`), file(`${D}${A}_front.mov`), file(`${D}${A}_v2.mov`),
    file(`${D}${B}.nmea`), file(`${D}${B}.bon4`), file(`${D}${B}.iphone_imu.csv`), file(`${D}${B}.mov`),
    file(`${D}GX010001.MP4`), file(`${D}GX010002.MP4`), file(`${D}GX010003.MP4`),
    file('sodegaura/runs.json'), file('sodegaura/laptimes.json'), file(`sodegaura/20261024/${A}.nmea`)
  ];

  it('その走行のログ・センサー・内蔵カメラの動画・付けた動画だけを消し、ほかの走行のものは残す', () => {
    const a = run('sodegaura', `20261025/${A}.nmea`, ['GX010001.MP4', 'GX010002.MP4']);
    const b = run('sodegaura', `20261025/${B}.nmea`, ['GX010002.MP4']);
    const plan = planRunDelete(a, files, [a, b]);
    expect(paths(plan.remove)).toEqual([
      `${D}${A}.bon4`, `${D}${A}.hr_driver.csv`, `${D}${A}.iphone_imu.csv`, `${D}${A}.mov`, `${D}${A}.nmea`,
      `${D}${A}_2.mov`, `${D}${A}_front.mov`, `${D}${A}_v2.mov`, `${D}GX010001.MP4`
    ].sort());
    // B にも付いている GoPro の動画と、どの走行にも付いていない動画は残す
    expect(plan.keep).toEqual(expect.arrayContaining([
      { path: `${D}GX010002.MP4`, reason: 'shared-video' },
      { path: `${D}GX010003.MP4`, reason: 'unattached-video' }
    ]));
    // B のファイル・共有の控え・別の日のフォルダは消さない
    expect(plan.remove.some(f => f.path.includes(B) || f.path.endsWith('.json') || f.path.includes('20261024'))).toBe(false);
  });

  it('名前の形が合っても、別の走行のファイル (取り込んだ session と session_2) は消さない', () => {
    const E = 'nikko/20261020/';
    const fs2 = [file(`${E}session.nmea`), file(`${E}session.mov`), file(`${E}session_2.nmea`), file(`${E}session_2.mov`), file(`${E}session_3.mov`)];
    const s1 = run('nikko', '20261020/session.nmea');
    const s2 = run('nikko', '20261020/session_2.nmea');
    const plan = planRunDelete(s1, fs2, [s1, s2]);
    // session_3.mov は、session の 3 つめの録画 (session_3 という走行は無い)
    expect(paths(plan.remove)).toEqual([`${E}session.mov`, `${E}session.nmea`, `${E}session_3.mov`].sort());
    // session_2.mov は名前の形 (session の 2 つめの録画) が合うが、session_2 という走行があるので残す。session_2.nmea は候補にもならない
    expect(plan.keep).toEqual([{ path: `${E}session_2.mov`, reason: 'other-run' }]);
  });

  it('session_2 を消すときは、session_2 のファイルを消し、session のものは残す', () => {
    const E = 'nikko/20261020/';
    const fs2 = [file(`${E}session.nmea`), file(`${E}session.mov`), file(`${E}session_2.nmea`), file(`${E}session_2.mov`), file(`${E}session_2_front.mov`)];
    const s1 = run('nikko', '20261020/session.nmea');
    const s2 = run('nikko', '20261020/session_2.nmea');
    expect(paths(planRunDelete(s2, fs2, [s1, s2]).remove)).toEqual([`${E}session_2.mov`, `${E}session_2.nmea`, `${E}session_2_front.mov`].sort());
  });

  it('走行名に . があっても、ほかの走行の録画を消さない', () => {
    const E = 'unsorted/20261020/';
    const a = run('unsorted', '20261020/2026.10.25 run.nmea');
    const b = run('unsorted', '20261020/2026.10.25 run_2.nmea');
    const plan = planRunDelete(a, [file(`${E}2026.10.25 run.nmea`), file(`${E}2026.10.25 run_2.nmea`), file(`${E}2026.10.25 run_2.mov`)], [a, b]);
    expect(paths(plan.remove)).toEqual([`${E}2026.10.25 run.nmea`]);
  });

  it('走行名に記号があっても、ほかのファイルに広がらない', () => {
    const E = 'unsorted/20261020/';
    const r = run('unsorted', '20261020/a.b(1).nmea');
    const plan = planRunDelete(r, [file(`${E}a.b(1).nmea`), file(`${E}aXb(1).nmea`), file(`${E}a.b(1)x.nmea`)], [r]);
    expect(paths(plan.remove)).toEqual([`${E}a.b(1).nmea`]);
  });
});
