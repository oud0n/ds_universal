import React, { useState, useRef, useEffect } from 'react';
import { ControlLine, Sector } from '../types/telemetry';
import { X, Plus, Trash2, Check, MapPin } from 'lucide-react';

interface CircuitEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentCircuitName: string;
  controlLine?: ControlLine;
  // 計測線が未設定のときの初期値に使う位置 (読み込んだログの先頭など)
  defaultPosition?: { lat: number; lon: number };
  sectors: Sector[];
  onSaveCircuit: (name: string, controlLine: ControlLine, sectors: Sector[]) => void;
}

export const CircuitEditorModal: React.FC<CircuitEditorModalProps> = ({
  isOpen,
  onClose,
  currentCircuitName,
  controlLine,
  defaultPosition,
  sectors: initialSectors,
  onSaveCircuit
}) => {
  if (!isOpen) return null;

  const [name, setName] = useState(currentCircuitName || 'カスタムコース');
  // 計測線が未設定なら、ログの位置を挟む南北約 30 m の線分を仮の初期値にする (ログも無ければ空欄)
  const initial = controlLine ?? (defaultPosition && {
    latA: Number((defaultPosition.lat + 0.00015).toFixed(6)),
    lonA: Number(defaultPosition.lon.toFixed(6)),
    latB: Number((defaultPosition.lat - 0.00015).toFixed(6)),
    lonB: Number(defaultPosition.lon.toFixed(6))
  });
  const [clLatA, setClLatA] = useState(initial ? initial.latA.toString() : '');
  const [clLonA, setClLonA] = useState(initial ? initial.lonA.toString() : '');
  const [clLatB, setClLatB] = useState(initial ? initial.latB.toString() : '');
  const [clLonB, setClLonB] = useState(initial ? initial.lonB.toString() : '');
  const [saveError, setSaveError] = useState('');

  const [sectors, setSectors] = useState<Sector[]>(initialSectors);

  const handleAddSector = () => {
    const nextIdx = sectors.length + 1;
    setSectors([
      ...sectors,
      {
        id: `custom_s${Date.now()}`,
        name: `Sector ${nextIdx}`,
        latA: (parseFloat(clLatA) || 0) + 0.002 * nextIdx,
        lonA: (parseFloat(clLonA) || 0) + 0.002 * nextIdx,
        latB: (parseFloat(clLatB) || 0) + 0.002 * nextIdx,
        lonB: (parseFloat(clLonB) || 0) + 0.002 * nextIdx
      }
    ]);
  };

  const handleUpdateSector = (idx: number, field: keyof Sector, val: any) => {
    const updated = [...sectors];
    updated[idx] = { ...updated[idx], [field]: val };
    setSectors(updated);
  };

  const handleRemoveSector = (idx: number) => {
    setSectors(sectors.filter((_, i) => i !== idx));
  };

  const handleSave = () => {
    const values = [clLatA, clLonA, clLatB, clLonB].map(v => parseFloat(v));
    const [latA, lonA, latB, lonB] = values;
    // 空欄や範囲外の値を 0 に置き換えて保存しない (緯度経度 0 の計測線になってしまう)
    if (
      values.some(v => !Number.isFinite(v)) ||
      Math.abs(latA) > 90 || Math.abs(latB) > 90 || Math.abs(lonA) > 180 || Math.abs(lonB) > 180 ||
      (latA === latB && lonA === lonB)
    ) {
      setSaveError('計測線の 2 点の緯度・経度を正しく入力してください');
      return;
    }
    const badSector = sectors.find(sec =>
      ![sec.latA, sec.lonA, sec.latB, sec.lonB].every(Number.isFinite) ||
      Math.abs(sec.latA) > 90 || Math.abs(sec.latB) > 90 || Math.abs(sec.lonA) > 180 || Math.abs(sec.lonB) > 180 ||
      (sec.latA === 0 && sec.lonA === 0) || (sec.latB === 0 && sec.lonB === 0) ||
      (sec.latA === sec.latB && sec.lonA === sec.lonB)
    );
    if (badSector) {
      setSaveError(`セクター「${badSector.name}」の 2 点の緯度・経度を正しく入力してください`);
      return;
    }
    const newControlLine: ControlLine = { name: 'Start/Finish Line', latA, lonA, latB, lonB };

    onSaveCircuit(name, newControlLine, sectors);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-surface-2 border border-line-3 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* モーダルヘッダー */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-2 bg-surface-1">
          <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <MapPin size={18} className="text-amber-500" />
            コース・計測ライン（コントロールライン）編集
          </h3>
          <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-fg">
            <X size={18} />
          </button>
        </div>

        {/* モーダルコンテンツ */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs text-slate-200">
          {/* コース名 */}
          <div>
            <label className="block font-bold text-slate-300 mb-1">コース名 / サーキット名</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-surface-0 border border-line-3 rounded-lg p-2 text-slate-100 focus:border-red-500 outline-none"
            />
          </div>

          {/* コントロールライン (スタート/フィニッシュ) */}
          <div className="bg-surface-1 border border-line-2 rounded-lg p-4 space-y-3">
            <div className="font-bold text-amber-400">コントロールライン (スタート/フィニッシュ計測線)</div>
            <p className="text-[11px] text-slate-400">
              コースのスタート/フィニッシュラインを通過する線分（点Aと点Bの座標）を指定します。
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-400 text-[11px] mb-1">点A 緯度 (Lat A)</label>
                <input
                  type="number"
                  step="0.000001"
                  value={clLatA}
                  onChange={e => setClLatA(e.target.value)}
                  className="w-full bg-surface-2 border border-line-3 rounded p-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 text-[11px] mb-1">点A 経度 (Lon A)</label>
                <input
                  type="number"
                  step="0.000001"
                  value={clLonA}
                  onChange={e => setClLonA(e.target.value)}
                  className="w-full bg-surface-2 border border-line-3 rounded p-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 text-[11px] mb-1">点B 緯度 (Lat B)</label>
                <input
                  type="number"
                  step="0.000001"
                  value={clLatB}
                  onChange={e => setClLatB(e.target.value)}
                  className="w-full bg-surface-2 border border-line-3 rounded p-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 text-[11px] mb-1">点B 経度 (Lon B)</label>
                <input
                  type="number"
                  step="0.000001"
                  value={clLonB}
                  onChange={e => setClLonB(e.target.value)}
                  className="w-full bg-surface-2 border border-line-3 rounded p-1.5 font-mono"
                />
              </div>
            </div>
          </div>

          {/* セクターゲート */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-300">セクターゲート設定</span>
              <button
                onClick={handleAddSector}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-4 hover:bg-surface-5 text-slate-200 border border-line-4 text-[11px]"
              >
                <Plus size={13} />
                セクター追加
              </button>
            </div>

            {sectors.length === 0 ? (
              <p className="text-slate-500 text-[11px] italic">セクターが設定されていません</p>
            ) : (
              sectors.map((sec, idx) => (
                <div
                  key={sec.id}
                  className="bg-surface-1 border border-line-2 rounded-lg p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <input
                      type="text"
                      value={sec.name}
                      onChange={e => handleUpdateSector(idx, 'name', e.target.value)}
                      className="bg-surface-2 border border-line-3 rounded px-2 py-0.5 text-xs font-bold text-amber-400"
                    />
                    <button
                      onClick={() => handleRemoveSector(idx)}
                      className="p-1 text-slate-500 hover:text-red-400"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-[10px] font-mono">
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.latA}
                      onChange={e => handleUpdateSector(idx, 'latA', parseFloat(e.target.value) || 0)}
                      placeholder="Lat A"
                      className="bg-surface-2 border border-line-3 rounded p-1"
                    />
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.lonA}
                      onChange={e => handleUpdateSector(idx, 'lonA', parseFloat(e.target.value) || 0)}
                      placeholder="Lon A"
                      className="bg-surface-2 border border-line-3 rounded p-1"
                    />
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.latB}
                      onChange={e => handleUpdateSector(idx, 'latB', parseFloat(e.target.value) || 0)}
                      placeholder="Lat B"
                      className="bg-surface-2 border border-line-3 rounded p-1"
                    />
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.lonB}
                      onChange={e => handleUpdateSector(idx, 'lonB', parseFloat(e.target.value) || 0)}
                      placeholder="Lon B"
                      className="bg-surface-2 border border-line-3 rounded p-1"
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* フッター */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line-2 bg-surface-1">
          {saveError && <span className="mr-auto text-xs text-amber-400">{saveError}</span>}
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-line-3 text-xs text-slate-300 hover:bg-surface-4"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-xs text-white font-bold transition-all shadow"
          >
            <Check size={14} />
            保存して適用
          </button>
        </div>
      </div>
    </div>
  );
};
