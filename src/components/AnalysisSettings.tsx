import React from 'react';
import { useT } from '../utils/i18n';
import type { GFilterLevel } from '../services/physics';
import type { GSource } from '../services/imuG';
import { getAddVideoGpsLog, setAddVideoGpsLog } from '../services/videoPrefs';

/** 選ぶボタンの並び (設定の画面の中で同じ形にする) */
function Choice<V extends string>({ value, options, onChange, label, testId }: { value: V; options: ReadonlyArray<readonly [V, string]>; onChange: (v: V) => void; label: string; testId?: string }) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }} role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map(([v, text]) => (
        <button
          key={v}
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`py-2.5 px-1 rounded-lg text-xs border cursor-pointer ${value === v ? 'bg-surface-5 text-fg border-line-3' : 'text-slate-400 border-line-2 hover:bg-surface-3'}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * 設定の「解析」: G のならし方と G の出どころ (2026-11-01、PLAN-42 で解析の「走行とコース」とフリクションサークルの「なめらか」から移した)
 */
export const AnalysisSettings: React.FC<{
  gFilterLevel: GFilterLevel;
  onChangeGFilterLevel: (level: GFilterLevel) => void;
  gSource: GSource;
  onChangeGSource: (source: GSource) => void;
}> = ({ gFilterLevel, onChangeGFilterLevel, gSource, onChangeGSource }) => {
  const t = useT();
  return (
    <div className="space-y-4" data-testid="analysis-settings">
      <div className="space-y-2">
        <h3 className="text-xs text-slate-500 px-1">{t('G のならし方', 'G smoothing')}</h3>
        <Choice value={gFilterLevel} onChange={onChangeGFilterLevel} label={t('G のならし方', 'G smoothing')} testId="setting-g-filter"
          options={[['weak', t('弱', 'Light')], ['standard', t('標準', 'Standard')], ['strong', t('強 (なめらか・既定)', 'Strong (smooth, default)')]] as const} />
        <p className="text-[11px] text-slate-500 px-1 leading-relaxed">
          {t('G (加減速 G・横 G・合算 G) と旋回半径は、GPS の位置と車速の変化からアプリが計算しています。GPS の位置はわずかに揺れるので、計算した G も細かく揺れます。強くするほど速度グラフの G やフリクションサークルが落ち着きますが、急な変化 (ブレーキの踏み始めなど) は鈍く、小さく出ます。「標準」は記録レートに合わせます。読み込み済みのログ・変換で書き出す CSV・DTB にもすぐ効きます。元のログファイルは変わりません。',
            'G (longitudinal, lateral, combined) and the turning radius are calculated from changes in GPS position and speed. GPS positions jitter slightly, so the calculated G jitters too. Stronger smoothing calms the G on the speed graph and the friction circle, but sudden changes (such as the start of braking) appear slower and smaller. "Standard" adapts to the logging rate. Applies immediately to loaded logs and to CSV / DTB exports. The original log files are not changed.')}
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="text-xs text-slate-500 px-1">{t('G の出どころ (アプリのラップタイマーで測った走行)', 'G source (runs timed with the app\'s lap timer)')}</h3>
        <Choice value={gSource} onChange={onChangeGSource} label={t('G の出どころ', 'G source')} testId="setting-g-source"
          options={[['sensor', t('端末の G センサー', 'Phone sensor')], ['calc', t('計算', 'Calculated')]] as const} />
        <p className="text-[11px] text-slate-500 px-1 leading-relaxed">
          {t('アプリのラップタイマーで測った走行は、端末の G センサーの値も記録しています。「G センサー」にすると、ゆっくりした変化は計算した G、速い変化 (ブレーキの踏み始め・切り返し) は G センサーから取って合わせます。G センサーの細かい振動は、上のならし方に合わせて落とします。',
            'Runs timed with the app\'s lap timer also record the phone\'s G sensor. With "Phone sensor", slow changes come from the calculated G and fast changes (start of braking, direction changes) from the sensor. Fine vibration in the sensor is filtered according to the smoothing above.')}
        </p>
      </div>
    </div>
  );
};

/** 設定の「動画」: 動画の GPS もログとして加えるか (2026-11-01、PLAN-42 で動画タブの「合わせる」から移した) */
export const VideoSettings: React.FC = () => {
  const t = useT();
  const [on, setOn] = React.useState(getAddVideoGpsLog);
  return (
    <div className="space-y-2" data-testid="video-settings">
      <label className="flex items-center gap-3 px-4 py-3 rounded-xl bg-surface-1 border border-line-2 text-sm text-slate-200 cursor-pointer">
        <input type="checkbox" checked={on} onChange={e => { setOn(e.target.checked); setAddVideoGpsLog(e.target.checked); }} className="w-5 h-5 accent-sky-600" data-testid="setting-video-gps-log" />
        <span className="flex-1">{t('GoPro の動画の GPS も走行ログとして加える', 'Add the GPS in GoPro videos as a driving log')}</span>
      </label>
      <p className="text-[11px] text-slate-500 px-1 leading-relaxed">
        {t('切ると、同じ時間に記録の細かいログ (デジスパイスなど) があるとき、動画の GPS は走行ログに加えず、動画の時刻合わせだけに使います。次に読み込む動画から効きます。',
          'When off, if a log with a higher rate (e.g. DigSpice) covers the same time, the video GPS is only used to time the video and not added as a driving log. Applies to videos loaded next.')}
      </p>
    </div>
  );
};
