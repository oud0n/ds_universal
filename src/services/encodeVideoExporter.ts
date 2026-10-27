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

import { ALL_FORMATS, BlobSource, Conversion, CustomSource, Input, Mp4OutputFormat, Output, canEncodeVideo, type Source } from 'mediabunny';
import { isRemoteVideo, readRemoteRange, type RemoteVideo } from './remoteVideo';
import { createVideoSink, type VideoSink } from './exportSink';
import { downloadBlob, type VideoExportController } from './telemetryVideoExporter';

export interface EncodeExportOptions {
  /** 元の動画 (選んだファイル、または保管場所の動画。保管場所の動画は、要るところだけ読む) */
  file: File | RemoteVideo;
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

/** Safari・iPhone (WebKit) か (Chrome・Edge は AppleWebKit とも名乗るので除く) */
const isWebKit = () => typeof navigator !== 'undefined' && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg/.test(navigator.userAgent);

/**
 * WebKit の H.264 のエンコーダーは、Main・High のプロファイル (B フレームを使う) を画質優先で使うと、
 * 1 コマも出さずに止まる (2026-10-20、Mac の Safari で確認。Baseline・遅延を短くする設定なら動く)。
 * mediabunny の変換には指定の口がないので、書き出している間だけ、エンコーダーの設定を Baseline に書き換える。
 * 遅延を短くする設定は、重いとコマを捨てることがあるので使わない。返す関数で元に戻す
 */
export function forceBaselineH264(): () => void {
  if (!isWebKit() || typeof VideoEncoder === 'undefined') return () => {};
  const proto = VideoEncoder.prototype;
  const original = proto.configure;
  const toBaseline = (codec: string) => (/^avc[13]\.(64|4d)/i.test(codec) ? `avc1.4200${codec.slice(-2)}` : codec);
  proto.configure = function (config: VideoEncoderConfig) {
    return original.call(this, { ...config, codec: toBaseline(config.codec) });
  };
  const origSupported = VideoEncoder.isConfigSupported;
  VideoEncoder.isConfigSupported = (config: VideoEncoderConfig) => origSupported.call(VideoEncoder, { ...config, codec: toBaseline(config.codec) });
  return () => {
    proto.configure = original;
    VideoEncoder.isConfigSupported = origSupported;
  };
}

/** 一度に読む大きさの上限。iPhone のアプリは読んだ中身を base64 で渡すので、大きすぎないように分けて読む */
const REMOTE_READ_CHUNK = 8 * 1024 * 1024;

/** 保管場所の動画の [start, end) を、REMOTE_READ_CHUNK ずつに分けて読む */
export async function readRemoteChunked(file: Pick<RemoteVideo, 'url' | 'readRange'>, start: number, end: number, chunk = REMOTE_READ_CHUNK): Promise<Uint8Array> {
  const out = new Uint8Array(end - start);
  for (let pos = start; pos < end; pos += chunk) {
    const stop = Math.min(end, pos + chunk);
    const buf = new Uint8Array(await readRemoteRange(file, pos, stop));
    if (buf.byteLength !== stop - pos) throw new Error(`動画を読めませんでした (${pos}-${stop})`);
    out.set(buf, pos - start);
  }
  return out;
}

/** 元の動画を mediabunny で読む口。保管場所の動画は、範囲を頼んで読む (デスクトップ版は lapfile://、iPhone はアプリの窓口) */
export function encodeSource(file: File | RemoteVideo): Source {
  if (!isRemoteVideo(file)) return new BlobSource(file);
  return new CustomSource({
    getSize: () => file.size,
    read: (start, end) => readRemoteChunked(file, start, end),
    // 続けて読むときは、先の分もまとめて読んでおく (読む回数を減らす)
    prefetchProfile: 'network',
    maxCacheSize: 64 * 1024 * 1024
  });
}

export function exportEncodedVideo(options: EncodeExportOptions): VideoExportController {
  const { file, startVideoSec, endVideoSec, toSessionSec, drawOverlay, width, height, fps, bitrate = 8_000_000, outputFileName, onProgress, onWarning } = options;
  let conversion: Conversion | null = null;
  let cancelled = false;
  let sink: VideoSink | null = null;

  const run = async () => {
    const restoreEncoder = forceBaselineH264();
    try {
      return await runInner();
    } finally {
      restoreEncoder();
    }
  };
  const runInner = async () => {
    if (!(await canEncodeVideo('avc', { width, height, bitrate }))) {
      throw new Error('このブラウザでは H.264 で書き出せません');
    }
    const input = new Input({ source: encodeSource(file), formats: ALL_FORMATS });
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
