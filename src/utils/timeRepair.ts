/**
 * GPS の時刻の飛びを直す (BUG-41)。デジスパイスの GPS は、まれに 1 点だけ時刻を 1 秒先にして出す
 * (01.99 のはずが 02.99。秒だけ先に繰り上がる)。次の点で元の流れに戻るので、その 1 点を 1 秒戻す。
 * times は記録の順の時刻 (秒)。直した点の番号を返し、times を書き換える
 */
export function fixLoneSecondJumps(times: number[]): number[] {
  const fixed: number[] = [];
  for (let i = 1; i + 1 < times.length; i++) {
    const before = times[i] - times[i - 1];
    const after = times[i + 1] - times[i];
    const back = times[i] - 1;
    // 1 秒ほど先へ飛び、次の点で戻り、1 秒戻すと前後の間に入る
    if (before >= 0.95 && before <= 1.5 && after < 0 && back > times[i - 1] && back < times[i + 1]) {
      times[i] = back;
      fixed.push(i);
    }
  }
  return fixed;
}

/** 飛んだ 1 点か (直前の点から 1 秒ほど先で、次の点がその 1 秒前と前の点の間)。1 点ずつ読む所で使う */
export function isLoneSecondJump(prevPrev: number, prev: number, cur: number): boolean {
  const back = prev - 1;
  return prev - prevPrev >= 0.95 && prev - prevPrev <= 1.5 && cur < prev && back > prevPrev && back < cur;
}
