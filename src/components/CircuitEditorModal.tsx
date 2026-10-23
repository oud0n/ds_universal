import React, { useState, useRef, useEffect } from 'react';
import { ControlLine, Sector } from '../types/telemetry';
import { X, Plus, Trash2, Check, MapPin, Upload, Download } from 'lucide-react';
import { parseCln, exportCln } from '../services/pthParser';
import { parseSci, exportSci, userCircuitStorage, UserCircuitItem } from '../services/userCircuitStorage';
import { tr, useT, getLang } from '../utils/i18n';
import { CIRCUIT_PRESETS } from '../services/circuitDatabase';
import { checkEnglishName, checkFolderName, courseFolder, guessEnglishName, toFolderName } from '../utils/courseNames';
import { fileAccept } from '../utils/device';
import { useEscapeKey } from '../hooks/useEscapeKey';

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
  // ゴールの線 (スタートとゴールが別のコース)。無ければ計測線から計測線まで
  finishLine?: ControlLine;
  // remember: アプリに保存して、次から同じ場所のログに使う
  // extra: 英語名と、ラップタイマーの記録を入れるフォルダの名前 (半角の英字など。確かめてから渡す)、ゴールの線 (スタートとゴールが別のとき)
  onSaveCircuit: (name: string, controlLine: ControlLine, sectors: Sector[], remember: boolean, extra: { nameEn: string; folder: string; finishLine?: ControlLine }) => void;
}

// 自動で判定したユーザーコースの名前に付く印。保存するときは外す
const USER_SUFFIX = ' (ユーザー設置)';

// テキストファイルを保存する。Electron では保存ダイアログを出して、閉じるまで待つ
// (<a download> を 2 つ続けると、1 つ目のダイアログが開いている間の 2 つ目が捨てられるため。issue #7)。
// 戻り値: 保存した (ブラウザでは保存を始めた) とき true、キャンセルしたとき false。失敗したときは例外
async function saveText(text: string, fileName: string): Promise<boolean> {
  const api = window.electronAPI;
  if (api?.saveTextFile) {
    const res = await api.saveTextFile({ defaultName: fileName, text });
    if (!res.success && !res.canceled) throw new Error(res.error || 'save failed');
    return res.success;
  }
  downloadText(text, fileName);
  return true;
}

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
  finishLine,
  onSaveCircuit
}) => {
  const t = useT();
  // 名前のないコースは空にしておく (「カスタムコース」を入れておくと、英語名を入れてもその名前で保存されていた)。空のままなら英語名を名前にする
  const [name, setName] = useState((currentCircuitName || '').replace(USER_SUFFIX, ''));
  // 英語名とフォルダ名: 保存したコースならそれ、なければコースの名前から作った候補
  const initialSaved = userCircuitStorage.getEditedCircuits().find(c => c.name === (currentCircuitName || '').replace(USER_SUFFIX, ''));
  const [nameEn, setNameEn] = useState(() => initialSaved?.nameEn ?? guessEnglishName(currentCircuitName.replace(USER_SUFFIX, '')));
  // 入っているコースなら、その ID (コースのファイルの名前) を候補にする
  const presetId = CIRCUIT_PRESETS.find(p => p.name === currentCircuitName.replace(USER_SUFFIX, ''))?.id;
  const [folder, setFolder] = useState(() => initialSaved?.folder ?? (presetId || guessEnglishName(currentCircuitName.replace(USER_SUFFIX, '')) ? courseFolder(currentCircuitName.replace(USER_SUFFIX, ''), undefined, presetId) : ''));
  // フォルダ名を手で直したか (直していなければ、英語名に合わせて作り直す)
  const [folderEdited, setFolderEdited] = useState(() => !!initialSaved?.folder);
  const nameEnError = nameEn.trim() ? checkEnglishName(nameEn) : null;
  const folderError = folder ? checkFolderName(folder) : null;
  const msg = (e: { ja: string; en: string }) => (getLang() === 'en' ? e.en : e.ja);
  const [remember, setRemember] = useState(true);
  // 計測線がないときに .sci を読み込んだか (保存・書き出しのときに、計測線までのフィニッシュを足す)
  const [needsFinish, setNeedsFinish] = useState(false);
  const [fileMessage, setFileMessage] = useState('');
  // 書き出しの保存ダイアログを待っている間 (ボタンを続けて押しても、二重に書き出さない)
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false); // 同じ瞬間の 2 回のクリックは state では止められないので、ref でも止める
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Esc キーで閉じる (キャンセルと同じ)。書き出しの保存ダイアログを待っているあいだは閉じない
  useEscapeKey(isOpen && !exporting, onClose);
  // コース編集で保存したコース (呼び出し・削除用)
  const [savedCircuits, setSavedCircuits] = useState<UserCircuitItem[]>(() => [...userCircuitStorage.getEditedCircuits()]);
  useEffect(() => {
    userCircuitStorage.ready.then(() => setSavedCircuits([...userCircuitStorage.getEditedCircuits()]));
  }, []);

  const handleLoadSaved = (c: UserCircuitItem) => {
    setName(c.name);
    setNameEn(c.nameEn ?? guessEnglishName(c.name));
    // 内蔵のコースから作ったコースなら、その ID (コースのファイルの名前) を候補にする
    const savedPresetId = CIRCUIT_PRESETS.find(p => p.name === c.name)?.id;
    setFolder(c.folder ?? (savedPresetId || guessEnglishName(c.name) ? courseFolder(c.name, undefined, savedPresetId) : ''));
    setFolderEdited(!!c.folder);
    setClLatA(String(c.controlLine.latA));
    setClLonA(String(c.controlLine.lonA));
    setClLatB(String(c.controlLine.latB));
    setClLonB(String(c.controlLine.lonB));
    setSectors(c.sectors);
    setNeedsFinish(false);
    setFileMessage(tr(`「${c.name}」を呼び出しました`, `Loaded "${c.name}"`));
  };

  const handleDeleteSaved = async (c: UserCircuitItem) => {
    if (!confirm(tr(`保存したコース「${c.name}」を削除しますか？ (読み込み済みのログの設定はそのままです)`, `Delete the saved course "${c.name}"? (Settings of logs already loaded are kept.)`))) return;
    const r = await userCircuitStorage.deleteEditedCircuit(c.name);
    setSavedCircuits([...userCircuitStorage.getEditedCircuits()]);
    onSavedCircuitsChange?.();
    if (!r.saved) setSaveError(`${tr('削除を保存できませんでした', 'Could not save the deletion')}: ${r.saveError ?? ''}`);
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
  // ゴールの線 (スタートとゴールが別のコース。ジムカーナ・ヒルクライムなど)
  const [separateFinish, setSeparateFinish] = useState(!!finishLine);
  const [fin, setFin] = useState(() => finishLine
    ? [finishLine.latA, finishLine.lonA, finishLine.latB, finishLine.lonB].map(String)
    : ['', '', '', '']);
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
    if (sciCount > 1) errors.push(tr('.sci を複数選んだので、最後のものだけを使いました', 'Several .sci files were selected; only the last one was used'));
    if (list.filter(f => /\.cln$/i.test(f.name)).length > 1) errors.push(tr('.cln を複数選んだので、最後のものだけを使いました', 'Several .cln files were selected; only the last one was used'));
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
          if (!cl) errors.push(tr('計測線を入れると、保存するときに最後の区間 (計測線まで) を足します', 'Once a timing line is entered, the last section (up to the timing line) is added when you save'));
        } else {
          errors.push(`${f.name}: ${tr('.cln か .sci を選んでください', 'choose a .cln or .sci file')}`);
        }
      } catch (e) {
        errors.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setFileMessage([done.length ? `${tr('読み込みました', 'Loaded')}: ${done.join(', ')}` : '', ...errors].filter(Boolean).join(' / '));
  };

  // 計測線を .cln、セクターを .sci に書き出す (公式アプリと同じ形)
  const handleExportFiles = async () => {
    if (exportingRef.current) return;
    const cl = readControlLine();
    if (!cl) {
      setSaveError(tr('計測線の 2 点の緯度・経度を正しく入力してください', 'Enter valid latitude and longitude for both points of the timing line'));
      return;
    }
    const finished = withFinish(sectors, cl);
    const badSector = findBadSector(finished);
    if (badSector) {
      setSaveError(tr(`セクター「${badSector.name}」の 2 点の緯度・経度を正しく入力してください`, `Enter valid latitude and longitude for both points of sector "${badSector.name}"`));
      return;
    }
    setSaveError('');
    // ファイル名に使えない文字と、末尾の点・空白 (Windows で使えない) を置き換える
    const base = (name.trim() || nameEn.trim() || 'course').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').replace(/^cl_/i, '') || 'course';
    const sci = exportSci(finished, cl);
    // 1 つずつ保存する (.cln をキャンセルしても .sci は保存できるように、続けて聞く)
    const files: [string, string][] = [[`cl_${base}.cln`, exportCln(cl)], ...(sci ? [[`${base}.sci`, sci] as [string, string]] : [])];
    const saved: string[] = [];
    let failed = false;
    exportingRef.current = true;
    setExporting(true);
    try {
      for (const [fileName, text] of files) if (await saveText(text, fileName)) saved.push(fileName);
    } catch (e) {
      failed = true;
      setSaveError(`${tr('書き出せませんでした', 'Could not export')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
    if (saved.length) {
      setFileMessage(`${tr('書き出しました', 'Exported')}: ${saved.join(', ')}${sci ? '' : ` ${tr('(セクターがないので .sci は書き出していません)', '(no sectors, so no .sci was written)')}`}`);
    } else {
      setFileMessage(failed ? '' : tr('書き出しをキャンセルしました', 'Export cancelled'));
    }
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
      setSaveError(tr('計測線の 2 点の緯度・経度を正しく入力してください', 'Enter valid latitude and longitude for both points of the timing line'));
      return;
    }
    const newControlLine: ControlLine = { name: 'Start/Finish Line', latA, lonA, latB, lonB };
    // ゴールの線 (別にするとき)。スタートの線と同じ所は使えない
    let newFinish: ControlLine | undefined;
    if (separateFinish) {
      const f = fin.map(v => parseFloat(v));
      if (f.some(v => !Number.isFinite(v)) || Math.abs(f[0]) > 90 || Math.abs(f[2]) > 90 || Math.abs(f[1]) > 180 || Math.abs(f[3]) > 180 || (f[0] === f[2] && f[1] === f[3])) {
        setSaveError(tr('ゴールの線の 2 点の緯度・経度を正しく入力してください', 'Enter valid latitude and longitude for both points of the finish line'));
        return;
      }
      if (f[0] === latA && f[1] === lonA && f[2] === latB && f[3] === lonB) {
        setSaveError(tr('ゴールの線がスタートの線と同じです。同じなら「スタートとゴールが別」を外してください', 'The finish line is the same as the start line. If they are the same, turn off "separate start and finish"'));
        return;
      }
      newFinish = { name: 'Finish Line', latA: f[0], lonA: f[1], latB: f[2], lonB: f[3] };
    }
    const badSector = findBadSector(withFinish(sectors, newControlLine));
    if (badSector) {
      setSaveError(tr(`セクター「${badSector.name}」の 2 点の緯度・経度を正しく入力してください`, `Enter valid latitude and longitude for both points of sector "${badSector.name}"`));
      return;
    }
    // 英語名とフォルダ名 (ラップタイマーの記録のフォルダに使う) は、半角の英字などだけ
    const enProblem = checkEnglishName(nameEn);
    if (enProblem) { setSaveError(msg(enProblem)); return; }
    const folderProblem = checkFolderName(folder);
    if (folderProblem) { setSaveError(msg(folderProblem)); return; }
    // 日本語の名前は任意 (無ければ英語名を名前にする)
    const saveName = name.trim() || nameEn.trim() || tr('カスタムコース', 'Custom course');
    // 同じ名前で別の場所のコースを保存していたら、上書きしてよいか聞く (名前を付けずに別のコースで保存したときなど)
    if (remember && userCircuitStorage.isEditedNameUsedElsewhere(saveName, newControlLine) &&
        !confirm(tr(`「${saveName}」という名前で、別の場所のコースを保存しています。上書きしますか？ (残すときは、キャンセルしてコース名を変えてください)`, `A course at a different place is already saved as "${saveName}". Overwrite it? (To keep it, cancel and change the course name.)`))) {
      return;
    }

    // スタートとゴールが別のときは、最後のセクターをゴールの線までにする (周を数えるところでゴールの線を最後に置く)
    onSaveCircuit(saveName, newControlLine, newFinish ? sectors.filter(sec => !sec.id.endsWith('_finish')) : withFinish(sectors, newControlLine), remember, { nameEn: nameEn.trim(), folder, finishLine: newFinish });
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
            {t('コース・計測ライン（コントロールライン）編集', 'Edit course and timing line')}
          </h3>
          <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-fg">
            <X size={18} />
          </button>
        </div>

        {/* モーダルコンテンツ */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs text-slate-200">
          {/* コース名 (日本語・任意) / 英語名 / 保存フォルダ名 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block font-bold text-slate-300 mb-1">{t('コース名（日本語・任意）', 'Course name (Japanese, optional)')}</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('空なら英語名を使います', 'Uses the English name if empty')}
                className="w-full bg-surface-0 border border-line-3 rounded-lg p-2 text-slate-100 focus:border-red-500 outline-none"
              />
            </div>
            <div>
              <label className="block font-bold text-slate-300 mb-1">{t('英語名', 'English name')}</label>
              <input
                type="text"
                value={nameEn}
                data-testid="course-name-en"
                placeholder={t('例: Sodegaura Forest Raceway', 'e.g. Sodegaura Forest Raceway')}
                onChange={e => {
                  setNameEn(e.target.value);
                  if (!folderEdited) setFolder(toFolderName(e.target.value));
                }}
                className={`w-full bg-surface-0 border rounded-lg p-2 text-slate-100 outline-none ${nameEnError ? 'border-red-500' : 'border-line-3 focus:border-red-500'}`}
              />
            </div>
            <div>
              <label className="block font-bold text-slate-300 mb-1">{t('保存フォルダ名', 'Folder name')}</label>
              <input
                type="text"
                value={folder}
                data-testid="course-folder"
                placeholder={t('例: sodegaura_forest_raceway', 'e.g. sodegaura_forest_raceway')}
                // 大文字は小文字にする (それ以外の使えない文字は、エラーで知らせる)
                onChange={e => { setFolder(e.target.value.replace(/[A-Z]/g, c => c.toLowerCase())); setFolderEdited(true); }}
                className={`w-full bg-surface-0 border rounded-lg p-2 text-slate-100 font-mono outline-none ${folderError ? 'border-red-500' : 'border-line-3 focus:border-red-500'}`}
              />
            </div>
          </div>
          {(nameEnError || folderError) && (
            <p className="text-[11px] text-red-400" data-testid="course-name-error">{msg((nameEnError ?? folderError)!)}</p>
          )}
          <p className="text-[11px] text-slate-500 -mt-3">
            {t('英語名は半角の英字・数字・空白など、保存フォルダ名は半角の英小文字・数字と _ だけです（空白は使えません）。保存フォルダ名は、ラップタイマーの記録を入れるフォルダの名前です（英語名から自動で作ります。直すこともできます）。',
              'The English name uses half-width letters, digits, spaces and a few symbols; the folder name uses lowercase half-width letters, digits and _ only (no spaces). The folder name is where lap timer runs for this course are kept (made from the English name; you can change it).')}
          </p>

          {/* ファイルの読み込み・書き出し (公式アプリと同じ .cln / .sci) */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-4 hover:bg-surface-5 text-slate-200 border border-line-4 text-[11px]"
              title={t('計測線 (.cln) とセクター (.sci) を読み込みます。両方まとめて選べます', 'Loads a timing line (.cln) and sectors (.sci). You can select both at once')}
            >
              <Upload size={13} />
              {t('.cln / .sci を読み込む', 'Load .cln / .sci')}
            </button>
            <button
              onClick={handleExportFiles}
              disabled={exporting}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-4 hover:bg-surface-5 text-slate-200 border border-line-4 text-[11px] disabled:opacity-60"
              title={t('計測線を .cln、セクターを .sci に書き出します (公式アプリと同じ形)', 'Exports the timing line as .cln and the sectors as .sci (same format as the official app)')}
            >
              <Download size={13} />
              {t('.cln / .sci に書き出す', 'Export .cln / .sci')}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={fileAccept('.cln,.sci')}
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
              <div className="font-bold text-slate-300">{t('保存したコース', 'Saved courses')}</div>
              {savedCircuits.map(c => (
                <div key={c.id} className="flex items-center gap-2 text-[11px]">
                  <span className="flex-1 truncate text-slate-200">{c.name}</span>
                  <span className="text-slate-500">{t('セクター', 'Sectors')} {c.sectors.length}</span>
                  <button
                    onClick={() => handleLoadSaved(c)}
                    className="px-2 py-0.5 rounded bg-surface-4 hover:bg-surface-5 border border-line-4 text-slate-200"
                  >
                    {t('呼び出す', 'Load')}
                  </button>
                  <button
                    onClick={() => handleDeleteSaved(c)}
                    className="p-1 text-slate-500 hover:text-red-400"
                    title={t('削除', 'Delete')}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* コントロールライン (スタート/フィニッシュ) */}
          <div className="bg-surface-1 border border-line-2 rounded-lg p-4 space-y-3">
            <div className="font-bold text-amber-400">{t('コントロールライン (スタート/フィニッシュ計測線)', 'Timing line (start/finish)')}</div>
            <p className="text-[11px] text-slate-400">
              {t('コースのスタート/フィニッシュラインを通過する線分（点Aと点Bの座標）を指定します。', 'Enter the segment (coordinates of points A and B) across the start/finish line of the course.')}
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-400 text-[11px] mb-1">{t('点A 緯度 (Lat A)', 'Point A latitude')}</label>
                <input
                  type="number"
                  step="0.000001"
                  value={clLatA}
                  onChange={e => setClLatA(e.target.value)}
                  className="w-full bg-surface-2 border border-line-3 rounded p-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 text-[11px] mb-1">{t('点A 経度 (Lon A)', 'Point A longitude')}</label>
                <input
                  type="number"
                  step="0.000001"
                  value={clLonA}
                  onChange={e => setClLonA(e.target.value)}
                  className="w-full bg-surface-2 border border-line-3 rounded p-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 text-[11px] mb-1">{t('点B 緯度 (Lat B)', 'Point B latitude')}</label>
                <input
                  type="number"
                  step="0.000001"
                  value={clLatB}
                  onChange={e => setClLatB(e.target.value)}
                  className="w-full bg-surface-2 border border-line-3 rounded p-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 text-[11px] mb-1">{t('点B 経度 (Lon B)', 'Point B longitude')}</label>
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

          {/* ゴールの線 (スタートとゴールが別のコース) */}
          <div className="bg-surface-1 border border-line-2 rounded-lg p-4 space-y-3">
            <label className="flex items-center gap-2 font-bold text-sky-400 cursor-pointer">
              <input type="checkbox" checked={separateFinish} onChange={e => setSeparateFinish(e.target.checked)} data-testid="course-separate-finish" />
              {t('スタートとゴールが別 (ジムカーナ・ヒルクライムなど)', 'Separate start and finish (gymkhana, hill climb, etc.)')}
            </label>
            {separateFinish && (
              <>
                <p className="text-[11px] text-slate-400">
                  {t('上の線をスタート、ここの線をゴールにして、スタートからゴールまでを 1 本として数えます。セクターは、その間に置いてください (最後のセクターはゴールまで)。',
                    'The line above is the start and this one is the finish; each run from start to finish is counted as one. Put sectors in between (the last sector ends at the finish).')}
                </p>
                <div className="grid grid-cols-2 gap-3">
                  {([[0, t('点A 緯度 (Lat A)', 'Point A latitude')], [1, t('点A 経度 (Lon A)', 'Point A longitude')], [2, t('点B 緯度 (Lat B)', 'Point B latitude')], [3, t('点B 経度 (Lon B)', 'Point B longitude')]] as const).map(([i, label]) => (
                    <div key={i}>
                      <label className="block text-slate-400 text-[11px] mb-1">{label}</label>
                      <input
                        type="number"
                        step="0.000001"
                        value={fin[i]}
                        data-testid={`course-finish-${i}`}
                        onChange={e => setFin(v => v.map((x, k) => (k === i ? e.target.value : x)))}
                        className="w-full bg-surface-2 border border-line-3 rounded p-1.5 font-mono"
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* セクターゲート */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-300">{t('セクターゲート設定', 'Sector gates')}</span>
              <button
                onClick={handleAddSector}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-4 hover:bg-surface-5 text-slate-200 border border-line-4 text-[11px]"
              >
                <Plus size={13} />
                {t('セクター追加', 'Add sector')}
              </button>
            </div>

            {sectors.length === 0 ? (
              <p className="text-slate-500 text-[11px] italic">{t('セクターが設定されていません', 'No sectors set')}</p>
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
                    <p className="text-[10px] text-slate-500">{t('フィニッシュ (計測線まで)。位置は計測線と同じになります', 'Finish (up to the timing line). Its position follows the timing line')}</p>
                  )}
                  {/* 4 つの欄の名前 (欄に値が入っていると placeholder は見えず、どれが何か分からなかった) */}
                  <div className="grid grid-cols-4 gap-2 text-[10px] leading-tight text-slate-500" aria-hidden="true">
                    <span>{t('点A 緯度', 'Lat A')}</span>
                    <span>{t('点A 経度', 'Lon A')}</span>
                    <span>{t('点B 緯度', 'Lat B')}</span>
                    <span>{t('点B 経度', 'Lon B')}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-[10px] font-mono">
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.latA}
                      onChange={e => handleUpdateSector(idx, 'latA', parseFloat(e.target.value) || 0)}
                      placeholder="Lat A"
                      aria-label={`${sec.name || `S${idx + 1}`} ${t('点A 緯度', 'Lat A')}`}
                      disabled={sec.id.endsWith('_finish')}
                      className="bg-surface-2 border border-line-3 rounded p-1 disabled:opacity-60"
                    />
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.lonA}
                      onChange={e => handleUpdateSector(idx, 'lonA', parseFloat(e.target.value) || 0)}
                      placeholder="Lon A"
                      aria-label={`${sec.name || `S${idx + 1}`} ${t('点A 経度', 'Lon A')}`}
                      disabled={sec.id.endsWith('_finish')}
                      className="bg-surface-2 border border-line-3 rounded p-1 disabled:opacity-60"
                    />
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.latB}
                      onChange={e => handleUpdateSector(idx, 'latB', parseFloat(e.target.value) || 0)}
                      placeholder="Lat B"
                      aria-label={`${sec.name || `S${idx + 1}`} ${t('点B 緯度', 'Lat B')}`}
                      disabled={sec.id.endsWith('_finish')}
                      className="bg-surface-2 border border-line-3 rounded p-1 disabled:opacity-60"
                    />
                    <input
                      type="number"
                      step="0.000001"
                      value={sec.lonB}
                      onChange={e => handleUpdateSector(idx, 'lonB', parseFloat(e.target.value) || 0)}
                      placeholder="Lon B"
                      aria-label={`${sec.name || `S${idx + 1}`} ${t('点B 経度', 'Lon B')}`}
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
        <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-line-2 bg-surface-1">
          <label className="mr-auto flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer" title={t('アプリに保存し、次からこの計測線を通るログに使います (データ管理の「ユーザーコース」に入ります)', 'Saves the course in the app and uses it for later logs that cross this timing line (added to your courses on the data tab)')}>
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            {t('アプリに保存して、次からも使う', 'Save in the app and use it next time')}
          </label>
          {saveError && <span className="text-xs text-amber-400">{saveError}</span>}
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-line-3 text-xs text-slate-300 hover:bg-surface-4 whitespace-nowrap"
          >
            {t('キャンセル', 'Cancel')}
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-xs text-white font-bold transition-all shadow whitespace-nowrap"
          >
            <Check size={14} />
            {t('保存して適用', 'Save and apply')}
          </button>
        </div>
      </div>
    </div>
  );
};
