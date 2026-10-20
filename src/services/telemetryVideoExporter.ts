/**
 * 動画テレメトリ焼き込みエクスポートサービス (Overlay Burn-in Exporter)
 * 車載動画フレームとテレメトリメーター (速度・G・ラップタイム) を Canvas 合成し、MediaRecorder で MP4/WebM 動画として書き出し
 */

export interface VideoExportOptions {
  videoElement: HTMLVideoElement;
  startTimeSec: number;        // セッション絶対開始秒
  endTimeSec: number;          // セッション絶対終了秒
  syncOffsetSec: number;       // 動画のオフセット秒
  drawOverlay: (ctx: CanvasRenderingContext2D, width: number, height: number, currentSessionTimeSec: number) => void;
  outputFileName?: string;
  width?: number;              // default: 1920 (or video naturalWidth)
  height?: number;             // default: 1080 (or video naturalHeight)
  fps?: number;                // default: 30
  bitrate?: number;            // default: 8_000_000 (8Mbps)
  onProgress?: (progress: { currentSec: number; totalSec: number; percent: number }) => void;
}

export interface VideoExportController {
  cancel: () => void;
  promise: Promise<Blob>;
}

export function getSupportedVideoMimeType(): string {
  const mimeTypes = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];

  for (const type of mimeTypes) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }

  return 'video/webm';
}

// 書き出しに動画の音を入れる (Web Audio で動画の音を取り出し、録る stream に足す)。
// createMediaElementSource は 1 つの動画に 1 回しか作れず、作ると音はその道を通るようになるので、作った道は覚えておき、
// ふだんの再生でも聞こえるよう、いつもスピーカーにもつないでおく
let audioCtx: AudioContext | null = null;
const audioSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

/** video の音を stream に足す。書き出しの間は音を出す (消音だと無音で録れるため)。戻り値で元に戻す */
function attachVideoAudio(stream: MediaStream, video: HTMLVideoElement | null | undefined): () => void {
  if (!video) return () => {};
  try {
    audioCtx ??= new AudioContext();
    void audioCtx.resume();
    let source = audioSources.get(video);
    if (!source) {
      source = audioCtx.createMediaElementSource(video);
      source.connect(audioCtx.destination);
      audioSources.set(video, source);
      // この動画の音は、これからずっと Web Audio を通る。Web Audio が止められていると (iPhone で裏に回ったときなど)
      // ふだんの再生で音が出なくなるので、再生するたびに起こし直す
      video.addEventListener('play', () => { void audioCtx?.resume(); });
    }
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(dest);
    dest.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    const wasMuted = video.muted;
    video.muted = false;
    const src = source;
    return () => {
      try { src.disconnect(dest); } catch { /* つないでいなければよい */ }
      dest.stream.getTracks().forEach(track => track.stop());
      video.muted = wasMuted;
    };
  } catch (e) {
    // 音を取り出せなくても、映像だけは書き出す
    console.warn('[export] 動画の音を書き出しに入れられない:', e);
    return () => {};
  }
}

export function exportBurnedInVideo(options: VideoExportOptions): VideoExportController {
  const {
    videoElement,
    startTimeSec,
    endTimeSec,
    syncOffsetSec,
    drawOverlay,
    outputFileName = `telemetry_export_${Date.now()}.mp4`,
    width = 1920,
    height = 1080,
    fps = 30,
    bitrate = 8_000_000,
    onProgress
  } = options;

  let isCancelled = false;
  let mediaRecorder: MediaRecorder | null = null;
  let animFrameId: number | null = null;
  let origCurrentTime = videoElement.currentTime;
  let origPaused = videoElement.paused;
  let origPlaybackRate = videoElement.playbackRate;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });

  if (!ctx) {
    return {
      cancel: () => {},
      promise: Promise.reject(new Error('Canvas 2D context を取得できませんでした'))
    };
  }

  const mimeType = getSupportedVideoMimeType();
  const stream = canvas.captureStream(fps);
  const detachAudio = attachVideoAudio(stream, videoElement);

  const chunks: Blob[] = [];

  // 元の動画の状態に戻す (書き出しの終わり・キャンセルのどちらでも 1 回だけ)
  let restored = false;
  const restoreVideo = () => {
    if (restored) return;
    restored = true;
    detachAudio();
    videoElement.pause();
    videoElement.playbackRate = origPlaybackRate;
    videoElement.currentTime = origCurrentTime;
    if (!origPaused) videoElement.play().catch(() => {});
  };
  let rejectPromise: (err: Error) => void = () => {};
  // 終わりまで書き出して、録画を止めたところか (この後のキャンセルでは、書き出したものを捨てない)
  let finished = false;
  let onSeeked: (() => void) | null = null;

  const promise = new Promise<Blob>((resolve, reject) => {
    rejectPromise = reject;
    try {
      mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: bitrate
      });
    } catch (e) {
      // フォールバック
      try {
        mediaRecorder = new MediaRecorder(stream);
      } catch (err) {
        return reject(new Error('MediaRecorderの初期化に失敗しました: ' + String(err)));
      }
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      // 元の動画状態を復元
      restoreVideo();

      if (isCancelled) {
        reject(new Error('エクスポートがユーザーによりキャンセルされました'));
        return;
      }

      const finalType = mimeType.includes('mp4') ? 'video/mp4' : 'video/webm';
      const blob = new Blob(chunks, { type: finalType });

      if (onProgress) {
        onProgress({ currentSec: endTimeSec, totalSec: Math.max(0.1, endTimeSec - startTimeSec), percent: 100 });
      }

      if (outputFileName) {
        // MediaRecorder が MP4 に対応せず WebM で記録した環境では、拡張子も .webm にする (中身と拡張子が違うと開けないプレーヤーがある)
        const ext = finalType === 'video/mp4' ? '.mp4' : '.webm';
        downloadBlob(blob, outputFileName.replace(/\.(mp4|webm|mov)$/i, '') + ext);
      }

      resolve(blob);
    };

    // 初期位置にシーク
    const startVideoTime = Math.max(0, startTimeSec - syncOffsetSec);
    videoElement.currentTime = startVideoTime;
    videoElement.playbackRate = 1.0;

    onSeeked = () => {
      if (onSeeked) videoElement.removeEventListener('seeked', onSeeked);
      if (isCancelled) return;

      mediaRecorder?.start(250); // 250msごとにchunkを収集
      videoElement.play().catch(console.warn);

      const renderLoop = () => {
        if (isCancelled) {
          mediaRecorder?.stop();
          return;
        }

        const currentVidTime = videoElement.currentTime;
        const currentSessionTime = currentVidTime + syncOffsetSec;

        // 1. 動画フレームを描画
        ctx.drawImage(videoElement, 0, 0, width, height);

        // 2. テレメトリオーバーレイを描画
        drawOverlay(ctx, width, height, currentSessionTime);

        // 3. 進捗通知
        const totalDuration = Math.max(0.1, endTimeSec - startTimeSec);
        const elapsed = Math.max(0, currentSessionTime - startTimeSec);
        const percent = Math.min(99.9, Number(((elapsed / totalDuration) * 100).toFixed(1)));
        if (onProgress) {
          onProgress({ currentSec: currentSessionTime, totalSec: totalDuration, percent });
        }

        // 終了判定
        if (currentSessionTime >= endTimeSec || videoElement.ended) {
          finished = true;
          videoElement.pause();
          mediaRecorder?.stop();
          return;
        }

        animFrameId = requestAnimationFrame(renderLoop);
      };

      animFrameId = requestAnimationFrame(renderLoop);
    };

    videoElement.addEventListener('seeked', onSeeked, { once: true });
  });

  return {
    cancel: () => {
      if (isCancelled || finished) return;
      isCancelled = true;
      if (animFrameId) cancelAnimationFrame(animFrameId);
      if (onSeeked) videoElement.removeEventListener('seeked', onSeeked);
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        // 録画中なら、止まったとき (onstop) に元に戻して終わる
        mediaRecorder.stop();
      } else {
        // 開始位置への移動を待っている間 (録画を始める前) にキャンセルしたときは、onstop が来ないので、ここで終える
        restoreVideo();
        rejectPromise(new Error('エクスポートがユーザーによりキャンセルされました'));
      }
    },
    promise
  };
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 大きなファイル (ディスクに置いた書き出し) は、ダウンロードが読み終わるまで URL を残す (1 秒に 10 MB と見て、最短 10 秒)
  setTimeout(() => URL.revokeObjectURL(url), Math.max(10_000, blob.size / 10_000));
}

/**
 * canvas に描いたものを、そのまま実時間で録る (枠の並びの書き出し)。動画は呼ぶ側がふだんの再生 (App の時刻) で動かし、
 * draw はコマごとに枠を canvas に描いて、進み具合を返す。done を返したら録るのをやめる
 */
export function recordCanvas(options: {
  width: number;
  height: number;
  fps?: number;
  bitrate?: number;
  outputFileName: string;
  draw: (ctx: CanvasRenderingContext2D) => { currentSec: number; totalSec: number; done: boolean };
  onProgress?: (progress: { currentSec: number; totalSec: number; percent: number }) => void;
  /** 音を入れる動画 (メインの枠)。なければ音なし */
  audioFrom?: HTMLVideoElement | null;
}): VideoExportController {
  const { width, height, fps = 30, bitrate = 12_000_000, outputFileName, draw, onProgress, audioFrom } = options;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return { cancel: () => {}, promise: Promise.reject(new Error('Canvas 2D context を取得できませんでした')) };
  const mimeType = getSupportedVideoMimeType();
  const stream = canvas.captureStream(fps);
  const detachAudio = attachVideoAudio(stream, audioFrom);
  const chunks: Blob[] = [];
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
  } catch {
    recorder = new MediaRecorder(stream);
  }
  let cancelled = false;
  let frame: number | null = null;
  const promise = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      detachAudio();
      if (cancelled) { reject(new Error('エクスポートがユーザーによりキャンセルされました')); return; }
      const finalType = mimeType.includes('mp4') ? 'video/mp4' : 'video/webm';
      const blob = new Blob(chunks, { type: finalType });
      downloadBlob(blob, outputFileName.replace(/\.(mp4|webm|mov)$/i, '') + (finalType === 'video/mp4' ? '.mp4' : '.webm'));
      resolve(blob);
    };
    recorder.start(250);
    const loop = () => {
      if (cancelled) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      const p = draw(ctx);
      onProgress?.({ currentSec: p.currentSec, totalSec: p.totalSec, percent: Number(Math.min(100, Math.max(0, (p.currentSec / Math.max(0.1, p.totalSec)) * 100)).toFixed(1)) });
      if (p.done) { recorder.stop(); return; }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
  });
  return {
    cancel: () => {
      if (cancelled || recorder.state === 'inactive') return;
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
      recorder.stop();
    },
    promise
  };
}
