/**
 * メーターだけを描いた、背景が透明な動画の書き出し (PLAN-14、2026-10-20 の試作)。
 * 車載動画は入れず、ほかの編集ソフト (Premiere・DaVinci Resolve・After Effects・Final Cut など) で動画の上に重ねて使う。
 *
 * 編集ソフトで透明が使える形式は、ProRes 4444 の MOV や PNG の連番がふつうだが、ブラウザは ProRes を作れない。そこで 2 つを出す:
 * - PNG の連番 (ZIP にまとめる): Premiere・DaVinci Resolve・After Effects がそのまま読める。いちばん読めるソフトが多い (既定)
 * - 透明な WebM (VP9 のアルファ): ファイルが小さい。Chrome・Electron で作れる。読めるソフトは限られる (Premiere・Final Cut は
 *   そのままでは読めないことが多い)
 * コマは、時刻を 1 コマずつ進めて描く (再生しない)。動画を読まないので、元の動画のファイルは要らない
 */

import { BufferTarget, CanvasSource, Output, WebMOutputFormat, canEncodeVideo } from 'mediabunny';
import { Zip, ZipPassThrough } from 'fflate';
import { downloadBlob, type VideoExportController } from './telemetryVideoExporter';

export type OverlayFormat = 'png-zip' | 'webm-alpha';

export interface OverlayExportOptions {
  /** 書き出す範囲 (セッションの秒) */
  startSessionSec: number;
  endSessionSec: number;
  width: number;
  height: number;
  fps: number;
  format: OverlayFormat;
  /** 透明な canvas にメーターを描く */
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number, sessionSec: number) => void;
  /** 拡張子なしのファイル名 */
  baseName: string;
  onProgress?: (progress: { currentSec: number; totalSec: number; percent: number }) => void;
}

/** 透明な WebM を作れるか (VP9 のエンコーダーがあるか) */
export async function canExportWebmAlpha(width: number, height: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    return await canEncodeVideo('vp9', { width, height, alpha: 'keep' });
  } catch {
    return false;
  }
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => {
      if (!b) { reject(new Error('PNG を作れませんでした')); return; }
      b.arrayBuffer().then(buf => resolve(new Uint8Array(buf)), reject);
    }, 'image/png');
  });
}

export function exportOverlayOnly(options: OverlayExportOptions): VideoExportController {
  const { startSessionSec, endSessionSec, width, height, fps, format, draw, baseName, onProgress } = options;
  let cancelled = false;
  let output: Output | null = null;

  const promise = (async () => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas 2D context を取得できませんでした');
    const totalSec = Math.max(0.1, endSessionSec - startSessionSec);
    const frames = Math.max(1, Math.round(totalSec * fps));
    const drawFrame = (i: number) => {
      ctx.clearRect(0, 0, width, height);
      draw(ctx, width, height, startSessionSec + i / fps);
    };
    const progress = (i: number) => onProgress?.({ currentSec: i / fps, totalSec, percent: Number(((i / frames) * 100).toFixed(1)) });

    if (format === 'webm-alpha') {
      const target = new BufferTarget();
      output = new Output({ format: new WebMOutputFormat(), target });
      const source = new CanvasSource(canvas, { codec: 'vp9', bitrate: 4_000_000, alpha: 'keep' });
      output.addVideoTrack(source, { frameRate: fps });
      await output.start();
      for (let i = 0; i < frames; i++) {
        if (cancelled) throw new Error('エクスポートがユーザーによりキャンセルされました');
        drawFrame(i);
        await source.add(i / fps, 1 / fps);
        if (i % 15 === 0) progress(i);
      }
      await output.finalize();
      const blob = new Blob([target.buffer!], { type: 'video/webm' });
      downloadBlob(blob, `${baseName}.webm`);
      return blob;
    }

    // PNG の連番を ZIP にまとめる (PNG はもう縮んでいるので、ZIP では縮めずに入れる)
    const chunks: Uint8Array[] = [];
    let zipError: Error | null = null;
    const zip = new Zip((err, data) => {
      if (err) { zipError = err; return; }
      chunks.push(data);
    });
    const digits = String(frames).length < 6 ? 6 : String(frames).length;
    for (let i = 0; i < frames; i++) {
      if (cancelled) throw new Error('エクスポートがユーザーによりキャンセルされました');
      if (zipError) throw zipError;
      drawFrame(i);
      const png = await canvasToPng(canvas);
      // ZIP の中の名前は英数字だけにする (日本語の名前は、展開するソフトによって文字化けする。編集ソフトの連番の読み込みにも安全)
      const entry = new ZipPassThrough(`meters_${fps}fps/meters_${String(i).padStart(digits, '0')}.png`);
      zip.add(entry);
      entry.push(png, true);
      if (i % 15 === 0) progress(i);
    }
    zip.end();
    if (zipError) throw zipError;
    const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
    downloadBlob(blob, `${baseName}_${fps}fps_png.zip`);
    return blob;
  })();

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      void output?.cancel();
    },
    promise
  };
}
