import { CircuitPreset, TelemetryPoint } from '../types/telemetry';
import { countGateCrossings, passesNearControlLine } from './lapCalculator';
import { userCircuitStorage } from './userCircuitStorage';
import { fetchOsmCircuitPolylines } from './osmCircuitService';

// 国内主要サーキットのプリセット (独自に作成したデータ)
// - 中心座標: OpenStreetMap のコース形状 (highway=raceway) の外接矩形の中心
// - 計測線: OpenStreetMap にスタートラインの情報は無いため、国土地理院の航空写真で
//   スタートライン付近の位置を確認し、OpenStreetMap のコース中心線に直交する線分として作成
//   (周回の区切りには使えるが、各サーキットの公式計測位置と一致するとは限らない)
// - セクター線は持たない (コース編集、または利用者が読み込んだコースデータで設定する)
//   本庄はスタートラインを写真から特定できなかったため、直線の中ほどに置いた仮の位置
// 出典: © OpenStreetMap contributors (Open Database License 1.0, https://www.openstreetmap.org/copyright)
//       国土地理院 シームレス空中写真 (https://maps.gsi.go.jp/development/ichiran.html)
export const CIRCUIT_PRESETS: CircuitPreset[] = [
  {
    id: 'fsw',
    name: '富士スピードウェイ (FSW)',
    country: 'JP',
    centerLat: 35.370533,
    centerLon: 138.926908,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 35.374012,
      lonA: 138.929525,
      latB: 35.373732,
      lonB: 138.929801
    },
    sectors: []
  },
  {
    id: 'suzuka',
    name: '鈴鹿サーキット (Suzuka Circuit)',
    country: 'JP',
    centerLat: 34.843668,
    centerLon: 136.532668,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 34.842904,
      lonA: 136.541016,
      latB: 34.842676,
      lonB: 136.540678
    },
    sectors: []
  },
  {
    id: 'tsukuba2000',
    name: '筑波サーキット コース2000 (TC2000)',
    country: 'JP',
    centerLat: 36.150480,
    centerLon: 139.921780,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 36.150127,
      lonA: 139.919345,
      latB: 36.150067,
      lonB: 139.919671
    },
    sectors: []
  },
  {
    id: 'tsukuba1000',
    name: '筑波サーキット コース1000 (TC1000)',
    country: 'JP',
    centerLat: 36.150718,
    centerLon: 139.924068,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 36.151054,
      lonA: 139.924331,
      latB: 36.151043,
      lonB: 139.924598
    },
    sectors: []
  },
  {
    id: 'nikko',
    name: '日光サーキット (Nikko Circuit)',
    country: 'JP',
    centerLat: 36.662164,
    centerLon: 139.862590,
    // 管制塔から架かる計測ゲートの位置 (航空写真で確認、ピットロードまで含む)。2026-10-17 に見直し
    // (以前の線は隣の直線に置いていたため、ベストラップが 0.08 秒短く出ていた)
    controlLine: {
      name: 'Start/Finish Line',
      latA: 36.662468,
      lonA: 139.862454,
      latB: 36.662254,
      lonB: 139.862701
    },
    sectors: []
  },
  {
    id: 'motegi',
    name: 'モビリティリゾートもてぎ (Motegi Road Course)',
    country: 'JP',
    centerLat: 36.532484,
    centerLon: 140.231982,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 36.533176,
      lonA: 140.226386,
      latB: 36.533331,
      lonB: 140.226739
    },
    sectors: []
  },
  {
    id: 'sugo',
    name: 'スポーツランドSUGO (Sportsland SUGO)',
    country: 'JP',
    centerLat: 38.140417,
    centerLon: 140.776664,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 38.142202,
      lonA: 140.780249,
      latB: 38.141880,
      lonB: 140.780208
    },
    sectors: []
  },
  {
    id: 'autopolis',
    name: 'オートポリス (Autopolis)',
    country: 'JP',
    centerLat: 33.036795,
    centerLon: 130.972808,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 33.037506,
      lonA: 130.975812,
      latB: 33.037206,
      lonB: 130.975575
    },
    sectors: []
  },
  {
    id: 'okayama',
    name: '岡山国際サーキット (Okayama International)',
    country: 'JP',
    centerLat: 34.915650,
    centerLon: 134.221622,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 34.914336,
      lonA: 134.218780,
      latB: 34.914359,
      lonB: 134.219174
    },
    sectors: []
  },
  {
    id: 'sodegaura',
    name: '袖ヶ浦フォレストレースウェイ (Sodegaura)',
    country: 'JP',
    centerLat: 35.394188,
    centerLon: 140.089014,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 35.394940,
      lonA: 140.087893,
      latB: 35.394798,
      lonB: 140.088173
    },
    sectors: []
  },
  {
    id: 'honjo',
    name: '本庄サーキット (Honjo Circuit)',
    country: 'JP',
    centerLat: 36.171078,
    centerLon: 139.107479,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 36.170682,
      lonA: 139.107542,
      latB: 36.170503,
      lonB: 139.107543
    },
    sectors: []
  },
  {
    id: 'ebisu_east',
    name: 'エビスサーキット 東コース (Ebisu East)',
    country: 'JP',
    centerLat: 37.643835,
    centerLon: 140.372223,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 37.644183,
      lonA: 140.370761,
      latB: 37.644375,
      lonB: 140.370884
    },
    sectors: []
  },
  {
    // 施設内に複数のコースがあり、地図上でコースを特定できないため計測線は持たない
    id: 'meihan',
    name: '名阪スポーツランド (Meihan Sportsland)',
    country: 'JP',
    centerLat: 34.635400,
    centerLon: 135.998000,
    sectors: []
  }
];

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
export async function resolveCircuitPolylines(
  circuit: CircuitPreset,
  sourcePreference: 'osm' | 'user' = 'osm'
): Promise<Array<Array<[number, number]>> | undefined> {
  // 1. ユーザー設置データ確認: ユーザーコースならそのコース図、内蔵のコースなら計測線 (なければ中心) の近くを通る読み込み済みのコース図
  await userCircuitStorage.ready;
  const userPolylines = circuit.id.startsWith('user:')
    ? userCircuitStorage.getCircuitPolylines(circuit.id.slice(5))
    : circuit.controlLine
      ? userCircuitStorage.findPolylinesNear((circuit.controlLine.latA + circuit.controlLine.latB) / 2, (circuit.controlLine.lonA + circuit.controlLine.lonB) / 2, undefined, circuit.name)
      : userCircuitStorage.findPolylinesNear(circuit.centerLat, circuit.centerLon, 1500, circuit.name);
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
