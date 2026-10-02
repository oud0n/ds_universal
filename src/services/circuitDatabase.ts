import { CircuitPreset, ControlLine, Sector } from '../types/telemetry';
import { userCircuitStorage } from './userCircuitStorage';
import { fetchOsmCircuitPolylines } from './osmCircuitService';

// 主要サーキット（オープンな地理情報に基づく詳細プリセット定義）
export const CIRCUIT_PRESETS: CircuitPreset[] = [
  {
    id: 'fsw',
    name: '富士スピードウェイ (FSW)',
    country: 'JP',
    centerLat: 35.372183,
    centerLon: 138.927048,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 35.372350,
      lonA: 138.926850,
      latB: 35.372020,
      lonB: 138.927250
    },
    sectors: [
      { id: 'fsw_s1', name: 'Sector 1', latA: 35.367500, lonA: 138.919800, latB: 35.367800, lonB: 138.920200 },
      { id: 'fsw_s2', name: 'Sector 2', latA: 35.364200, lonA: 138.929800, latB: 35.364600, lonB: 138.930200 },
      { id: 'fsw_s3', name: 'Sector 3', latA: 35.372350, lonA: 138.926850, latB: 35.372020, lonB: 138.927250 }
    ]
  },
  {
    id: 'suzuka',
    name: '鈴鹿サーキット (Suzuka Circuit)',
    country: 'JP',
    centerLat: 34.844805,
    centerLon: 136.538881,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 34.844950,
      lonA: 136.538700,
      latB: 34.844650,
      lonB: 136.539050
    },
    sectors: [
      { id: 'suzuka_s1', name: 'Sector 1 (S字〜逆バンク)', latA: 34.847500, lonA: 136.531200, latB: 34.847800, lonB: 136.531600 },
      { id: 'suzuka_s2', name: 'Sector 2 (デグナー〜スプーン)', latA: 34.851200, lonA: 136.524500, latB: 34.851600, lonB: 136.524900 },
      { id: 'suzuka_s3', name: 'Sector 3 (130R〜シケイン)', latA: 34.844950, lonA: 136.538700, latB: 34.844650, lonB: 136.539050 }
    ]
  },
  {
    id: 'tsukuba2000',
    name: '筑波サーキット コース2000 (TC2000)',
    country: 'JP',
    centerLat: 36.149200,
    centerLon: 139.921300,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 36.149350,
      lonA: 139.921100,
      latB: 36.149050,
      lonB: 139.921500
    },
    sectors: [
      { id: 'tc_s1', name: 'Sector 1 (第1ヘアピン)', latA: 36.147200, lonA: 139.919500, latB: 36.147500, lonB: 139.919800 },
      { id: 'tc_s2', name: 'Sector 2 (第2ヘアピン)', latA: 36.151800, lonA: 139.922100, latB: 36.152100, lonB: 139.922400 },
      { id: 'tc_s3', name: 'Sector 3 (最終コーナー)', latA: 36.149350, lonA: 139.921100, latB: 36.149050, lonB: 139.921500 }
    ]
  },
  {
    id: 'tsukuba1000',
    name: '筑波サーキット コース1000 (TC1000)',
    country: 'JP',
    centerLat: 36.153800,
    centerLon: 139.916800,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 36.153950,
      lonA: 139.916600,
      latB: 36.153650,
      lonB: 139.917000
    },
    sectors: []
  },
  {
    id: 'nikko',
    name: '日光サーキット (Nikko Circuit)',
    country: 'JP',
    centerLat: 36.662371,
    centerLon: 139.862593,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 36.662488,
      lonA: 139.862453,
      latB: 36.662254,
      lonB: 139.862732
    },
    sectors: []
  },
  {
    id: 'motegi',
    name: 'モビリティリゾートもてぎ (Motegi Road Course)',
    country: 'JP',
    centerLat: 36.533200,
    centerLon: 140.227500,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 36.533350,
      lonA: 140.227300,
      latB: 36.533050,
      lonB: 140.227700
    },
    sectors: []
  },
  {
    id: 'sugo',
    name: 'スポーツランドSUGO (Sportsland SUGO)',
    country: 'JP',
    centerLat: 38.140200,
    centerLon: 140.778500,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 38.140350,
      lonA: 140.778300,
      latB: 38.140050,
      lonB: 140.778700
    },
    sectors: []
  },
  {
    id: 'autopolis',
    name: 'オートポリス (Autopolis)',
    country: 'JP',
    centerLat: 33.038766,
    centerLon: 130.973247,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 33.039045,
      lonA: 130.973474,
      latB: 33.038487,
      lonB: 130.973020
    },
    sectors: []
  },
  {
    id: 'okayama',
    name: '岡山国際サーキット (Okayama International)',
    country: 'JP',
    centerLat: 34.914500,
    centerLon: 134.221500,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 34.914650,
      lonA: 134.221300,
      latB: 34.914350,
      lonB: 134.221700
    },
    sectors: []
  },
  {
    id: 'sodegaura',
    name: '袖ヶ浦フォレストレースウェイ (Sodegaura)',
    country: 'JP',
    centerLat: 35.390500,
    centerLon: 140.061000,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 35.390650,
      lonA: 140.060800,
      latB: 35.390350,
      lonB: 140.061200
    },
    sectors: []
  },
  {
    id: 'honjo',
    name: '本庄サーキット (Honjo Circuit)',
    country: 'JP',
    centerLat: 36.216000,
    centerLon: 139.141500,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 36.216150,
      lonA: 139.141300,
      latB: 36.215850,
      lonB: 139.141700
    },
    sectors: []
  },
  {
    id: 'ebisu_east',
    name: 'エビスサーキット 東コース (Ebisu East)',
    country: 'JP',
    centerLat: 37.647000,
    centerLon: 140.385000,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 37.647150,
      lonA: 140.384800,
      latB: 37.646850,
      lonB: 140.385200
    },
    sectors: []
  },
  {
    id: 'meihan',
    name: '名阪スポーツランド (Meihan Sportsland)',
    country: 'JP',
    centerLat: 34.618000,
    centerLon: 136.002000,
    controlLine: {
      name: 'Start/Finish Line',
      latA: 34.618150,
      lonA: 136.001800,
      latB: 34.617850,
      lonB: 136.002200
    },
    sectors: []
  }
];

export const ALL_CIRCUITS: CircuitPreset[] = CIRCUIT_PRESETS;

/**
 * 緯度経度から最も近いサーキットプリセットを検索（自動認識）
 * 1. ユーザー設置サーキットから検索
 * 2. 登録済みプリセットから検索
 */
export function findMatchingCircuit(lat: number, lon: number): CircuitPreset | undefined {
  // 1. ユーザー設置データを確認
  const userMatch = userCircuitStorage.findNearCircuit(lat, lon, 15000);
  if (userMatch && userMatch.controlLine) {
    return {
      id: userMatch.name,
      name: `${userMatch.name} (ユーザー設置)`,
      country: 'JP',
      centerLat: (userMatch.controlLine.latA + userMatch.controlLine.latB) / 2,
      centerLon: (userMatch.controlLine.lonA + userMatch.controlLine.lonB) / 2,
      controlLine: userMatch.controlLine,
      sectors: userMatch.sectors || [],
      pathPolylines: userMatch.polylines
    };
  }

  // 2. プリセットから検索
  let closest: CircuitPreset | undefined;
  let minDistance = 15000; // 15km以内

  for (const circuit of CIRCUIT_PRESETS) {
    const dLat = (circuit.centerLat - lat) * 111320;
    const dLon = (circuit.centerLon - lon) * (111320 * Math.cos((lat * Math.PI) / 180));
    const distMeters = Math.sqrt(dLat * dLat + dLon * dLon);

    if (distMeters < minDistance) {
      minDistance = distMeters;
      closest = circuit;
    }
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
  // 1. ユーザー設置データ確認
  const userPolylines = userCircuitStorage.getPolylines(circuit.id);
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
