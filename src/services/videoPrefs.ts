// 動画まわりの設定 (この端末に覚える)。読めない環境 (保存が止められているなど) では既定の値を使う

const ADD_VIDEO_GPS_LOG_KEY = 'ds_add_video_gps_log';

/**
 * GoPro の動画の GPS も走行ログとして加えるか (既定: 加える)。
 * 加えないときも、同じ時間の、より記録の細かいログがなければ加える (動画を合わせるログがなくなるため)。LATER-12
 */
export function getAddVideoGpsLog(): boolean {
  try {
    return localStorage.getItem(ADD_VIDEO_GPS_LOG_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setAddVideoGpsLog(value: boolean): void {
  try {
    localStorage.setItem(ADD_VIDEO_GPS_LOG_KEY, value ? '1' : '0');
  } catch {}
}
