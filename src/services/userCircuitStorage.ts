/**
 * ユーザーが設置した公式または独自コースデータ (.pth / .cln / .sci) の管理サービス
 */
import { ControlLine, Sector } from '../types/telemetry';
import { parsePth, parseCln } from './pthParser';

export interface UserCircuitItem {
  name: string;
  pthText?: string;
  clnText?: string;
  sciText?: string;
  polylines?: Array<Array<[number, number]>>;
  controlLine?: ControlLine;
  sectors?: Sector[];
}

class UserCircuitStorage {
  private circuits: Map<string, UserCircuitItem> = new Map();
  private isLoadedFromDb: boolean = false;

  constructor() {
    this.loadFromStorage();
  }

  // LocalStorage / IndexedDB からキャッシュ読み込み
  private loadFromStorage() {
    try {
      const saved = localStorage.getItem('ds_user_circuits');
      if (saved) {
        const list: Array<[string, UserCircuitItem]> = JSON.parse(saved);
        this.circuits = new Map(list);
        console.log(`[UserCircuit] 保存済みのユーザーコース ${this.circuits.size} 件を復元`);
      }
    } catch (e) {
      console.warn('[UserCircuit] 復元エラー:', e);
    }
  }

  private saveToStorage() {
    try {
      const arr = Array.from(this.circuits.entries());
      localStorage.setItem('ds_user_circuits', JSON.stringify(arr));
    } catch (e) {
      console.warn('[UserCircuit] ストレージ保存容量上限等のエラー:', e);
    }
  }

  // ユーザーが選択したファイル群（フォルダ丸ごとインポート対応）の読み込み
  public async importFiles(files: FileList | File[]): Promise<{
    pthCount: number;
    clnCount: number;
    sciCount: number;
  }> {
    let pthCount = 0;
    let clnCount = 0;
    let sciCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const name = file.name;
      const ext = name.split('.').pop()?.toLowerCase();
      const baseId = name.replace(/\.[^/.]+$/, '').toLowerCase();

      try {
        const text = await file.text();
        let item = this.circuits.get(baseId) || { name: baseId };

        if (ext === 'pth') {
          item.pthText = text;
          item.polylines = parsePth(text);
          pthCount++;
        } else if (ext === 'cln') {
          item.clnText = text;
          item.controlLine = parseCln(text);
          clnCount++;
        } else if (ext === 'sci') {
          item.sciText = text;
          sciCount++;
        }

        this.circuits.set(baseId, item);
      } catch (err) {
        console.warn(`ファイル ${name} のインポート失敗:`, err);
      }
    }

    this.saveToStorage();
    return { pthCount, clnCount, sciCount };
  }

  // 座標から近傍のユーザー設置サーキットを検索
  public findNearCircuit(lat: number, lon: number, maxDistMeters: number = 15000): UserCircuitItem | null {
    let closest: UserCircuitItem | null = null;
    let minD = maxDistMeters;

    for (const [_, item] of this.circuits.entries()) {
      if (item.controlLine) {
        const cLat = (item.controlLine.latA + item.controlLine.latB) / 2;
        const cLon = (item.controlLine.lonA + item.controlLine.lonB) / 2;
        const dLat = (cLat - lat) * 111320;
        const dLon = (cLon - lon) * (111320 * Math.cos((lat * Math.PI) / 180));
        const dist = Math.sqrt(dLat * dLat + dLon * dLon);
        if (dist < minD) {
          minD = dist;
          closest = item;
        }
      }
    }

    return closest;
  }

  // IDまたはファイル名からコース図ポリラインを取得
  public getPolylines(circuitId: string): Array<Array<[number, number]>> | undefined {
    const clean = circuitId.toLowerCase();
    const item = this.circuits.get(clean);
    if (item && item.polylines) return item.polylines;

    // 前方・後方一致検索
    for (const [key, val] of this.circuits.entries()) {
      if (key.includes(clean) || clean.includes(key)) {
        if (val.polylines) return val.polylines;
      }
    }
    return undefined;
  }

  public getCircuitCount(): number {
    return this.circuits.size;
  }

  public clear(): void {
    this.circuits.clear();
    localStorage.removeItem('ds_user_circuits');
  }
}

export const userCircuitStorage = new UserCircuitStorage();
