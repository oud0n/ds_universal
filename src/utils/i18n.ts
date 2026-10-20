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

/** 保存した言語 (端末と違う言語を選んだときだけ)。端末と同じものが残っていたら (前の版で保存したもの)、自動に戻す */
function savedLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v !== 'ja' && v !== 'en') return null;
    if (v === deviceLang()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return v;
  } catch {
    // 保存先が使えない (プライベートウインドウなど) ときは端末の言語に合わせる
    return null;
  }
}

let lang: Lang = savedLang() ?? deviceLang();
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
    if (savedLang() !== null) return;
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
  return savedLang() === null;
}

export function setLang(l: Lang) {
  lang = l;
  try {
    // 端末と同じ言語を選んだら、保存を消して自動に戻す (端末の言語を変えたら、それに合わせる)
    if (l === deviceLang()) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // 保存できなくても、この画面では切り替える
  }
  apply();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

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
