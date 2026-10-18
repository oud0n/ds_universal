import { ControlLine, Sector } from '../types/telemetry';
import { tr } from '../utils/i18n';

/**
 * デジスパイス コース図 (.pth) ファイルをパース
 * 戻り値: ポリラインの配列 (各ポリラインは [lon, lat] の配列)
 */
export function parsePth(pthText: string): Array<Array<[number, number]>> {
  const paths: Array<Array<[number, number]>> = [];
  const lines = pthText.split(/\r?\n/);

  let currentPath: Array<[number, number]> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === '<path>') {
      currentPath = [];
    } else if (trimmed.toLowerCase() === '</path>') {
      if (currentPath && currentPath.length > 0) {
        paths.push(currentPath);
      }
      currentPath = null;
    } else if (currentPath && trimmed.includes(',')) {
      const parts = trimmed.split(',');
      if (parts.length >= 2) {
        const lon = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        if (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90) {
          currentPath.push([lon, lat]);
        }
      }
    }
  }

  // <path> タグがないプレーンテキストの場合のフォールバック
  if (paths.length === 0) {
    const fallbackPoints: Array<[number, number]> = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes(',')) {
        const parts = trimmed.split(',');
        const lon = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        if (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90) {
          fallbackPoints.push([lon, lat]);
        }
      }
    }
    if (fallbackPoints.length > 0) {
      paths.push(fallbackPoints);
    }
  }

  return paths;
}

/**
 * ポリライン配列を デジスパイス コース図 (.pth) 形式で文字列化
 */
export function exportPth(polylines: Array<Array<[number, number]>>): string {
  const blocks: string[] = [];
  for (const poly of polylines) {
    blocks.push('<path>');
    for (const [lon, lat] of poly) {
      blocks.push(`${lon.toFixed(6)},${lat.toFixed(6)}`);
    }
    blocks.push('</path>');
  }
  return blocks.join('\r\n');
}

/**
 * デジスパイス コントロールライン (.cln) ファイルをパース
 */
export function parseCln(clnText: string, name = 'Control Line'): ControlLine {
  const lines = clnText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length < 5) {
    throw new Error(tr('無効な .cln ファイル形式です', 'Invalid .cln file'));
  }

  // 1行目: ライン数 (通常 1)
  // 2行目: 緯度1 (Lat A)
  // 3行目: 経度1 (Lon A)
  // 4行目: 緯度2 (Lat B)
  // 5行目: 経度2 (Lon B)
  const latA = parseFloat(lines[1]);
  const lonA = parseFloat(lines[2]);
  const latB = parseFloat(lines[3]);
  const lonB = parseFloat(lines[4]);

  const inRange = [latA, latB].every(v => Number.isFinite(v) && Math.abs(v) <= 90) &&
    [lonA, lonB].every(v => Number.isFinite(v) && Math.abs(v) <= 180);
  if (!inRange || (latA === latB && lonA === lonB)) {
    throw new Error(tr('.cln ファイルの座標値が不正です', 'Invalid coordinates in the .cln file'));
  }

  return { name, latA, lonA, latB, lonB };
}

/**
 * コントロールラインを デジスパイス (.cln) 形式で文字列化
 */
export function exportCln(line: ControlLine): string {
  // 公式の .cln と同じく、最後の行にも改行を付ける
  return ['1', line.latA.toFixed(6), line.lonA.toFixed(6), line.latB.toFixed(6), line.lonB.toFixed(6)].join('\r\n') + '\r\n';
}

/** .sci (1 行 1 本: 緯度A,経度A,緯度B,経度B,…) を読む */
export function parseSci(text: string, idPrefix: string): Sector[] {
  const sectors: Sector[] = [];
  for (const line of text.split(/\r?\n/)) {
    const v = line.split(',').map(x => parseFloat(x.trim()));
    if (v.length < 4 || !v.slice(0, 4).every(Number.isFinite)) continue;
    const [latA, lonA, latB, lonB] = v;
    if (Math.abs(latA) > 90 || Math.abs(latB) > 90 || Math.abs(lonA) > 180 || Math.abs(lonB) > 180) continue;
    sectors.push({ id: `${idPrefix}_s${sectors.length + 1}`, name: `S${sectors.length + 1}`, latA, lonA, latB, lonB });
  }
  if (sectors.length === 0) throw new Error(tr('セクター線が見つかりません', 'No sector lines were found'));
  return sectors;
}
