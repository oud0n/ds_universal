export interface TelemetryPoint {
  index: number;
  time: number;          // 秒単位 (t=0からの経過時間)
  oleDate?: number;      // COM / OLE Automation Date
  satellites?: number;   // 衛星数 (記録されている形式のみ)
  timestamp?: string;    // 日時文字列 (例: "2026-09-21 10:23:45.100")
  latitude: number;      // 緯度 (度)
  longitude: number;     // 経度 (度)
  altitude: number;      // 標高 (m)
  altitudeMissing?: boolean; // 標高が記録されていない点 (altitude は 0。書き出しでは空欄にする)
  speed: number;         // 車速 (km/h)
  heading: number;       // 方位角 (0-360度)
  distance: number;      // 累積走行距離 (km)
  
  // 計算値 (Physics)
  accelG: number;        // 加減速G (Longitudinal: +加速, -減速)
  corneringG: number;    // コーナリングG (Lateral: +右, -左)
  combinedG: number;     // 合算G
  turningRadius: number; // 旋回半径 R (m)
  driftAngle: number;    // ドリフト角度 (度: 進行方向と車体姿勢の偏差)
  sectorIndex?: number;  // 通過中のセクター (0-indexed)
}

export interface Sector {
  id: string;
  name: string;          // S1, S2, S3 など
  latA: number;
  lonA: number;
  latB: number;
  lonB: number;
  splitDistance?: number;// 基準距離 (km)
}

export interface ControlLine {
  name: string;
  latA: number;
  lonA: number;
  latB: number;
  lonB: number;
}

export interface LapSectorResult {
  sectorId: string;
  sectorName: string;
  time: number;          // セクター所要時間 (秒)
  splitTime: number;     // 通過タイム (秒)
  distance: number;      // セクター区間距離 (km)。1 つ前のセクター線 (S1 は計測線) からの長さ
  splitDistance: number; // 計測線からこのセクター線までの距離 (km)。splitTime と同じく累積
  maxSpeed: number;      // セクター最高速 (km/h)
  minSpeed: number;      // セクター最低速 (km/h)
  avgSpeed: number;      // セクター平均速度 (km/h)
  isBest?: boolean;      // セクターベスト判定
  // セクター線の通過を検出できず、等分などで推定した値 (この区間の始まりか終わりが推定)。セクターベスト・理論ベストには使わない
  isEstimated?: boolean;
}

export interface Lap {
  lapNumber: number;
  lapTime: number;       // 秒 (例: 119.511)
  startTime: number;
  endTime: number;
  startIndex: number;
  endIndex: number;
  distance: number;      // km
  topSpeed: number;      // km/h
  bottomSpeed: number;   // km/h
  avgSpeed: number;      // km/h
  isBestLap?: boolean;
  // 計測線で区切れず、ログ全体を 1 周として扱ったもの
  isWholeSession?: boolean;
  // 計測線の通過が 1 回で、通過点から末尾までを 1 周として扱ったもの (終わりが次の通過に届いていない)
  isPartialLap?: boolean;
  sectors: LapSectorResult[];
  points: TelemetryPoint[];
}

export interface Session {
  id: string;
  fileName: string;
  sessionName: string;
  driverName?: string;
  vehicleName?: string;
  date: string;
  circuitName: string;
  samplingRate: number;  // Hz (例: 10, 20)
  totalDistance: number;
  points: TelemetryPoint[];
  laps: Lap[];
  bestLapIndex: number;
  theoreticalBestTime: number; // 各セクターベストの合計
  controlLine?: ControlLine;
  sectors: Sector[];
  // コース図 (.pth や OpenStreetMap から取得した線)。セッションごとに持ち、表示は基準車のセッションのものを使う
  pathPolylines?: Array<Array<[number, number]>>;
}

export type CarSlotColor = 'red' | 'blue' | 'green' | 'orange';

// 車両どうしを比べる基準。distance: 同じ距離の地点 / time: 周の開始からの経過時間が同じ時点
export type CompareAxis = 'distance' | 'time';

export interface SelectedCarSlot {
  slot: number;          // 0: Red, 1: Blue, 2: Green, 3: Orange
  sessionId: string;
  lapNumber: number;
  colorHex: string;
  label: string;
  // 重ね合わせの距離の手動補正 (m)。正なら基準車に対して前 (グラフの右) にずらす
  distanceOffsetM?: number;
}

export interface CircuitPreset {
  id: string;
  name: string;
  country: string;
  centerLat: number;
  centerLon: number;
  // 計測線を持たないプリセットもある (中心座標だけでコース名とコース図を引く)
  controlLine?: ControlLine;
  sectors: Sector[];
  pathPolylines?: Array<Array<[number, number]>>; // [lon, lat][]
  pthFile?: string | null;
  sciFile?: string | null;
}
