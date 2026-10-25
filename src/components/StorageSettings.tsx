import React, { useEffect, useState } from 'react';
import { FolderOpen, Smartphone } from 'lucide-react';
import { useT } from '../utils/i18n';
import { callNative, hasNative } from '../native/bridge';
import type { StorageInfo } from '../native/contract';
import { storageFolderChanged } from '../services/storageCourses';

/** Android のアプリか (保管場所の言い方と、フォルダを選べるか) */
const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

/**
 * 保管場所 (走行のファイルを置くフォルダ)。2026-10-21 に、ラップタイマーのメニューから設定の画面へ移した (PLAN-24 の 3)。
 * - iPhone のアプリ: この iPhone / 選んだフォルダ (iCloud Drive など)。フォルダを選んだら、すぐ移す (アプリの中に控えを残さない。2026-10-21)
 * - デスクトップ版: 選んだフォルダ
 */
export const StorageSettings: React.FC = () => {
  const t = useT();
  const native = hasNative();
  const desktop = !!window.electronAPI?.laps;
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  /** 結果の 1 行 (ok: うまくいった・text: そのまま出す文) */
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (native) callNative('system.storageInfo', {}).then(setInfo, () => setInfo(null));
    else if (desktop) void window.electronAPI!.laps!.getFolder().then(setFolderPath, () => setFolderPath(null));
  }, [native, desktop]);

  const choose = async (kind: 'local' | 'folder') => {
    setBusy(true);
    setNote(null);
    try {
      const next = kind === 'folder' ? await callNative('system.pickStorageFolder', {}) : await callNative('system.setStorageLocal', {});
      setInfo(next);
      if (next.kind === 'folder') {
        const r = await callNative('system.syncLapFiles', {});
        setNote(r.error
          ? { ok: false, text: t(`フォルダへ移せませんでした: ${r.error}`, `Could not move to the folder: ${r.error}`) }
          : { ok: true, text: t(`フォルダへ ${r.copied + (r.moved ?? 0)} 個のファイルを移しました`, `Moved ${r.copied + (r.moved ?? 0)} files to the folder`) });
      }
      // 新しい保管場所のコースデータ・コーナーの名前を読み直す (ファイルを移したあとで)
      void storageFolderChanged();
    } catch (e) {
      // フォルダを選ぶのをやめたときは何も出さない
      const msg = e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e);
      if (msg !== 'cancelled') setNote({ ok: false, text: t(`保管場所を変えられませんでした: ${msg}`, `Could not change the storage: ${msg}`) });
    } finally {
      setBusy(false);
    }
  };

  const pickDesktop = async () => {
    try {
      const p = await window.electronAPI?.laps?.pickFolder();
      if (p) { setFolderPath(p); void storageFolderChanged(); }
    } catch (e) {
      setNote({ ok: false, text: t(`フォルダを選べませんでした: ${e instanceof Error ? e.message : String(e)}`, `Could not choose the folder: ${e instanceof Error ? e.message : String(e)}`) });
    }
  };

  if (!native && !desktop) return null;
  const btn = (on: boolean) => `w-full flex items-center gap-2 text-left px-4 py-3 text-sm cursor-pointer disabled:opacity-50 ${on ? 'bg-sky-600 text-white' : 'text-slate-200 hover:bg-surface-3'}`;
  return (
    <section className="space-y-2" data-testid="storage-settings">
      <h3 className="text-xs text-slate-500 px-1">{t('保管場所 (走行のファイルを置くフォルダ)', 'Storage (folder for your runs)')}</h3>
      <div className="rounded-xl bg-surface-1 border border-line-2 overflow-hidden divide-y divide-line-2">
        {native && info && (
          <>
            <button onClick={() => void choose('local')} disabled={busy} className={btn(info.kind === 'local')}>
              <Smartphone size={16} className="shrink-0" />{isAndroid ? t('この端末', 'This device') : t('この iPhone', 'This iPhone')}
            </button>
            <button onClick={() => void choose('folder')} disabled={busy} className={btn(info.kind === 'folder')} data-testid="storage-pick-folder">
              <FolderOpen size={16} className="shrink-0" />
              <span className="truncate">
                {info.kind === 'folder' && info.folderName
                  ? t(`フォルダ: ${info.folderName} (選び直す)`, `Folder: ${info.folderName} (change)`)
                  : isAndroid
                    ? t('フォルダを選ぶ (端末の中・Google ドライブなど)', 'Choose a folder (on the device, Google Drive etc.)')
                    : t('フォルダを選ぶ (iCloud Drive など)', 'Choose a folder (iCloud Drive etc.)')}
              </span>
            </button>
          </>
        )}
        {desktop && (
          <button onClick={() => void pickDesktop()} className={btn(false)} data-testid="storage-pick-folder">
            <FolderOpen size={16} className="shrink-0" />
            <span className="truncate" title={folderPath ?? undefined}>{folderPath ? t(`${folderPath} (変える)`, `${folderPath} (change)`) : t('フォルダを選ぶ', 'Choose a folder')}</span>
          </button>
        )}
      </div>
      {note && <p className={`text-[11px] px-1 ${note.ok ? 'text-slate-400' : 'text-amber-500'}`}>{note.text}</p>}
      <p className="text-[11px] text-slate-500 px-1">
        {native && isAndroid
          ? t('サーキットごとのフォルダが並ぶ場所を選びます。走っている間はこの端末に書き、測り終えたら選んだフォルダへ移します (この端末には残しません)。パソコンへ移す・ほかの端末と分けるときに使います。あとで「この端末」に戻しても、移した走行はフォルダに残ります。',
            'Choose the folder that holds a folder per circuit. While driving, runs are written to this device and moved to the chosen folder when you stop (not kept on the device). Use it to move runs to a computer or share them. If you switch back to This device later, moved runs stay in the folder.')
          : native
          ? t('サーキットごとのフォルダが並ぶ場所を選びます。走っている間はこの iPhone に書き、ときどき選んだフォルダへ写します。測り終えたら選んだフォルダへ移し、この iPhone には残しません (フォルダで消したものは消えたままです)。あとで「この iPhone」に戻しても、移した走行はフォルダに残ります。',
            'Choose the folder that holds a folder per circuit. While driving, runs are written to this iPhone and copied to the chosen folder from time to time. When you stop measuring they are moved to the folder and not kept on this iPhone (what you delete in the folder stays deleted). If you switch back to This iPhone later, moved runs stay in the folder.')
          : t('サーキットごとのフォルダが並ぶ場所を選びます (iPhone のアプリと同じ iCloud Drive のフォルダにすると、両方で同じ走行を開けます)。',
            'Choose the folder that holds a folder per circuit (use the same iCloud Drive folder as the iPhone app to open the same runs on both).')}
      </p>
    </section>
  );
};

/** 保管場所の 1 行の説明 (走行の画面の上に出す)。active が true になるたびに読み直す (設定で保管場所を替えて戻ったとき) */
export function useStorageLabel(active = true): string | null {
  const t = useT();
  // 読んだもの。「この iPhone」は出すときに言葉にする (言語を替えても日本語のまま残っていた)
  const [info, setInfo] = useState<{ device: true } | { name: string } | null>(null);
  useEffect(() => {
    if (!active) return;
    if (hasNative()) {
      callNative('system.storageInfo', {}).then(
        i => setInfo(i.kind === 'folder' && i.folderName ? { name: i.folderName } : { device: true }),
        () => setInfo(null)
      );
    } else if (window.electronAPI?.laps) {
      void window.electronAPI.laps.getFolder().then(p => setInfo(p ? { name: p.replace(/^.*Mobile Documents\/com~apple~CloudDocs/, 'iCloud Drive') } : null));
    }
  }, [active]);
  if (!info) return null;
  return 'name' in info ? info.name : isAndroid ? t('この端末', 'This device') : t('この iPhone', 'This iPhone');
}
