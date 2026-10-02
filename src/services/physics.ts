import { TelemetryPoint } from '../types/telemetry';

const GRAVITY = 9.80665; // m/s^2

/**
 * 2点間の緯度経度から距離(メートル)と方位角(度)を計算する (Hubeny / Haversine)
 */
export function calculateGeoDistanceAndHeading(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): { distanceMeters: number; headingDeg: number } {
  const R = 6378137; // 地球半径 (m)
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const radLat1 = (lat1 * Math.PI) / 180;
  const radLat2 = (lat2 * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(radLat1) * Math.cos(radLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceMeters = R * c;

  const y = Math.sin(dLon) * Math.cos(radLat2);
  const x =
    Math.cos(radLat1) * Math.sin(radLat2) -
    Math.sin(radLat1) * Math.cos(radLat2) * Math.cos(dLon);
  let headingDeg = (Math.atan2(y, x) * 180) / Math.PI;
  if (headingDeg < 0) headingDeg += 360;

  return { distanceMeters, headingDeg };
}

/**
 * テレメトリデータ全体の物理パラメータ（加減速G、コーナリングG、合算G、旋回半径、ドリフト角度）を算出・補正
 */
export function calculatePhysics(points: TelemetryPoint[]): TelemetryPoint[] {
  if (points.length === 0) return [];

  const n = points.length;
  const result: TelemetryPoint[] = points.map((p, i) => ({
    ...p,
    index: i,
    accelG: 0,
    corneringG: 0,
    combinedG: 0,
    turningRadius: 9999,
    driftAngle: 0
  }));

  // 累積距離と方位角の検証・補正
  let currentDistKm = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const prev = result[i - 1];
      const cur = result[i];
      const { distanceMeters, headingDeg } = calculateGeoDistanceAndHeading(
        prev.latitude,
        prev.longitude,
        cur.latitude,
        cur.longitude
      );

      // 距離が未設定または不整合な場合は計算値を使用
      if (cur.distance === 0 || cur.distance < prev.distance) {
        currentDistKm += distanceMeters / 1000;
        cur.distance = Number(currentDistKm.toFixed(4));
      } else {
        currentDistKm = cur.distance;
      }

      if (cur.heading === 0 && distanceMeters > 0.1) {
        cur.heading = headingDeg;
      }
    }
  }

  // 加減速G (Longitudinal G), コーナリングG (Lateral G), 旋回半径 R
  // 平滑化ウィンドウ (前後の点を使って微分)
  const windowSize = 2; // ±2 points (10Hzで約0.4秒区間)

  for (let i = 0; i < n; i++) {
    const i1 = Math.max(0, i - windowSize);
    const i2 = Math.min(n - 1, i + windowSize);
    const dt = result[i2].time - result[i1].time;

    if (dt > 0.001) {
      // 速度差から加減速G (m/s^2 / 9.80665)
      const v1_ms = result[i1].speed / 3.6;
      const v2_ms = result[i2].speed / 3.6;
      const v_cur_ms = result[i].speed / 3.6;
      const accel_ms2 = (v2_ms - v1_ms) / dt;
      const accelG = accel_ms2 / GRAVITY;

      // 方位角変化 (dTheta)
      let dHeading = result[i2].heading - result[i1].heading;
      // 360度境界処理
      while (dHeading > 180) dHeading -= 360;
      while (dHeading < -180) dHeading += 360;

      const yawRateRad = ((dHeading * Math.PI) / 180) / dt; // rad/s
      // Lateral acceleration = v * omega
      // 右旋回を正(+), 左旋回を負(-)
      const latAccel_ms2 = v_cur_ms * yawRateRad;
      const corneringG = latAccel_ms2 / GRAVITY;

      // 旋回半径 R = v / |omega|
      let turningRadius = 9999;
      if (Math.abs(yawRateRad) > 0.001 && v_cur_ms > 2) {
        turningRadius = Math.min(9999, Math.abs(v_cur_ms / yawRateRad));
      }

      // ドリフト角度 (姿勢角変化率と移動ベクトルのズレ)
      // 横滑り角 beta ≈ lateral acceleration / (v * yaw rate) または 方位と速度ベクトルの差
      let driftAngle = 0;
      if (v_cur_ms > 5 && Math.abs(corneringG) > 0.3) {
        // コーナリング時の姿勢偏差の推定
        const slip = Math.atan2(latAccel_ms2 * 0.15, v_cur_ms) * (180 / Math.PI);
        driftAngle = Math.min(60, Math.max(-60, slip));
      }

      // 合算G
      const combinedG = Math.sqrt(accelG * accelG + corneringG * corneringG);

      result[i].accelG = Number(accelG.toFixed(3));
      result[i].corneringG = Number(corneringG.toFixed(3));
      result[i].combinedG = Number(combinedG.toFixed(3));
      result[i].turningRadius = Number(turningRadius.toFixed(1));
      result[i].driftAngle = Number(driftAngle.toFixed(1));
    }
  }

  // 異常値フィルタリング (GPSの一時的飛びによるスパイク除去)
  for (let i = 1; i < n - 1; i++) {
    if (Math.abs(result[i].accelG) > 3.0) {
      result[i].accelG = (result[i - 1].accelG + result[i + 1].accelG) / 2;
    }
    if (Math.abs(result[i].corneringG) > 3.5) {
      result[i].corneringG = (result[i - 1].corneringG + result[i + 1].corneringG) / 2;
    }
    result[i].combinedG = Math.sqrt(
      result[i].accelG * result[i].accelG + result[i].corneringG * result[i].corneringG
    );
  }

  return result;
}
