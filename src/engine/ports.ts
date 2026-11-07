export interface FileInfo { path: string; size: number; mtimeMs: number; local?: boolean }
export interface FileRepository {
  list(): Promise<FileInfo[]>;
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string | null>;
  readTextStrict?(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
}
export interface PreferencesPort { read(key: string): string | null; write(key: string, value: string | null): void }
export interface BinaryFile {
  readonly name: string; readonly size: number; readonly lastModified: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number, contentType?: string): { arrayBuffer(): Promise<ArrayBuffer> };
}
export interface ExecutionPort { run<T>(work: () => T | Promise<T>): Promise<T> }
export interface ClockPort { nowMs(): number }
export interface ResourcePort<T> { open(resource: T): string; close(handle: string): void }
export interface RunFileInfo extends FileInfo {
  /** 端末の中にあるか (false: iCloud にだけある。読むと取り込みが始まる) */
  local: boolean;
}

export interface RunRepository extends FileRepository {
  /** このハンドルを作った保管場所の世代。別の場所では使わない。 */
  readonly storageRevision?: number;
  /** 置き場の全部のファイル (動画も) */
  listAll(): Promise<RunFileInfo[]>;
  /** 動画を読む URL */
  videoUrl(path: string): string;
  /** iCloud からの取り込みを始める (終わるのは待たない) */
  startDownload(path: string): Promise<void>;
  /** 読む。無いときだけ null、読めないときは例外 (runs.json を書く前に読むため) */
  readTextStrict(path: string): Promise<string | null>;
  /** 動画の範囲を読む窓口 (無ければ fetch で読む) */
  rangeReader?(path: string): ((start: number, end: number) => Promise<ArrayBuffer>) | undefined;
  /** ファイルが端末にあるか・取り込み中か (分からなければ local だけ) */
  fileStatus(path: string): Promise<{ local: boolean; downloading: boolean }>;
  /** 動画を lapfile:// で読めるか (古いアプリは読めない) */
  supportsVideos(): Promise<boolean>;
  /**
   * 走行のファイルを消す (iPhone・デスクトップ版はゴミ箱へ)。消せない環境 (前の版のアプリ・ブラウザ版) では無い。
   * サーキットのフォルダの中のものだけ (共有の控え・コース・セッションは消せない)
   */
  /** 消す (permanent: ゴミ箱へ移せず、すぐに消したもの。iPhone のアプリの中の保管場所など) */
  remove?(paths: string[]): Promise<{ deleted: string[]; failed: Array<{ path: string; error: string }>; permanent?: string[] }>;
  /** アプリのゴミ箱 (iPhone・iPad のアプリだけ。runTrash.ts)。無い環境では今までどおり remove で消す */
  trash?: {
    move(paths: string[], id: string, manifest: string): Promise<{ moved: string[]; failed: Array<{ path: string; error: string }> }>;
    list(): Promise<Array<{ id: string; manifest?: string; files: Array<{ path: string; size: number }>; mtimeMs: number }>>;
    restore(id: string): Promise<{ restored: string[]; failed: Array<{ path: string; error: string }> }>;
    purge(ids: string[]): Promise<{ purged: string[]; failed: Array<{ path: string; error: string }> }>;
  };
}


export interface SchedulerPort { schedule(task: () => void, delayMs: number): unknown; cancel(handle: unknown): void; defer(task: () => void): void }
