/**
 * 計算式で作る値 (PLAN-36)。例: speed * 0.621、rpm / gear、(brake > 10) * 100、max(throttle, 0)
 * 使えるもの: 数・値の名前 (speed・rpm などの決まった値、自分で名前を付けた値の名前)・+ - * / ( )・
 * 比べる (> < >= <= == !=。合えば 1、合わなければ 0)・min max abs sqrt round
 * 式は点ごとにその場で計算する (点には書かない)
 */
import type { TelemetryPoint } from '../types/telemetry';

export interface CalcChannel {
  key: string;
  label: string;
  unit?: string;
  min?: number;
  max?: number;
  expr: string;
}

type Node =
  | { k: 'n'; v: number }
  | { k: 'var'; name: string }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'fn'; name: string; args: Node[] };

const FUNCS: Record<string, (...x: number[]) => number> = {
  min: (...x) => Math.min(...x),
  max: (...x) => Math.max(...x),
  abs: x => Math.abs(x),
  sqrt: x => Math.sqrt(x),
  round: x => Math.round(x)
};

/** 式を読む。読めなければ理由を投げる */
export function parseExpr(src: string): Node {
  // 長すぎる式・入れ子の深すぎる式は読まない (深い入れ子で読み手が溢れて、画面ごと止まるため)
  if (src.length > 200) throw new Error('式が長すぎます (200 文字まで)');
  let depth = 0;
  const toks = src.match(/\d+(?:\.\d+)?(?:e[-+]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|>=|<=|==|!=|[-+*/(),<>]|\S/gi) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const eat = (t?: string) => {
    const x = toks[i];
    if (t !== undefined && x !== t) throw new Error(`「${t}」が要ります`);
    i++;
    return x;
  };
  const primary = (): Node => {
    if (++depth > 40) throw new Error('式の入れ子が深すぎます');
    try { return primaryInner(); } finally { depth--; }
  };
  const primaryInner = (): Node => {
    const t = peek();
    if (t === undefined) throw new Error('式が途中で終わっています');
    if (t === '(') { eat('('); const e = compare(); eat(')'); return e; }
    if (t === '-') { eat(); return { k: 'neg', a: primary() }; }
    if (t === '+') { eat(); return primary(); }
    if (/^\d/.test(t)) { eat(); return { k: 'n', v: Number(t) }; }
    if (/^[A-Za-z_]/.test(t)) {
      eat();
      if (peek() === '(') {
        const name = t.toLowerCase();
        if (!FUNCS[name]) throw new Error(`知らない関数です: ${t}`);
        eat('(');
        const args: Node[] = [compare()];
        while (peek() === ',') { eat(','); args.push(compare()); }
        eat(')');
        return { k: 'fn', name, args };
      }
      return { k: 'var', name: t };
    }
    throw new Error(`読めない文字です: ${t}`);
  };
  const term = (): Node => {
    let a = primary();
    while (peek() === '*' || peek() === '/') { const op = eat()!; a = { k: 'bin', op, a, b: primary() }; }
    return a;
  };
  const sum = (): Node => {
    let a = term();
    while (peek() === '+' || peek() === '-') { const op = eat()!; a = { k: 'bin', op, a, b: term() }; }
    return a;
  };
  const compare = (): Node => {
    let a = sum();
    while (['>', '<', '>=', '<=', '==', '!='].includes(peek() ?? '')) { const op = eat()!; a = { k: 'bin', op, a, b: sum() }; }
    return a;
  };
  if (!toks.length) throw new Error('式が空です');
  const e = compare();
  if (i < toks.length) throw new Error(`読めない文字です: ${toks[i]}`);
  return e;
}

/** 式に出てくる値の名前 */
export function exprVars(n: Node): string[] {
  if (n.k === 'var') return [n.name];
  if (n.k === 'neg') return exprVars(n.a);
  if (n.k === 'bin') return [...exprVars(n.a), ...exprVars(n.b)];
  if (n.k === 'fn') return n.args.flatMap(exprVars);
  return [];
}

/** 点から値を読む (決まった値の名前、無ければ自分で名前を付けた値) */
function pointVar(p: TelemetryPoint, name: string): number | undefined {
  const v = (p as unknown as Record<string, unknown>)[name];
  if (typeof v === 'number' && name !== 'index') return v;
  return p.custom?.[name];
}

/** 式を、点から値を出す関数にする。値が無いときは undefined */
export function compileExpr(src: string): (p: TelemetryPoint) => number | undefined {
  const tree = parseExpr(src);
  const ev = (n: Node, p: TelemetryPoint): number => {
    switch (n.k) {
      case 'n': return n.v;
      case 'var': { const v = pointVar(p, n.name); return v === undefined ? NaN : v; }
      case 'neg': return -ev(n.a, p);
      case 'fn': return FUNCS[n.name](...n.args.map(a => ev(a, p)));
      case 'bin': {
        const a = ev(n.a, p), b = ev(n.b, p);
        switch (n.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return b === 0 ? NaN : a / b;
          case '>': return a > b ? 1 : 0;
          case '<': return a < b ? 1 : 0;
          case '>=': return a >= b ? 1 : 0;
          case '<=': return a <= b ? 1 : 0;
          case '==': return a === b ? 1 : 0;
          default: return a !== b ? 1 : 0;
        }
      }
    }
  };
  return p => { const v = ev(tree, p); return Number.isFinite(v) ? v : undefined; };
}

/** 計算式のファイル (保管場所の formats/calc.json) を読む */
export function parseCalcFile(text: string | null): CalcChannel[] {
  if (!text) return [];
  try {
    const o = JSON.parse(text) as { version?: unknown; channels?: unknown };
    if (o.version !== 1 || !Array.isArray(o.channels)) return [];
    return o.channels.flatMap((c: Record<string, unknown>) => {
      if (!c || typeof c.key !== 'string' || !/^[a-z0-9][a-z0-9_]{0,39}$/.test(c.key) || typeof c.expr !== 'string') return [];
      try { parseExpr(c.expr); } catch { return []; }
      return [{
        key: c.key, label: typeof c.label === 'string' && c.label ? c.label.slice(0, 30) : c.key, expr: c.expr,
        ...(typeof c.unit === 'string' ? { unit: c.unit.slice(0, 12) } : {}),
        ...(typeof c.min === 'number' && Number.isFinite(c.min) ? { min: c.min } : {}),
        ...(typeof c.max === 'number' && Number.isFinite(c.max) ? { max: c.max } : {})
      }];
    });
  } catch {
    return [];
  }
}
