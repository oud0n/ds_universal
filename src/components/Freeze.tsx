import React from 'react';

/**
 * 見えていないタブを描き直さない。App は再生中に毎コマ描き直すので、隠れているタブ (グラフ・データ管理など) まで毎コマ描くと、
 * スマートフォンでは動画のコマが落ちる。active が false の間は描き直しを飛ばし、true になったときに最新の中身で描く。
 * 見えなくなるときの 1 回は描く (動画を止めるなど、隠れたことを中身に伝えるため)。中身が自分で持つ状態の変化では、今までどおり描き直す
 */
export const Freeze = React.memo(
  function Freeze({ children }: { active: boolean; children: React.ReactNode }) {
    return <>{children}</>;
  },
  (prev, next) => !prev.active && !next.active
);
