import { CircuitPreset, TelemetryPoint } from '../types/telemetry';
import { countGateCrossings, passesNearControlLine } from './lapCalculator';
import { userCircuitStorage } from './userCircuitStorage';
import { fetchOsmCircuitPolylines } from './osmCircuitService';
import { parseCln, parseSci } from './pthParser';
import courseIndex from '../../courses/index.json';

// 内蔵のコース (独自に作成したデータ)。リポジトリの courses/ に、デジスパイスと同じ形式のファイルで置いて同梱する
// - index.json: コースの一覧 (名前・中心の座標・ファイル名・作り方のメモ)
// - <id>.cln: 計測線、<id>.sci: セクター線 (公式の .sci と同じく、フィニッシュ (計測線) は含まない)
// 作り方と出典は courses/README.md。修正の依頼はファイルごとに Issue / PR で受け付ける
// 出典: © OpenStreetMap contributors (Open Database License 1.0, https://www.openstreetmap.org/copyright)
//       国土地理院 シームレス空中写真 (https://maps.gsi.go.jp/development/ichiran.html)
interface CourseIndexEntry {
  id: string;
  name: string;
  country: string;
  center: number[]; // [緯度, 経度]
  cln?: string;
  sci?: string;
}
const courseFiles = import.meta.glob('../../courses/*.{cln,sci}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const courseFile = (name: string) => courseFiles[`../../courses/${name}`];

export const CIRCUIT_PRESETS: CircuitPreset[] = (courseIndex as unknown as CourseIndexEntry[]).map(c => {
  const cln = c.cln ? courseFile(c.cln) : undefined;
  const controlLine = cln ? parseCln(cln, 'Start/Finish Line') : undefined;
  const sci = c.sci ? courseFile(c.sci) : undefined;
  // フィニッシュ (計測線まで) を最後の区間として足す (公式の .sci を読み込んだときと同じ)
  const sectors = sci && controlLine
    ? [...parseSci(sci, c.id), { id: `${c.id}_finish`, name: '', latA: controlLine.latA, lonA: controlLine.lonA, latB: controlLine.latB, lonB: controlLine.lonB }]
    : [];
  sectors.forEach((sec, i) => { sec.name = `S${i + 1}`; });
  return { id: c.id, name: c.name, country: c.country, centerLat: c.center[0], centerLon: c.center[1], ...(controlLine ? { controlLine } : {}), sectors };
});

export const ALL_CIRCUITS: CircuitPreset[] = CIRCUIT_PRESETS;

/**
 * 緯度経度から最も近いサーキットプリセットを検索（自動認識）
 * 1. ユーザー設置サーキットから検索
 * 2. 登録済みプリセットから検索
 * 走行データ (points) を渡すと、同じ敷地に複数のコースがある場合 (筑波 2000 / 1000 など) に、
 * 計測線で最も多く周回を区切れたコースを選ぶ
 */
export function findMatchingCircuit(lat: number, lon: number, points?: TelemetryPoint[]): CircuitPreset | undefined {
  // 1. ユーザー設置データを確認 (近くに複数あるときは、計測線を実際に通過しているコースを優先する)
  const found = userCircuitStorage.findNearCircuit(lat, lon, 15000, points);
  const userMatch = found?.circuit;
  // 走行データがあって、近くのユーザーコースの計測線をどれも通過していないときは、すぐには使わない。
  // 内蔵のコースの計測線を通過していればそちらを、どちらも通過していなければ、計測線がログの近く (1 km 以内) にあるときだけ使う
  // (近くにあるだけの別のコースを使うと周回が区切れず、内蔵のコースや仮の計測線も使われなくなるため)
  const preset = findMatchingPreset(lat, lon, points);
  const presetCrossed = !!(points && preset?.controlLine && countGateCrossings(points, preset.controlLine) > 0);
  const useUser = userMatch && (found!.crossings !== 0 || (!presetCrossed && !!points && passesNearControlLine(points, userMatch.controlLine)));
  if (userMatch && useUser) {
    return {
      id: `user:${userMatch.id}`,
      name: `${userMatch.name} (ユーザー設置)`,
      country: 'JP',
      centerLat: (userMatch.controlLine.latA + userMatch.controlLine.latB) / 2,
      centerLon: (userMatch.controlLine.lonA + userMatch.controlLine.lonB) / 2,
      controlLine: userMatch.controlLine,
      sectors: userMatch.sectors,
      pathPolylines: userMatch.polylines
    };
  }

  return preset;
}

/** 内蔵のコースから検索 (近くに複数あるときは、計測線を実際に通過しているコースを優先する) */
function findMatchingPreset(lat: number, lon: number, points?: TelemetryPoint[]): CircuitPreset | undefined {
  // 2. プリセットから検索
  let closest: CircuitPreset | undefined;
  let minDistance = 15000; // 15km以内
  const nearby: CircuitPreset[] = [];

  for (const circuit of CIRCUIT_PRESETS) {
    const dLat = (circuit.centerLat - lat) * 111320;
    const dLon = (circuit.centerLon - lon) * (111320 * Math.cos((lat * Math.PI) / 180));
    const distMeters = Math.sqrt(dLat * dLat + dLon * dLon);

    if (distMeters < minDistance) {
      minDistance = distMeters;
      closest = circuit;
    }
    if (distMeters < 15000) nearby.push(circuit);
  }

  // 近くに候補が複数あるときは、実際の走行で計測線を通過しているコースを優先する
  if (points && nearby.length > 1) {
    let bestLaps = 0;
    let best: CircuitPreset | undefined;
    for (const circuit of nearby) {
      if (!circuit.controlLine) continue;
      // 周回の数ではなく計測線を通過した回数で比べる (通過が 1 回のログでも区別できるように)
      const count = countGateCrossings(points, circuit.controlLine);
      // 同数なら先頭位置に近い方 (closest) を残す
      if (count > bestLaps || (count === bestLaps && count > 0 && circuit === closest)) {
        bestLaps = count;
        best = circuit;
      }
    }
    if (best) return best;
  }

  return closest;
}

/**
 * コース図ポリラインの解決
 * 優先順位:
 * 1. ユーザーが設置したデータ内のポリライン
 * 2. OpenStreetMap (OSM) から動的取得
 */
/** 読み込み済みのコースデータにある、このコースのコース図: ユーザーコースならそのコース図、内蔵のコースなら計測線 (なければ中心) の近くを通るコース図 */
export function findUserPolylines(circuit: CircuitPreset): Array<Array<[number, number]>> | undefined {
  return circuit.id.startsWith('user:')
    ? userCircuitStorage.getCircuitPolylines(circuit.id.slice(5))
    : circuit.controlLine
      ? userCircuitStorage.findPolylinesNear((circuit.controlLine.latA + circuit.controlLine.latB) / 2, (circuit.controlLine.lonA + circuit.controlLine.lonB) / 2, undefined, circuit.name)
      : userCircuitStorage.findPolylinesNear(circuit.centerLat, circuit.centerLon, 1500, circuit.name);
}

export async function resolveCircuitPolylines(
  circuit: CircuitPreset,
  sourcePreference: 'osm' | 'user' = 'osm'
): Promise<Array<Array<[number, number]>> | undefined> {
  // 1. ユーザー設置データ確認: ユーザーコースならそのコース図、内蔵のコースなら計測線 (なければ中心) の近くを通る読み込み済みのコース図
  await userCircuitStorage.ready;
  const userPolylines = findUserPolylines(circuit);
  if (userPolylines && userPolylines.length > 0) {
    console.log('[Circuit] ユーザー設置コース図を使用:', circuit.id);
    return userPolylines;
  }

  // 2. OpenStreetMap (OSM) から取得
  try {
    const osmPolylines = await fetchOsmCircuitPolylines(circuit.centerLat, circuit.centerLon);
    if (osmPolylines && osmPolylines.length > 0) {
      console.log('[Circuit] OpenStreetMap コース図を使用:', circuit.name);
      return osmPolylines;
    }
  } catch (err) {
    console.warn('[Circuit] OSM取得スキップ:', err);
  }

  return undefined;
}
