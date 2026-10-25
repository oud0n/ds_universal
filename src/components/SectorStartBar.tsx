import React from 'react';
import type { Sector } from '../types/telemetry';
import { useT } from '../utils/i18n';

/**
 * セクターからの一斉スタート (S1〜Sn) と、そろえ方 (Car 1 に合わせる / 全車をそろえる)。
 * もとはアニメの窓だけにあった (PLAN-28 でコースの窓にも出す)
 */
export interface SectorStartProps {
  sectors: Sector[];
  onSyncSectorStart: (sectorIndex: number) => void;
  sectorStartMode: 'base' | 'all';
  onChangeSectorStartMode: (mode: 'base' | 'all') => void;
  alignedSectorName?: string;
  alignFailedCount: number;
  alignBaseMissing?: boolean;
  onClearAlignedSector: () => void;
}

export const SectorStartBar: React.FC<SectorStartProps & { compact: boolean }> = ({
  sectors, onSyncSectorStart, sectorStartMode, onChangeSectorStartMode, alignedSectorName, alignFailedCount, alignBaseMissing, onClearAlignedSector, compact
}) => {
  const t = useT();
  if (sectors.length === 0) return null;
  return (
      <div className={`flex flex-wrap items-center gap-1 ${compact ? '' : 'ml-2'}`}>
        <span className="text-[10px] text-slate-400 font-medium">{compact ? t('同時:', 'Start:') : t('同時スタート:', 'Common start:')}</span>
        <div className="flex gap-1">
          {sectors.map((sec, idx) => (
            <button
              key={sec.id}
              onClick={() => onSyncSectorStart(idx)}
              title={sectorStartMode === 'all'
                ? t(`全車が S${idx + 1} の始まり (${idx === 0 ? '計測線' : `${sectors[idx - 1].name || `S${idx}`} の線`}) を同時に通るよう時刻をそろえて、そこから一斉スタート (時間基準)`,
                    `Align the times so every car crosses the start of S${idx + 1} (${idx === 0 ? 'the timing line' : `the ${sectors[idx - 1].name || `S${idx}`} line`}) together, and start all cars from there (time based)`)
                : t(`S${idx + 1} の始まり (${idx === 0 ? '計測線' : `${sectors[idx - 1].name || `S${idx}`} の線`}) から一斉スタート (基準車の位置に合わせる)`,
                    `Start all cars from the start of S${idx + 1} (${idx === 0 ? 'the timing line' : `the ${sectors[idx - 1].name || `S${idx}`} line`}) (matched to the reference car's position)`)}
              className="px-1.5 py-0.5 rounded bg-surface-4 hover:bg-amber-600 hover:text-white text-slate-300 text-[10px] font-bold border border-line-4 transition-all"
            >
              {`S${idx + 1}`}
            </button>
          ))}
        </div>
        {/* 動作の切り替え: 基準車に合わせる / 全車をセクター線にそろえる */}
        <div className="flex bg-surface-1 rounded p-0.5 border border-line-3 ml-1">
          {(['base', 'all'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => onChangeSectorStartMode(mode)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-all ${
                sectorStartMode === mode ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
              title={mode === 'base' ? t('基準車 (Car 1) の位置に合わせる', 'Match the reference car (Car 1) position') : t('全車がそのセクター線を同時に通るようにそろえる', 'Align every car to cross the sector line together')}
            >
              {mode === 'base' ? (compact ? 'Car 1' : t('Car 1 に合わせる', 'Match Car 1')) : (compact ? t('全車', 'All') : t('全車をそろえる', 'Align all cars'))}
            </button>
          ))}
        </div>
        {alignedSectorName && (
          <button
            onClick={onClearAlignedSector}
            title={t('セクターにそろえるのをやめる', 'Stop aligning to the sector')}
            className="ml-1 px-1.5 py-0.5 rounded border border-amber-600/60 text-[10px] text-amber-300 hover:text-fg hover:bg-amber-700/40"
          >
            {alignBaseMissing
              ? `${alignedSectorName}: ${compact ? t('そろえられません', 'cannot align') : t('基準車がこの線を通っていないため、そろえられません', 'cannot align because the reference car does not cross this line')}`
              : `${t(`${alignedSectorName} ${compact ? 'そろえ中' : 'にそろえ中'}`, `Aligned to ${alignedSectorName}`)}${alignFailedCount > 0 ? t(`（${compact ? `${alignFailedCount} 台不可` : `${alignFailedCount} 台はそろえられません`}）`, ` (${alignFailedCount} ${compact ? 'failed' : 'cars could not be aligned'})`) : ''}`} ✕
          </button>
        )}
      </div>
  );
};
