// GoPro の動画 (MP4) に記録された GPS (GPMF の GPS9 / GPS5) を走行ログとして読む。
// 動画は数 GB あるので、全体は読み込まず、MP4 の箱 (box) の構造をたどって GPMF のトラックのサンプルだけを読む。
// 形式: https://github.com/gopro/gpmf-parser (GPMF の KLV。GPS9 は HERO11 以降、GPS5 は HERO5〜10)
import { calculateGeoDistanceAndHeading } from './physics';
import { finalizeImportedSamples, type ImportedLog, type RawSample } from './externalFormats';

/** 動画のバイト列の一部を読む口 (ブラウザでは File、テストでは Node のファイル) */
export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<DataView>;
}

export function blobByteSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) => new DataView(await blob.slice(offset, offset + length).arrayBuffer())
  };
}

export interface GoproLog extends ImportedLog {
  /** 動画ごとの先頭 (0 秒) の UTC 時刻 (ミリ秒)。読んだ順。ログの先頭との差が、動画同期のオフセットになる */
  videoStartUtcMs: number[];
  /** GPS の形式 */
  gpsFormat: 'GPS9' | 'GPS5';
}

/** 1 つの GPS の点 (動画の中の時刻つき) */
interface GpsFix {
  format: 'GPS9' | 'GPS5';
  utcMs: number;
  movieSec: number;
  lat: number;
  lon: number;
  alt: number;
  speedMs: number;
}

const fourcc = (v: DataView, o: number) =>
  String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

/** 箱の一覧 (中身は読まず、位置と大きさだけ) */
async function listBoxes(src: ByteSource, start: number, end: number): Promise<{ type: string; start: number; header: number; size: number }[]> {
  const boxes: { type: string; start: number; header: number; size: number }[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const h = await src.read(pos, Math.min(16, end - pos));
    let size = h.getUint32(0);
    const type = fourcc(h, 4);
    let header = 8;
    if (size === 1) {
      if (h.byteLength < 16) break;
      size = Number(h.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header) break;
    boxes.push({ type, start: pos, header, size });
    pos += size;
  }
  return boxes;
}

/** 読み込み済みのバイト列の中の子の箱 */
function childBoxes(v: DataView, start: number, end: number): { type: string; body: number; end: number }[] {
  const out: { type: string; body: number; end: number }[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = v.getUint32(pos);
    const type = fourcc(v, pos + 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = Number(v.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    out.push({ type, body: pos + header, end: pos + size });
    pos += size;
  }
  return out;
}

const findChild = (v: DataView, start: number, end: number, path: string[]): { body: number; end: number } | null => {
  let cur = { body: start, end };
  for (const name of path) {
    const next = childBoxes(v, cur.body, cur.end).find(b => b.type === name);
    if (!next) return null;
    cur = next;
  }
  return cur;
};

/** GPMF のトラックのサンプル (位置・大きさ・動画の中の時刻) */
interface MetaSample {
  offset: number;
  size: number;
  startSec: number;
  durationSec: number;
}

function gpmfSamplesFromMoov(v: DataView): MetaSample[] | null {
  for (const trak of childBoxes(v, 0, v.byteLength).filter(b => b.type === 'trak')) {
    const mdia = findChild(v, trak.body, trak.end, ['mdia']);
    if (!mdia) continue;
    const hdlr = findChild(v, mdia.body, mdia.end, ['hdlr']);
    if (!hdlr || fourcc(v, hdlr.body + 8) !== 'meta') continue;
    const stbl = findChild(v, mdia.body, mdia.end, ['minf', 'stbl']);
    const mdhd = findChild(v, mdia.body, mdia.end, ['mdhd']);
    if (!stbl || !mdhd) continue;
    const stsd = findChild(v, stbl.body, stbl.end, ['stsd']);
    // サンプルの記述 (stsd の最初の項目) の形式が 'gpmd' のトラックが GPMF
    if (!stsd || fourcc(v, stsd.body + 12) !== 'gpmd') continue;

    const mdhdVersion = v.getUint8(mdhd.body);
    const timescale = v.getUint32(mdhd.body + (mdhdVersion === 1 ? 20 : 12));
    if (!timescale) continue;

    // 各サンプルの大きさ (stsz)
    const stsz = findChild(v, stbl.body, stbl.end, ['stsz']);
    if (!stsz) continue;
    const fixedSize = v.getUint32(stsz.body + 4);
    const sampleCount = v.getUint32(stsz.body + 8);
    const sizes: number[] = [];
    for (let i = 0; i < sampleCount; i++) sizes.push(fixedSize || v.getUint32(stsz.body + 12 + i * 4));
    // 各サンプルの長さ (stts)
    const stts = findChild(v, stbl.body, stbl.end, ['stts']);
    const durations: number[] = [];
    if (stts) {
      const n = v.getUint32(stts.body + 4);
      for (let i = 0; i < n; i++) {
        const count = v.getUint32(stts.body + 8 + i * 8);
        const delta = v.getUint32(stts.body + 12 + i * 8);
        for (let k = 0; k < count && durations.length < sampleCount; k++) durations.push(delta);
      }
    }
    // チャンクの位置 (stco / co64)
    const stco = findChild(v, stbl.body, stbl.end, ['stco']);
    const co64 = findChild(v, stbl.body, stbl.end, ['co64']);
    const chunkOffsets: number[] = [];
    if (stco) {
      const n = v.getUint32(stco.body + 4);
      for (let i = 0; i < n; i++) chunkOffsets.push(v.getUint32(stco.body + 8 + i * 4));
    } else if (co64) {
      const n = v.getUint32(co64.body + 4);
      for (let i = 0; i < n; i++) chunkOffsets.push(Number(v.getBigUint64(co64.body + 8 + i * 8)));
    } else continue;
    // チャンクごとのサンプル数 (stsc)
    const stsc = findChild(v, stbl.body, stbl.end, ['stsc']);
    const stscEntries: { firstChunk: number; perChunk: number }[] = [];
    if (stsc) {
      const n = v.getUint32(stsc.body + 4);
      for (let i = 0; i < n; i++) {
        stscEntries.push({ firstChunk: v.getUint32(stsc.body + 8 + i * 12), perChunk: v.getUint32(stsc.body + 12 + i * 12) });
      }
    }
    if (stscEntries.length === 0) stscEntries.push({ firstChunk: 1, perChunk: 1 });

    const samples: MetaSample[] = [];
    let sampleIndex = 0;
    let t = 0;
    for (let c = 0; c < chunkOffsets.length && sampleIndex < sampleCount; c++) {
      // このチャンク (1 始まりの番号 c + 1) に当てはまる stsc の項目
      let perChunk = stscEntries[0].perChunk;
      for (const e of stscEntries) if (e.firstChunk <= c + 1) perChunk = e.perChunk;
      let offset = chunkOffsets[c];
      for (let k = 0; k < perChunk && sampleIndex < sampleCount; k++) {
        const size = sizes[sampleIndex];
        const dur = durations[sampleIndex] ?? durations[durations.length - 1] ?? timescale;
        samples.push({ offset, size, startSec: t / timescale, durationSec: dur / timescale });
        offset += size;
        t += dur;
        sampleIndex++;
      }
    }
    return samples;
  }
  return null;
}

/** GPMF の型ごとの 1 値の大きさ */
const TYPE_SIZE: Record<string, number> = { b: 1, B: 1, c: 1, s: 2, S: 2, l: 4, L: 4, f: 4, d: 8, j: 8, J: 8, F: 4 };

function readValue(v: DataView, o: number, t: string): number {
  switch (t) {
    case 'b': return v.getInt8(o);
    case 'B': return v.getUint8(o);
    case 's': return v.getInt16(o);
    case 'S': return v.getUint16(o);
    case 'l': return v.getInt32(o);
    case 'L': return v.getUint32(o);
    case 'f': return v.getFloat32(o);
    case 'd': return v.getFloat64(o);
    case 'j': return Number(v.getBigInt64(o));
    case 'J': return Number(v.getBigUint64(o));
    default: return NaN;
  }
}

/** 数値の並びを読む (SCAL など)。1 値の大きさが型と合わないものは読まない */
function readNumbers(v: DataView, o: number, type: string, structSize: number, repeat: number): number[] {
  const size = TYPE_SIZE[type];
  if (!size) return [];
  const count = (structSize * repeat) / size;
  if (!Number.isInteger(count)) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(readValue(v, o + i * size, type));
  return out;
}

/** GPS5 の GPSU (UTC の "yymmddhhmmss.sss") */
function parseGpsu(s: string): number {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2}(?:\.\d+)?)/.exec(s);
  if (!m) return NaN;
  const sec = parseFloat(m[6]);
  return Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], Math.floor(sec), Math.round((sec % 1) * 1000));
}

const GPS9_EPOCH_MS = Date.UTC(2000, 0, 1);
// 精度の悪い点は捨てる (DOP が 5 を超えるもの)
const MAX_DOP = 5;

/** 1 サンプル (約 1 秒分) の GPMF から GPS の点を取り出す */
function parseGpmfPayload(v: DataView, sample: MetaSample, out: GpsFix[], formats: Set<string>) {
  const walk = (start: number, end: number) => {
    // 同じ STRM の中で、データの前に出てくる設定 (SCAL・TYPE など)
    let scal: number[] = [1];
    let complexType = '';
    let gpsuMs = NaN;
    let gpsFix = 3;
    let gpsDop = 0;
    const gps5: { body: number; type: string; structSize: number; repeat: number; scal: number[] }[] = [];
    let pos = start;
    while (pos + 8 <= end) {
      const key = fourcc(v, pos);
      const type = String.fromCharCode(v.getUint8(pos + 4));
      const structSize = v.getUint8(pos + 5);
      const repeat = v.getUint16(pos + 6);
      const len = structSize * repeat;
      const body = pos + 8;
      const next = body + Math.ceil(len / 4) * 4;
      if (body + len > end) break;
      if (type === '\0') {
        // 入れ子 (DEVC・STRM)
        walk(body, body + len);
      } else if (key === 'SCAL') {
        scal = readNumbers(v, body, type, structSize, repeat);
      } else if (key === 'TYPE') {
        complexType = '';
        for (let i = 0; i < len; i++) complexType += String.fromCharCode(v.getUint8(body + i));
      } else if (key === 'GPSU' && type === 'U') {
        let s = '';
        for (let i = 0; i < Math.min(len, 16); i++) s += String.fromCharCode(v.getUint8(body + i));
        gpsuMs = parseGpsu(s);
      } else if (key === 'GPSF') {
        gpsFix = readNumbers(v, body, type, structSize, repeat)[0] ?? gpsFix;
      } else if (key === 'GPSP') {
        gpsDop = (readNumbers(v, body, type, structSize, repeat)[0] ?? 0) / 100;
      } else if (key === 'GPS9') {
        // lat, lon, alt, 2D 速度, 3D 速度, 2000 年からの日数, 0 時からの秒, DOP, 測位 (0 / 2 / 3)
        const types = type === '?' ? complexType.replace(/\0/g, '') : type.repeat(9);
        if (types.length < 9) { pos = next; continue; }
        const offs: number[] = [];
        let o = 0;
        for (const t of types) { offs.push(o); o += TYPE_SIZE[t] ?? 0; }
        if (o !== structSize) { pos = next; continue; }
        const sc = (i: number) => scal.length >= 9 ? scal[i] || 1 : scal[0] || 1;
        for (let r = 0; r < repeat; r++) {
          const base = body + r * structSize;
          const val = (i: number) => readValue(v, base + offs[i], types[i]) / sc(i);
          const fix = val(8);
          const dop = val(7);
          if (fix < 2 || dop > MAX_DOP) continue;
          formats.add('GPS9');
          const days = val(5);
          const secs = val(6);
          out.push({
            format: 'GPS9',
            utcMs: GPS9_EPOCH_MS + days * 86400000 + secs * 1000,
            movieSec: sample.startSec + (r / repeat) * sample.durationSec,
            lat: val(0),
            lon: val(1),
            alt: val(2),
            speedMs: val(3)
          });
        }
      } else if (key === 'GPS5') {
        // GPSU などが後に来ることもあるので、STRM を読み終えてから扱う
        gps5.push({ body, type, structSize, repeat, scal });
      }
      pos = next;
    }
    for (const { body, type, structSize, repeat, scal: gscal } of gps5) {
      // lat, lon, alt, 2D 速度, 3D 速度。時刻は GPSU (このサンプルの最初の点) から等間隔
      const size = TYPE_SIZE[type];
      if (!size || structSize !== size * 5 || gpsFix < 2 || gpsDop > MAX_DOP || !Number.isFinite(gpsuMs)) continue;
      const sc = (i: number) => gscal.length >= 5 ? gscal[i] || 1 : gscal[0] || 1;
      if (repeat > 0) formats.add('GPS5');
      for (let r = 0; r < repeat; r++) {
        const base = body + r * structSize;
        const val = (i: number) => readValue(v, base + i * size, type) / sc(i);
        out.push({
          format: 'GPS5',
          utcMs: gpsuMs + (r / repeat) * sample.durationSec * 1000,
          movieSec: sample.startSec + (r / repeat) * sample.durationSec,
          lat: val(0),
          lon: val(1),
          alt: val(2),
          speedMs: val(3)
        });
      }
    }
  };
  walk(0, v.byteLength);
}

/** GPS (GPMF) の記録がない動画 (GoPro 以外の動画・GPS を切って撮った GoPro の動画) */
export class NoGoproGpsError extends Error {}

/** 1 本の動画から GPS の点を読む */
async function readGpsFixes(src: ByteSource): Promise<{ fixes: GpsFix[]; formats: Set<string> }> {
  const moov = (await listBoxes(src, 0, src.size)).find(b => b.type === 'moov');
  if (!moov || moov.start + moov.size > src.size) throw new Error('MP4 の構造 (moov) が見つかりません');
  const moovView = await src.read(moov.start + moov.header, moov.size - moov.header);
  // ファイルの外を指すサンプル (途中で切れたファイルなど) は読まない
  const samples = gpmfSamplesFromMoov(moovView)?.filter(s => s.offset + s.size <= src.size);
  if (!samples || samples.length === 0) throw new NoGoproGpsError('GoPro の GPS (GPMF) の記録がない動画です');

  const fixes: GpsFix[] = [];
  const formats = new Set<string>();
  // サンプルは 1 秒に 1 つで数 KB。まとめて読む (続いているものは 4 MB まで 1 回で)
  for (let i = 0; i < samples.length; ) {
    let j = i + 1;
    while (j < samples.length && samples[j].offset === samples[j - 1].offset + samples[j - 1].size && samples[j].offset + samples[j].size - samples[i].offset < 4 << 20) j++;
    const start = samples[i].offset;
    const block = await src.read(start, samples[j - 1].offset + samples[j - 1].size - start);
    for (let k = i; k < j; k++) {
      const s = samples[k];
      if (s.size < 8 || s.offset - start + s.size > block.byteLength) continue;
      parseGpmfPayload(new DataView(block.buffer, block.byteOffset + s.offset - start, s.size), s, fixes, formats);
    }
    i = j;
  }
  return { fixes, formats };
}

/**
 * GoPro の動画から GPS の走行ログを読む。
 * 1 回の撮影が複数のファイル (チャプター) に分かれているときは、まとめて渡すと 1 つのログにつなげる
 */
export async function parseGoproGps(sources: ByteSource[]): Promise<GoproLog> {
  // 読めないチャプター (撮影中に電池が切れた最後のファイルなど) があっても、読めたものでログを作る
  const perVideo: { fixes: GpsFix[]; formats: Set<string> }[] = [];
  let firstError: unknown = null;
  for (const src of sources) {
    try {
      perVideo.push(await readGpsFixes(src));
    } catch (err) {
      firstError ??= err;
      perVideo.push({ fixes: [], formats: new Set() });
    }
  }
  if (perVideo.every(v => v.fixes.length === 0) && firstError) throw firstError;
  // GPS9 と GPS5 の両方がある動画は GPS9 を使う (同じ点を二重に入れない)
  // (GPS5 は時刻をサンプルの中で等分して求めるので粗い)
  const gpsFormat: 'GPS9' | 'GPS5' = perVideo.some(v => v.formats.has('GPS9')) ? 'GPS9' : 'GPS5';
  const isValid = (f: GpsFix) => f.format === gpsFormat && Number.isFinite(f.utcMs) && Number.isFinite(f.lat) && Number.isFinite(f.lon) && !(f.lat === 0 && f.lon === 0);

  // 動画ごとの先頭の UTC 時刻: 各点の (UTC 時刻 − 動画の中の時刻) の中央値。測位できた点がない動画は NaN
  const videoStartUtcMs = perVideo.map(v => {
    const diffs = v.fixes.filter(isValid).map(f => f.utcMs - f.movieSec * 1000).sort((a, b) => a - b);
    return diffs.length ? diffs[Math.floor(diffs.length / 2)] : NaN;
  });

  const valid: GpsFix[] = [];
  for (const v of perVideo) for (const f of v.fixes) if (isValid(f)) valid.push(f);
  if (valid.length < 2) throw new NoGoproGpsError('GoPro の動画に、測位できた GPS の記録がありません');
  valid.sort((a, b) => a.utcMs - b.utcMs);
  const raw: RawSample[] = valid.map((f, i) => {
    const a = valid[Math.max(0, i - 1)];
    const b = valid[Math.min(valid.length - 1, i + 1)];
    const heading = a === b ? NaN : calculateGeoDistanceAndHeading(a.lat, a.lon, b.lat, b.lon).headingDeg;
    return {
      time: f.utcMs / 1000,
      latitude: f.lat,
      longitude: f.lon,
      speedKmh: f.speedMs * 3.6,
      altitude: f.alt,
      heading,
      timestamp: new Date(f.utcMs)
    };
  });
  const log = finalizeImportedSamples(raw, 'GoPro の動画');
  return { ...log, videoStartUtcMs, gpsFormat };
}

/**
 * GoPro のファイル名から、撮影の番号とチャプターを読む (1 回の撮影は約 4 GB ごとに別のファイルになる)。
 * GX / GH + チャプター 2 桁 + 撮影番号 4 桁 (HERO6 以降)、GOPR + 撮影番号 (古い機種の最初のチャプター)、
 * GP + チャプター 2 桁 + 撮影番号 (古い機種の 2 つ目以降)。GoPro の名前でなければ null
 */
export function goproRecording(fileName: string): { id: string; chapter: number } | null {
  const name = fileName.replace(/^.*[\\/]/, '').toUpperCase();
  let m = /^G([XH])(\d{2})(\d{4})\.(MP4|MOV)$/.exec(name);
  if (m) return { id: `G${m[1]}${m[3]}`, chapter: +m[2] };
  m = /^GOPR(\d{4})\.(MP4|MOV)$/.exec(name);
  if (m) return { id: `GP${m[1]}`, chapter: 0 };
  m = /^GP(\d{2})(\d{4})\.(MP4|MOV)$/.exec(name);
  if (m) return { id: `GP${m[2]}`, chapter: +m[1] };
  return null;
}
