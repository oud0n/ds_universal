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

  const chunks: Blob[] = [];

  const promise = new Promise<Blob>((resolve, reject) => {
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
      videoElement.playbackRate = origPlaybackRate;
      videoElement.currentTime = origCurrentTime;
      if (!origPaused) videoElement.play().catch(() => {});

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
        downloadBlob(blob, outputFileName);
      }

      resolve(blob);
    };

    // 初期位置にシーク
    const startVideoTime = Math.max(0, startTimeSec - syncOffsetSec);
    videoElement.currentTime = startVideoTime;
    videoElement.playbackRate = 1.0;

    const onSeeked = () => {
      videoElement.removeEventListener('seeked', onSeeked);
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
      isCancelled = true;
      if (animFrameId) cancelAnimationFrame(animFrameId);
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      videoElement.pause();
      videoElement.currentTime = origCurrentTime;
      videoElement.playbackRate = origPlaybackRate;
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
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
