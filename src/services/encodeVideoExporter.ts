/**
 * 車載動画にメーターを焼き込んで書き出す (エンコードの方式、2026-10-20 の試作)。
 *
 * これまでの方式 (telemetryVideoExporter.ts) は、動画を実際の速さで再生しながら canvas に描き、それを MediaRecorder で録る。
 * そのため、書き出しに動画の長さと同じだけ時間がかかり、端末が重いとコマが抜け、描き直しを間引くブラウザ (Safari・iPhone) では
 * メーターの動きも粗くなる。
 *
 * この方式は、元の動画のファイルを 1 コマずつ読み (WebCodecs の VideoDecoder)、コマの時刻のメーターを描いて、
 * そのコマを書き出す動画にする (VideoEncoder)。再生しないので、コマは抜けず、メーターはどのコマでもその時刻のものになる。
 * 速さは端末しだい (ハードウェアのエンコーダーがあれば、実時間より速いことが多い)。音は元のファイルからそのまま写す (エンコードし直さない)。
 * ファイルの読み書きは mediabunny (MPL-2.0) を使う
 */

import { ALL_FORMATS, BlobSource, Conversion, Input, Mp4OutputFormat, Output, canEncodeVideo } from 'mediabunny';
import { createVideoSink, type VideoSink } from './exportSink';
import { downloadBlob, type VideoExportController } from './telemetryVideoExporter';

export interface EncodeExportOptions {
  /** 元の動画のファイル */
  file: File;
  /** 書き出す範囲 (動画の中の秒) */
  startVideoSec: number;
  endVideoSec: number;
  /** 動画の中の秒から、メーターを描く時刻 (セッションの秒) への換算 */
  toSessionSec: (videoSec: number) => number;
  drawOverlay: (ctx: CanvasRenderingContext2D, width: number, height: number, sessionSec: number) => void;
  width: number;
  height: number;
  fps: number;
  bitrate?: number;
  outputFileName: string;
  onProgress?: (progress: { currentSec: number; totalSec: number; percent: number }) => void;
  /** 書き出せたが、知らせておきたいこと (音を入れられなかったなど) */
  onWarning?: (message: string) => void;
}

/** このブラウザでエンコードの方式を使えそうか (WebCodecs があるか)。H.264 で書けるかは書き出すときに確かめる */
export function canUseEncodeExport(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
}

export function exportEncodedVideo(options: EncodeExportOptions): VideoExportController {
  const { file, startVideoSec, endVideoSec, toSessionSec, drawOverlay, width, height, fps, bitrate = 8_000_000, outputFileName, onProgress, onWarning } = options;
  let conversion: Conversion | null = null;
  let cancelled = false;
  let sink: VideoSink | null = null;

  const run = async () => {
    if (!(await canEncodeVideo('avc', { width, height, bitrate }))) {
      throw new Error('このブラウザでは H.264 で書き出せません');
    }
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    // できたファイルは、ブラウザの中のファイル置き場に少しずつ書く (長い書き出しでメモリを使い切らない。exportSink.ts)。
    // そのときは MP4 の目次を最後に書く (先頭に置くには、全部をメモリに持つ必要がある)
    sink = await createVideoSink();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: sink.onDisk ? false : 'in-memory' }), target: sink.target });

    // メーターを重ねる canvas (コマごとに描き直して渡す。渡したコマはすぐエンコーダーに写されるので、同じ canvas を使い回せる)
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context を取得できませんでした');
    const totalSec = Math.max(0.1, endVideoSec - startVideoSec);

    conversion = await Conversion.init({
      input,
      output,
      // 動画と音の主なものだけ (GoPro の GPS・タイムコードのトラックは入れない)
      tracks: 'primary',
      trim: { start: startVideoSec, end: endVideoSec },
      video: {
        width,
        height,
        fit: 'contain',
        frameRate: fps,
        codec: 'avc',
        bitrate,
        forceTranscode: true,
        process: sample => {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, width, height);
          sample.draw(ctx, 0, 0, width, height);
          // コマの時刻は、切り出した範囲の始めを 0 とした秒
          drawOverlay(ctx, width, height, toSessionSec(startVideoSec + sample.timestamp));
          return canvas;
        },
        processedWidth: width,
        processedHeight: height
      },
      // 音は、MP4 に入る形 (AAC など) ならそのまま写す
      audio: {},
      // 元のファイルの説明の情報 (GoPro の独自の項目) は写さない (写すと ffmpeg などで開けない MP4 になった)
      tags: {}
    });
    if (!conversion.isValid) {
      throw new Error('この動画は書き出せません: ' + conversion.discardedTracks.map(t => t.reason).join(', '));
    }
    // 準備の間に取り消されたら、書き出しを始めない
    if (cancelled) throw new Error('エクスポートがユーザーによりキャンセルされました');
    // 音を入れられないとき (MP4 に入らない形で、エンコードし直すこともできない) は、映像だけ書き出して知らせる
    const audioDropped = conversion.discardedTracks.some(t => t.track.type === 'audio');
    conversion.onProgress = (p: number) => {
      const currentSec = p * totalSec;
      onProgress?.({ currentSec, totalSec, percent: Number((p * 100).toFixed(1)) });
    };
    await conversion.execute();
    if (cancelled) throw new Error('エクスポートがユーザーによりキャンセルされました');
    const blob = await sink.finish('video/mp4');
    downloadBlob(blob, outputFileName.replace(/\.(mp4|webm|mov)$/i, '') + '.mp4');
    if (audioDropped) onWarning?.('音は入れられませんでした (この動画の音の形は、MP4 にそのまま入れられません)');
    return blob;
  };
  const promise = run().catch(async err => {
    await sink?.abort();
    throw err;
  });

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      void conversion?.cancel();
    },
    promise
  };
}
