import React, { useState, useRef, useEffect } from 'react';
import { ControlLine, Sector } from '../types/telemetry';
import { X, Plus, Trash2, Check, MapPin } from 'lucide-react';

interface CircuitEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentCircuitName: string;
  controlLine?: ControlLine;
  sectors: Sector[];
  onSaveCircuit: (name: string, controlLine: ControlLine, sectors: Sector[]) => void;
}

export const CircuitEditorModal: React.FC<CircuitEditorModalProps> = ({
  isOpen,
  onClose,
  currentCircuitName,
  controlLine,
  sectors: initialSectors,
  onSaveCircuit
}) => {
  if (!isOpen) return null;

  const [name, setName] = useState(currentCircuitName || 'カスタムコース');
  const [clLatA, setClLatA] = useState(controlLine?.latA.toString() || '35.372350');
  const [clLonA, setClLonA] = useState(controlLine?.lonA.toString() || '138.926850');
  const [clLatB, setClLatB] = useState(controlLine?.latB.toString() || '35.372020');
  const [clLonB, setClLonB] = useState(controlLine?.lonB.toString() || '138.927250');

  const [sectors, setSectors] = useState<Sector[]>(initialSectors);

  const handleAddSector = () => {
    const nextIdx = sectors.length + 1;
    setSectors([
      ...sectors,
      {
        id: `custom_s${Date.now()}`,
        name: `Sector ${nextIdx}`,
        latA: parseFloat(clLatA) + 0.002 * nextIdx,
        lonA: parseFloat(clLonA) + 0.002 * nextIdx,
        latB: parseFloat(clLatB) + 0.002 * nextIdx,
        lonB: parseFloat(clLonB) + 0.002 * nextIdx
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
    const newControlLine: ControlLine = {
      name: 'Start/Finish Line',
      latA: parseFloat(clLatA) || 0,
      lonA: parseFloat(clLonA) || 0,
      latB: parseFloat(clLatB) || 0,
      lonB: parseFloat(clLonB) || 0
    };

    onSaveCircuit(name, newControlLine, sectors);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#181c26] border border-[#2d364c] rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* モーダルヘッダー */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#272f42] bg-[#141722]">
          <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <MapPin size={18} className="text-amber-500" />
            コース・計測ライン（コントロールライン）編集
          </h3>
          <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-white">
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
              className="w-full bg-[#10131a] border border-[#2d364c] rounded-lg p-2 text-slate-100 focus:border-red-500 outline-none"
            />
          </div>

          {/* コントロールライン (スタート/フィニッシュ) */}
          <div className="bg-[#12151f] border border-[#272f42] rounded-lg p-4 space-y-3">
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
                  className="w-full bg-[#181c26] border border-[#2d364c] rounded p-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 text-[11px] mb-1">点A 経度 (Lon A)</label>
                <input
                  type="number"
                  step="0.000001"
                  value={clLonA}
                  onChange={e => setClLonA(e.target.value)}
                  className="w-full bg-[#181c26] border border-[#2d364c] rounded p-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 text-[11px] mb-1">点B 緯度 (Lat B)</label>
                <input
                  type="number"
                  step="0.000001"
                  value={clLatB}
                  onChange={e => setClLatB(e.target.value)}
                  className="w-full bg-[#181c26] border border-[#2d364c] rounded p-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 text-[11px] mb-1">点B 経度 (Lon B)</label>
                <input
                  type="number"
                  step="0.000001"
                  value={clLonB}
                  onChange={e => setClLonB(e.target.value)}
                  className="w-full bg-[#181c26] border border-[#2d364c] rounded p-1.5 font-mono"
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
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#232b3d] hover:bg-[#2e3850] text-slate-200 border border-[#333d54] text-[11px]"
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
                  className="bg-[#12151f] border border-[#272f42] rounded-lg p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <input
                      type="text"
                      value={sec.name}
                      onChange={e => handleUpdateSector(idx, 'name', e.target.value)}
                      className="bg-[#181c26] border border-[#2d364c] rounded px-2 py-0.5 text-xs font-bold text-amber-400"
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
                      className="bg-[#181c26] border border-[#2d364c] rounded p-1"
                    />
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.lonA}
                      onChange={e => handleUpdateSector(idx, 'lonA', parseFloat(e.target.value) || 0)}
                      placeholder="Lon A"
                      className="bg-[#181c26] border border-[#2d364c] rounded p-1"
                    />
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.latB}
                      onChange={e => handleUpdateSector(idx, 'latB', parseFloat(e.target.value) || 0)}
                      placeholder="Lat B"
                      className="bg-[#181c26] border border-[#2d364c] rounded p-1"
                    />
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.lonB}
                      onChange={e => handleUpdateSector(idx, 'lonB', parseFloat(e.target.value) || 0)}
                      placeholder="Lon B"
                      className="bg-[#181c26] border border-[#2d364c] rounded p-1"
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* フッター */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#272f42] bg-[#141722]">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-[#2d364c] text-xs text-slate-300 hover:bg-[#222838]"
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
