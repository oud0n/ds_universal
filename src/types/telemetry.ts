export interface TelemetryPoint {
  index: number;
  time: number;          // 秒単位 (t=0からの経過時間)
  oleDate?: number;      // COM / OLE Automation Date
  timestamp?: string;    // 日時文字列 (例: "2026-09-21 10:23:45.100")
  latitude: number;      // 緯度 (度)
  longitude: number;     // 経度 (度)
  altitude: number;      // 標高 (m)
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
  distance: number;      // セクター区間距離 (km)
  maxSpeed: number;      // セクター最高速 (km/h)
  minSpeed: number;      // セクター最低速 (km/h)
  avgSpeed: number;      // セクター平均速度 (km/h)
  isBest?: boolean;      // セクターベスト判定
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
}

export type CarSlotColor = 'red' | 'blue' | 'green' | 'orange';

export interface SelectedCarSlot {
  slot: number;          // 0: Red, 1: Blue, 2: Green, 3: Orange
  sessionId: string;
  lapNumber: number;
  colorHex: string;
  label: string;
}

export interface CircuitPreset {
  id: string;
  name: string;
  country: string;
  centerLat: number;
  centerLon: number;
  controlLine: ControlLine;
  sectors: Sector[];
  pathPolylines?: Array<Array<[number, number]>>; // [lon, lat][]
  pthFile?: string | null;
  sciFile?: string | null;
}
