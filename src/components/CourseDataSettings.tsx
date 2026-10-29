import React from 'react';
import { FolderOpen, X } from 'lucide-react';
import { useT } from '../utils/i18n';

/**
 * 設定の「コースのデータ」。コースフォルダの一括設置と、それを外すボタン (2026-10-29 に解析の「走行とコース」から移した)。
 * アプリ全体のコースの登録なので、開いているログには関係なく、ここに置く。読み込んだあとの処理は App.tsx の folderInputRef
 */
export const CourseDataSettings: React.FC<{
  /** 登録しているユーザーコースの数 (一括設置・コース編集で保存したもの) */
  count: number;
  onInstall: () => void;
  /** 一括設置したコースデータがあるときだけ */
  onClear?: () => void;
}> = ({ count, onInstall, onClear }) => {
  const t = useT();
  return (
    <section className="space-y-2" data-testid="course-data-settings">
      <h3 className="text-xs text-slate-500 px-1">{t('コースのデータ', 'Course data')}</h3>
      <div className="rounded-xl bg-surface-1 border border-line-2 p-3 space-y-2">
        <p className="text-xs text-slate-400">
          {t(
            '公式アプリや自前の Circuit / ControlLine フォルダを選ぶと、中のコース (計測線・セクター・コース図) をまとめて登録します。読み込み済みのログにも当てはめます。',
            'Select a Circuit / ControlLine folder (from the official app or your own) to install every course in it (timing lines, sectors, track maps). Logs already loaded are updated too.'
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onInstall}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-700/80 hover:bg-emerald-600 text-xs text-white font-medium transition-colors shadow cursor-pointer"
            data-testid="install-course-folder"
          >
            <FolderOpen size={13} />
            {t('コースフォルダ一括設置', 'Install course folder')}
          </button>
          {onClear && (
            <button
              onClick={onClear}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 hover:bg-surface-4 border border-line-3 text-xs text-slate-300 font-medium transition-colors cursor-pointer"
              title={t('コースフォルダ一括設置で読み込んだコースデータを外して、内蔵のコースに戻す', 'Remove the course data installed from a folder and go back to the built-in courses')}
              data-testid="clear-course-folder"
            >
              <X size={13} />
              {t('一括設置を外す', 'Remove installed courses')}
            </button>
          )}
          {count > 0 && (
            <span className="text-[11px] text-slate-400">{t(`登録しているコース: ${count} 件`, `Installed courses: ${count}`)}</span>
          )}
        </div>
      </div>
    </section>
  );
};
