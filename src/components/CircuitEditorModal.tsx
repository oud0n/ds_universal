import React, { useState, useRef, useEffect } from 'react';
import { ControlLine, Sector } from '../types/telemetry';
import { X, Plus, Trash2, Check, MapPin, Upload, Download } from 'lucide-react';
import { parseCln, exportCln } from '../services/pthParser';
import { parseSci, exportSci, userCircuitStorage, UserCircuitItem } from '../services/userCircuitStorage';

interface CircuitEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentCircuitName: string;
  controlLine?: ControlLine;
  // 計測線が未設定のときの初期値に使う位置 (読み込んだログの先頭など)
  defaultPosition?: { lat: number; lon: number };
  sectors: Sector[];
  // 保存したコースを消したとき (データ管理の件数の表示を直す)
  onSavedCircuitsChange?: () => void;
  // remember: アプリに保存して、次から同じ場所のログに使う
  onSaveCircuit: (name: string, controlLine: ControlLine, sectors: Sector[], remember: boolean) => void;
}

// 自動で判定したユーザーコースの名前に付く印。保存するときは外す
const USER_SUFFIX = ' (ユーザー設置)';

function downloadText(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export const CircuitEditorModal: React.FC<CircuitEditorModalProps> = ({
  isOpen,
  onClose,
  currentCircuitName,
  controlLine,
  defaultPosition,
  sectors: initialSectors,
  onSavedCircuitsChange,
  onSaveCircuit
}) => {
  const [name, setName] = useState((currentCircuitName || 'カスタムコース').replace(USER_SUFFIX, ''));
  const [remember, setRemember] = useState(true);
  // 計測線がないときに .sci を読み込んだか (保存・書き出しのときに、計測線までのフィニッシュを足す)
  const [needsFinish, setNeedsFinish] = useState(false);
  const [fileMessage, setFileMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // コース編集で保存したコース (呼び出し・削除用)
  const [savedCircuits, setSavedCircuits] = useState<UserCircuitItem[]>(() => [...userCircuitStorage.getEditedCircuits()]);
  useEffect(() => {
    userCircuitStorage.ready.then(() => setSavedCircuits([...userCircuitStorage.getEditedCircuits()]));
  }, []);

  const handleLoadSaved = (c: UserCircuitItem) => {
    setName(c.name);
    setClLatA(String(c.controlLine.latA));
    setClLonA(String(c.controlLine.lonA));
    setClLatB(String(c.controlLine.latB));
    setClLonB(String(c.controlLine.lonB));
    setSectors(c.sectors);
    setNeedsFinish(false);
    setFileMessage(`「${c.name}」を呼び出しました`);
  };

  const handleDeleteSaved = async (c: UserCircuitItem) => {
    if (!confirm(`保存したコース「${c.name}」を削除しますか？ (読み込み済みのログの設定はそのままです)`)) return;
    const r = await userCircuitStorage.deleteEditedCircuit(c.name);
    setSavedCircuits([...userCircuitStorage.getEditedCircuits()]);
    onSavedCircuitsChange?.();
    if (!r.saved) setSaveError(`削除を保存できませんでした: ${r.saveError ?? ''}`);
  };
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
    // 最後がフィニッシュ (計測線まで) のときは、その前に足す (フィニッシュより後ろのセクターは区間がおかしくなる)
    const finishIdx = sectors.length > 0 && sectors[sectors.length - 1].id.endsWith('_finish') ? sectors.length - 1 : sectors.length;
    setSectors([
      ...sectors.slice(0, finishIdx),
      {
        id: `custom_s${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: `Sector ${nextIdx}`,
        latA: (parseFloat(clLatA) || 0) + 0.002 * nextIdx,
        lonA: (parseFloat(clLonA) || 0) + 0.002 * nextIdx,
        latB: (parseFloat(clLatB) || 0) + 0.002 * nextIdx,
        lonB: (parseFloat(clLonB) || 0) + 0.002 * nextIdx
      },
      ...sectors.slice(finishIdx)
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

  // 計測線の入力欄の値 (正しくなければ null)
  const readControlLine = (): ControlLine | null => {
    const values = [clLatA, clLonA, clLatB, clLonB].map(v => parseFloat(v));
    const [latA, lonA, latB, lonB] = values;
    if (
      values.some(v => !Number.isFinite(v)) ||
      Math.abs(latA) > 90 || Math.abs(latB) > 90 || Math.abs(lonA) > 180 || Math.abs(lonB) > 180 ||
      (latA === latB && lonA === lonB)
    ) return null;
    return { name: 'Start/Finish Line', latA, lonA, latB, lonB };
  };

  // 緯度・経度の正しくないセクター (空欄・範囲外・0,0・2 点が同じ)
  const findBadSector = (list: Sector[]) => list.find(sec =>
    ![sec.latA, sec.lonA, sec.latB, sec.lonB].every(Number.isFinite) ||
    Math.abs(sec.latA) > 90 || Math.abs(sec.latB) > 90 || Math.abs(sec.lonA) > 180 || Math.abs(sec.lonB) > 180 ||
    (sec.latA === 0 && sec.lonA === 0) || (sec.latB === 0 && sec.lonB === 0) ||
    (sec.latA === sec.latB && sec.lonA === sec.lonB)
  );

  // フィニッシュのセクター (id が _finish で終わる) は、計測線と同じ線にする (計測線を直したら付いていく)
  const withFinish = (list: Sector[], cl: ControlLine): Sector[] => {
    const updated = list.map(s => (s.id.endsWith('_finish') ? { ...s, latA: cl.latA, lonA: cl.lonA, latB: cl.latB, lonB: cl.lonB } : s));
    if (!needsFinish || updated.length === 0 || updated.some(s => s.id.endsWith('_finish'))) return updated;
    return [...updated, { id: `custom_${Date.now()}_finish`, name: `S${updated.length + 1}`, latA: cl.latA, lonA: cl.lonA, latB: cl.latB, lonB: cl.lonB }];
  };

  // .cln (計測線) と .sci (セクター) を読み込む。両方選んだときは、.cln を先に読む (.sci のフィニッシュに使うため)
  const handleImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = [...files].sort((a, b) => (/\.cln$/i.test(a.name) ? 0 : 1) - (/\.cln$/i.test(b.name) ? 0 : 1));
    const done: string[] = [];
    const errors: string[] = [];
    let cl = readControlLine();
    const sciCount = list.filter(f => /\.sci$/i.test(f.name)).length;
    if (sciCount > 1) errors.push('.sci を複数選んだので、最後のものだけを使いました');
    if (list.filter(f => /\.cln$/i.test(f.name)).length > 1) errors.push('.cln を複数選んだので、最後のものだけを使いました');
    for (const f of list) {
      try {
        const text = await f.text();
        if (/\.cln$/i.test(f.name)) {
          cl = parseCln(text);
          setClLatA(String(cl.latA));
          setClLonA(String(cl.lonA));
          setClLatB(String(cl.latB));
          setClLonB(String(cl.lonB));
          done.push(f.name);
        } else if (/\.sci$/i.test(f.name)) {
          const prefix = `custom_${Date.now()}`;
          const gates = parseSci(text, prefix);
          // 公式の .sci はフィニッシュ (計測線) を含まないので、最後の区間として足す (アプリの中では計測線までを最後のセクターにする)
          const finish = cl
            ? [{ id: `${prefix}_finish`, name: `S${gates.length + 1}`, latA: cl.latA, lonA: cl.lonA, latB: cl.latB, lonB: cl.lonB }]
            : [];
          setSectors([...gates, ...finish]);
          setNeedsFinish(!cl);
          done.push(f.name);
          if (!cl) errors.push('計測線を入れると、保存するときに最後の区間 (計測線まで) を足します');
        } else {
          errors.push(`${f.name}: .cln か .sci を選んでください`);
        }
      } catch (e) {
        errors.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setFileMessage([done.length ? `読み込みました: ${done.join(', ')}` : '', ...errors].filter(Boolean).join(' / '));
  };

  // 計測線を .cln、セクターを .sci に書き出す (公式アプリと同じ形)
  const handleExportFiles = () => {
    const cl = readControlLine();
    if (!cl) {
      setSaveError('計測線の 2 点の緯度・経度を正しく入力してください');
      return;
    }
    const finished = withFinish(sectors, cl);
    const badSector = findBadSector(finished);
    if (badSector) {
      setSaveError(`セクター「${badSector.name}」の 2 点の緯度・経度を正しく入力してください`);
      return;
    }
    setSaveError('');
    // ファイル名に使えない文字と、末尾の点・空白 (Windows で使えない) を置き換える
    const base = (name.trim() || 'course').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').replace(/^cl_/i, '') || 'course';
    downloadText(exportCln(cl), `cl_${base}.cln`);
    const sci = exportSci(finished, cl);
    if (sci) downloadText(sci, `${base}.sci`);
    setFileMessage(sci ? `書き出しました: cl_${base}.cln, ${base}.sci` : `書き出しました: cl_${base}.cln (セクターがないので .sci は書き出していません)`);
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
    const newControlLine: ControlLine = { name: 'Start/Finish Line', latA, lonA, latB, lonB };
    const badSector = findBadSector(withFinish(sectors, newControlLine));
    if (badSector) {
      setSaveError(`セクター「${badSector.name}」の 2 点の緯度・経度を正しく入力してください`);
      return;
    }
    const saveName = name.trim() || 'カスタムコース';
    // 同じ名前で別の場所のコースを保存していたら、上書きしてよいか聞く (名前を付けずに別のコースで保存したときなど)
    if (remember && userCircuitStorage.isEditedNameUsedElsewhere(saveName, newControlLine) &&
        !confirm(`「${saveName}」という名前で、別の場所のコースを保存しています。上書きしますか？ (残すときは、キャンセルしてコース名を変えてください)`)) {
      return;
    }

    onSaveCircuit(saveName, newControlLine, withFinish(sectors, newControlLine), remember);
    onClose();
  };

  // フックをすべて呼んでから閉じているときは何も出さない (フックの数を変えない)
  if (!isOpen) return null;

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

          {/* ファイルの読み込み・書き出し (公式アプリと同じ .cln / .sci) */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-4 hover:bg-surface-5 text-slate-200 border border-line-4 text-[11px]"
              title="計測線 (.cln) とセクター (.sci) を読み込みます。両方まとめて選べます"
            >
              <Upload size={13} />
              .cln / .sci を読み込む
            </button>
            <button
              onClick={handleExportFiles}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-4 hover:bg-surface-5 text-slate-200 border border-line-4 text-[11px]"
              title="計測線を .cln、セクターを .sci に書き出します (公式アプリと同じ形)"
            >
              <Download size={13} />
              .cln / .sci に書き出す
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".cln,.sci"
              multiple
              className="hidden"
              onChange={e => {
                handleImportFiles(e.target.files);
                e.target.value = '';
              }}
            />
            {fileMessage && <span className="text-[11px] text-slate-400">{fileMessage}</span>}
          </div>

          {/* コース編集で保存したコース */}
          {savedCircuits.length > 0 && (
            <div className="bg-surface-1 border border-line-2 rounded-lg p-3 space-y-1.5">
              <div className="font-bold text-slate-300">保存したコース</div>
              {savedCircuits.map(c => (
                <div key={c.id} className="flex items-center gap-2 text-[11px]">
                  <span className="flex-1 truncate text-slate-200">{c.name}</span>
                  <span className="text-slate-500">セクター {c.sectors.length}</span>
                  <button
                    onClick={() => handleLoadSaved(c)}
                    className="px-2 py-0.5 rounded bg-surface-4 hover:bg-surface-5 border border-line-4 text-slate-200"
                  >
                    呼び出す
                  </button>
                  <button
                    onClick={() => handleDeleteSaved(c)}
                    className="p-1 text-slate-500 hover:text-red-400"
                    title="削除"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

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
                  {sec.id.endsWith('_finish') && (
                    <p className="text-[10px] text-slate-500">フィニッシュ (計測線まで)。位置は計測線と同じになります</p>
                  )}
                  <div className="grid grid-cols-4 gap-2 text-[10px] font-mono">
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.latA}
                      onChange={e => handleUpdateSector(idx, 'latA', parseFloat(e.target.value) || 0)}
                      placeholder="Lat A"
                      disabled={sec.id.endsWith('_finish')}
                      className="bg-surface-2 border border-line-3 rounded p-1 disabled:opacity-60"
                    />
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.lonA}
                      onChange={e => handleUpdateSector(idx, 'lonA', parseFloat(e.target.value) || 0)}
                      placeholder="Lon A"
                      disabled={sec.id.endsWith('_finish')}
                      className="bg-surface-2 border border-line-3 rounded p-1 disabled:opacity-60"
                    />
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.latB}
                      onChange={e => handleUpdateSector(idx, 'latB', parseFloat(e.target.value) || 0)}
                      placeholder="Lat B"
                      disabled={sec.id.endsWith('_finish')}
                      className="bg-surface-2 border border-line-3 rounded p-1 disabled:opacity-60"
                    />
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.lonB}
                      onChange={e => handleUpdateSector(idx, 'lonB', parseFloat(e.target.value) || 0)}
                      placeholder="Lon B"
                      disabled={sec.id.endsWith('_finish')}
                      className="bg-surface-2 border border-line-3 rounded p-1 disabled:opacity-60"
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* フッター */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line-2 bg-surface-1">
          <label className="mr-auto flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer" title="アプリに保存し、次からこの計測線を通るログに使います (データ管理の「ユーザーコース」に入ります)">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            アプリに保存して、次からも使う
          </label>
          {saveError && <span className="text-xs text-amber-400">{saveError}</span>}
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
