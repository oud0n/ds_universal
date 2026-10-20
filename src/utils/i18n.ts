import { useSyncExternalStore } from 'react';

// 画面の言語。日本語と英語の文言は、使う場所に t('日本語', 'English') のように並べて書く
// (キーの一覧を別に持たないので、日本語を直すときに英語の書き忘れに気づける)
export type Lang = 'ja' | 'en';

// 言語は、ふだんは端末 (PC・スマホ) の言語に合わせる (日本語なら日本語、ほかは英語)。
// 画面のボタンで端末と違う言語を選んだときだけ、それをこの端末のブラウザに保存する (端末と同じ言語を選ぶと、自動に戻す)
const STORAGE_KEY = 'ds_lang';

/** 端末の言語 (日本語でなければ英語) */
function deviceLang(): Lang {
  const nav = typeof navigator !== 'undefined' ? navigator.languages?.[0] || navigator.language || '' : '';
  return /^ja\b/i.test(nav) || nav === '' ? 'ja' : 'en';
}

/** 前の版で保存した言語を、この版で一度だけ見直した印 */
const MIGRATED_KEY = 'ds_lang_auto_v1';

/**
 * 画面のボタンで選んだ言語 (端末と違う言語を選んだときだけ)。保存できない環境 (プライベートウインドウ) でも、
 * このページを開いている間はここで覚える
 */
let override: Lang | null = loadOverride();

function loadOverride(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    const saved = v === 'ja' || v === 'en' ? v : null;
    // 前の版は、ボタンを押すと端末と同じ言語でも保存していた。この版で初めて開いたときだけ、端末と同じものは自動に戻す
    // (そのあとは消さない。端末の言語を変えても、ボタンで選んだ言語は残る)
    if (!localStorage.getItem(MIGRATED_KEY)) {
      localStorage.setItem(MIGRATED_KEY, '1');
      if (saved && saved === deviceLang()) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
    }
    return saved;
  } catch {
    // 保存先が使えない (プライベートウインドウなど) ときは端末の言語に合わせる
    return null;
  }
}

let lang: Lang = override ?? deviceLang();
const listeners = new Set<() => void>();

function apply() {
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  // デスクトップ版はメニューも同じ言語にする
  if (typeof window !== 'undefined') (window as any).electronAPI?.setLanguage?.(lang);
  listeners.forEach(l => l());
}
apply();

// 端末の言語を変えたら、自動のときはすぐ合わせる
if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => {
    if (override !== null) return;
    const next = deviceLang();
    if (next !== lang) {
      lang = next;
      apply();
    }
  });
}

export function getLang(): Lang {
  return lang;
}

/** 端末の言語に合わせているか (画面のボタンで端末と違う言語を選んでいなければ true) */
export function isLangAuto(): boolean {
  return override === null;
}

/** 言語の設定: 'auto' は端末の言語に合わせる */
export type LangSetting = 'auto' | Lang;

export function getLangSetting(): LangSetting {
  return override ?? 'auto';
}

/** 設定を変える ('auto' なら端末の言語に合わせる) */
export function setLangSetting(v: LangSetting) {
  if (v === 'auto') {
    override = null;
    lang = deviceLang();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 保存できなくても、このページを開いている間は覚えている
    }
    apply();
    return;
  }
  setLang(v);
}

export function setLang(l: Lang) {
  lang = l;
  // 端末と同じ言語を選んだら自動に戻す (端末の言語を変えたら、それに合わせる)。違う言語なら、その言語に決める
  override = l === deviceLang() ? null : l;
  try {
    if (override === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, override);
  } catch {
    // 保存できなくても、このページを開いている間は覚えている
  }
  apply();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** 言語の設定 (自動・日本語・English。切り替えると描き直す) */
export function useLangSetting(): LangSetting {
  return useSyncExternalStore(subscribe, getLangSetting, getLangSetting);
}

/** 今の言語 (切り替えると描き直す) */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

/** React の外 (エラーの文言・書き出す文字など) で使う。呼んだ時点の言語の文言を返す */
export function tr(ja: string, en: string): string {
  return lang === 'en' ? en : ja;
}

/** 画面で使う。言語を切り替えると、この関数を使う部品は描き直される */
export function useT(): (ja: string, en: string) => string {
  const l = useLang();
  return (ja, en) => (l === 'en' ? en : ja);
}

// 内蔵のサーキットの英語名 (データとして持つ名前は日本語のまま。画面に出すときだけ切り替える)
const CIRCUIT_EN: Record<string, string> = {
  '富士スピードウェイ (FSW)': 'Fuji Speedway (FSW)',
  '鈴鹿サーキット (Suzuka Circuit)': 'Suzuka Circuit',
  '筑波サーキット コース2000 (TC2000)': 'Tsukuba Circuit TC2000',
  '筑波サーキット コース1000 (TC1000)': 'Tsukuba Circuit TC1000',
  '日光サーキット (Nikko Circuit)': 'Nikko Circuit',
  'モビリティリゾートもてぎ (Motegi Road Course)': 'Mobility Resort Motegi (Road Course)',
  'スポーツランドSUGO (Sportsland SUGO)': 'Sportsland SUGO',
  'オートポリス (Autopolis)': 'Autopolis',
  '岡山国際サーキット (Okayama International)': 'Okayama International Circuit',
  '袖ヶ浦フォレストレースウェイ (Sodegaura)': 'Sodegaura Forest Raceway',
  '本庄サーキット (Honjo Circuit)': 'Honjo Circuit',
  'エビスサーキット 東コース (Ebisu East)': 'Ebisu Circuit East Course',
  '名阪スポーツランド (Meihan Sportsland)': 'Meihan Sportsland'
};

/** サーキット名を画面に出す形にする (英語のときは英語名。読み込んだコースの「(ユーザー設置)」も英語にする) */
export function circuitLabel(name: string, l: Lang = lang): string {
  if (l !== 'en' || !name) return name;
  if (CIRCUIT_EN[name]) return CIRCUIT_EN[name];
  return name.replace(/ \(ユーザー設置\)$/, ' (user)');
}
