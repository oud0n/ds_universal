/**
 * コースの英語名と、ラップタイマーの記録を入れるフォルダの名前 (2026-10-20)。
 * フォルダの名前は、どの端末・クラウドでも困らないよう、コースのファイル (courses/) の名前と同じ決まり
 * (英小文字・数字と _ だけ。空白は使わない) にする。入っているコースは、コースのファイルと同じ ID (sodegaura など) をそのまま使う。
 * 表示の名前 (日本語名・英語名) は、空白を使ってよい
 */
import { circuitTableName } from './i18n';

/** コースの分からない走行のフォルダ */
export const UNSORTED_FOLDER = 'unsorted';
/** 英語名・フォルダ名の長さの上限 */
export const COURSE_NAME_MAX = 60;

/** 英語名に使える文字: 半角の英字・数字・空白と - . ' & ( ) , */
const ENGLISH_CHAR = /[A-Za-z0-9 \-.'&(),]/;
/** フォルダ名: 英小文字・数字と _。先頭は英小文字か数字 (コースのファイルの ID と同じ決まり) */
const FOLDER_RE = new RegExp(`^[a-z0-9][a-z0-9_]{0,${COURSE_NAME_MAX - 1}}$`);
/** アクセントの記号 (é の ´ など。NFD で分けたあとに外す) */
const COMBINING_MARKS = /[̀-ͯ]/g;

/** 英小文字・数字と _ だけにする (アクセントは外し、大文字は小文字に)。空白などは _ にまとめる */
export function toFolderName(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_')
    .replace(/^_+/, '').slice(0, COURSE_NAME_MAX).replace(/_+$/, '');
}

/** 自動で選んだ、自分で作ったコースの名前の終わりに付く印 (英語表示では (user))。名前を作るときは外す */
const USER_MARK = /\s*\((ユーザー設置|user)\)\s*$/;
const withoutUserMark = (name: string) => name.trim().replace(USER_MARK, '').trim();

/** 英字の名前として使えるか (日本語などが混じっていないか。アクセントの付いた字はよい) */
const isLatin = (s: string) => /[A-Za-z]/.test(s) && !/[^ -ɏ]/.test(s);

/**
 * コースの名前から、英語名の候補を作る: 内蔵のサーキットの表の英語名 → 名前の終わりのかっこの中の英字
 * (「袖ヶ浦フォレストレースウェイ (Sodegaura)」の Sodegaura) → 名前の英字の部分 の順。無ければ ''
 */
export function guessEnglishName(name: string): string {
  const n = withoutUserMark(name);
  if (!n) return '';
  const paren = /\(([^()]+)\)\s*$/.exec(n)?.[1] ?? '';
  const before = n.replace(/\s*\([^()]*\)\s*$/, '');
  for (const c of [circuitTableName(n), paren, n, before]) {
    if (isLatin(c)) {
      // アクセントを外し、使えない字を空白にする (英語名として、そのまま確かめに通る形)
      const cleaned = c.normalize('NFD').replace(COMBINING_MARKS, '')
        .split('').map(ch => (ENGLISH_CHAR.test(ch) ? ch : ' ')).join('').replace(/\s+/g, ' ').trim().slice(0, COURSE_NAME_MAX).trim();
      if (/[A-Za-z0-9]/.test(cleaned)) return cleaned;
    }
  }
  return '';
}

/**
 * 記録を入れるフォルダの名前。決めてあればそれ (コース編集で付けた名前)、入っているコースならその ID (courses/ のファイルの名前)、
 * なければコースの名前から作る (英語名の候補 → それも無ければ course_ と名前から求めた記号。同じ名前なら同じフォルダ)
 */
export function courseFolder(name: string, folder?: string, id?: string): string {
  if (folder && FOLDER_RE.test(folder)) return folder;
  if (id && FOLDER_RE.test(id)) return id;
  const n = withoutUserMark(name);
  if (!n) return UNSORTED_FOLDER;
  const a = toFolderName(guessEnglishName(n));
  if (a) return a;
  let h = 0;
  for (const ch of n) h = (Math.imul(h, 31) + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `course_${h.toString(36)}`;
}

/**
 * 2 つのコースの名前が、同じコースを指すか。名前が少し違っても (自分で直したコースの「(ユーザー設置)」など)、
 * 記録のフォルダの名前が同じなら同じコースとみなす (Car 2 として足せるか・比べられるかの判定。BUG-33)
 */
export function sameCourseName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = withoutUserMark(a), y = withoutUserMark(b);
  if (x === y) return true;
  return courseFolder(x) === courseFolder(y);
}

/** 英語名を確かめる。問題なければ null、あれば理由 (日本語・英語) */
export function checkEnglishName(s: string): { ja: string; en: string } | null {
  const v = s.trim();
  if (!v) return { ja: '英語名を入れてください', en: 'Enter an English name' };
  const bad = [...new Set([...v].filter(ch => !ENGLISH_CHAR.test(ch)))];
  if (bad.length) {
    const list = bad.slice(0, 5).join(' ');
    return {
      ja: `英語名に使えない文字があります: ${list} (半角の英字・数字・空白と - . ' & ( ) , だけ使えます)`,
      en: `The English name has characters that cannot be used: ${list} (use half-width letters, digits, spaces and - . ' & ( ) , only)`
    };
  }
  if (!/[A-Za-z0-9]/.test(v)) return { ja: '英語名に英字か数字を入れてください', en: 'The English name needs a letter or a digit' };
  if (v.length > COURSE_NAME_MAX) return { ja: `英語名は ${COURSE_NAME_MAX} 文字までです`, en: `The English name can be up to ${COURSE_NAME_MAX} characters` };
  return null;
}

/** 保存フォルダ名を確かめる。問題なければ null、あれば理由 (日本語・英語) */
export function checkFolderName(s: string): { ja: string; en: string } | null {
  if (!s) return { ja: '保存フォルダ名を入れてください', en: 'Enter a folder name' };
  if (FOLDER_RE.test(s)) return null;
  const bad = [...new Set([...s].filter(ch => !/[a-z0-9_]/.test(ch)))];
  if (bad.length) {
    const list = bad.slice(0, 5).map(ch => (ch === ' ' ? '(空白)' : ch)).join(' ');
    const listEn = bad.slice(0, 5).map(ch => (ch === ' ' ? '(space)' : ch)).join(' ');
    return {
      ja: `保存フォルダ名に使えない文字があります: ${list} (半角の英小文字・数字と _ だけ使えます)`,
      en: `The folder name has characters that cannot be used: ${listEn} (use lowercase half-width letters, digits and _ only)`
    };
  }
  if (s.length > COURSE_NAME_MAX) return { ja: `保存フォルダ名は ${COURSE_NAME_MAX} 文字までです`, en: `The folder name can be up to ${COURSE_NAME_MAX} characters` };
  return { ja: '保存フォルダ名の先頭は、英小文字か数字にしてください', en: 'Start the folder name with a lowercase letter or a digit' };
}
