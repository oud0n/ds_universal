/**
 * 登録した Bluetooth LE の機器 (2026-10-20、PLAN-22)。
 * 機器ごとに、表示名 (画面だけ。何でもよい) と、ファイル名用の名前 (記録の .csv の名前。英小文字・数字・_ だけ) を持つ。
 * 名前はあとから変えられる (変えると、それより前の記録は前の名前のファイルのまま残る)。
 * デジスパイスは今までどおり bleLoggerLink が受け持つので、ここには入れない
 */

export type DeviceKind = 'racebox' | 'drogger' | 'hr' | 'obd' | 'gopro';
/** 機器の登録の画面のタブ */
export type DeviceGenre = 'position' | 'sensor' | 'camera';

export const DEVICE_KINDS: Record<DeviceKind, { genre: DeviceGenre; ja: string; en: string; defaultFile: string }> = {
  racebox: { genre: 'position', ja: 'RaceBox', en: 'RaceBox', defaultFile: 'racebox' },
  drogger: { genre: 'position', ja: 'Drogger', en: 'Drogger', defaultFile: 'drogger' },
  hr: { genre: 'sensor', ja: '心拍計', en: 'Heart rate monitor', defaultFile: 'hr' },
  obd: { genre: 'sensor', ja: 'OBD-II', en: 'OBD-II', defaultFile: 'obd' },
  gopro: { genre: 'camera', ja: 'GoPro', en: 'GoPro', defaultFile: 'gopro' }
};

export interface RegisteredDevice {
  /** Bluetooth の機器の ID (OS が決めるもの) */
  id: string;
  kind: DeviceKind;
  /** 機器が名乗る名前 (RaceBox Mini 1234567890 など) */
  bleName: string;
  /** 画面に出す名前 */
  displayName: string;
  /** 記録の .csv の名前に使う名前 (<走行>.<この名前>.csv) */
  fileName: string;
  addedAt: number;
}

const STORE_KEY = 'ds_devices_v1';
const FILE_NAME_RE = /^[a-z0-9][a-z0-9_]{0,39}$/;

/** ファイル名用の名前を確かめる。問題なければ null */
export function checkDeviceFileName(name: string, others: RegisteredDevice[] = [], selfId?: string): { ja: string; en: string } | null {
  if (!name) return { ja: 'ファイル名用の名前を入れてください', en: 'Enter a name for files' };
  if (!FILE_NAME_RE.test(name)) {
    return {
      ja: 'ファイル名用の名前は、半角の英小文字・数字と _ だけ (先頭は英小文字か数字、40 文字まで) です',
      en: 'Use lowercase half-width letters, digits and _ only (start with a letter or digit, up to 40 characters)'
    };
  }
  if (others.some(d => d.id !== selfId && d.fileName === name)) {
    return { ja: 'ほかの機器と同じ名前です (記録のファイルが混ざります)', en: 'Another device uses this name (their files would mix)' };
  }
  return null;
}

/** ファイル名用の名前の候補 (種類の名前。同じ種類がもうあれば _2・_3 …) */
export function suggestFileName(kind: DeviceKind, others: RegisteredDevice[]): string {
  const base = DEVICE_KINDS[kind].defaultFile;
  const used = new Set(others.map(d => d.fileName));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}

export function loadDevices(): RegisteredDevice[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter(d => d && typeof d.id === 'string' && d.kind in DEVICE_KINDS) : [];
  } catch {
    return [];
  }
}

export function saveDevices(list: RegisteredDevice[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    // 保存できなくても、今は使える
  }
}

/** 登録する (同じ機器なら置き換える)。名前を確かめてから呼ぶ */
export function upsertDevice(list: RegisteredDevice[], d: RegisteredDevice): RegisteredDevice[] {
  return [...list.filter(x => x.id !== d.id), d];
}

export function removeDevice(list: RegisteredDevice[], id: string): RegisteredDevice[] {
  return list.filter(x => x.id !== id);
}

export const devicesOfGenre = (list: RegisteredDevice[], genre: DeviceGenre) => list.filter(d => DEVICE_KINDS[d.kind].genre === genre);

/** 名前を変えるときの知らせ */
export const RENAME_NOTICE = {
  ja: 'この名前を、保存するファイルの名前に使います。変えると、それより前の記録は前の名前のファイルのまま残ります。',
  en: 'This name is used for the saved files. If you change it, earlier records stay in files with the old name.'
};
