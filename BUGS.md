# DS Universal Suite - バグ・不具合情報一覧（BUGS.md）

最終更新: 2026-10-16  
対象ブランチ: `dev`

> 2026-10-16 にコードと照合済み。根拠として書かれた名前のうち `isOutLap` / `isInLap`（BUG-02）、`selectedLaps`（BUG-04）、`<ReferenceLine>`（BUG-01、グラフは Canvas 描画）はコードに存在しない。また BUG-02 の「途中までの周が完走した周を押しのけてベストになる」は起きない（途中までの周は計測線の通過が 1 回のログにしかできず、完走した周と並ばない）。それ以外の指摘の中身はおおむね正しい

本ドキュメントは、2026-10-13 の調査および 2026-10-16 の敵対的コードレビューによって洗い出された既知の不具合・潜在バグの技術詳細をまとめたものです。解析結果の正確性や主要ワークフローへの影響度順（**影響度：高 → 中 → 低**）に優先度を付与しています。

---

## 📊 優先度・影響度サマリー

| 優先度 | ID | 分類 | 概要 | 主な該当ファイル | 状態 |
|---|---|---|---|---|---|
| 🔴 **高 (P1)** | BUG-01 | ラップ・セクター計算 | セクター距離の定義不整合によるグラフ描画・同時スタートの破綻 | `src/services/lapCalculator.ts`, `src/components/SpeedGraphWindow.tsx`, `src/App.tsx` | 修正済み（16f45c4、issue #5） |
| 🔴 **高 (P1)** | BUG-02 | ラップ・セクター計算 | セクター未通過時の等分推計による仮想ベスト汚染・途中終了周のベスト誤判定 | `src/services/lapCalculator.ts` | 未対応 |
| 🔴 **高 (P1)** | BUG-03 | コース・複数セッション | 複数セッション読み込み時のコース設定・計測線・ポリラインの混線 | `src/App.tsx` | 一部修正（遠いログでの流用・複数同時読み込み・名阪は 05b9427 / 3a99299。コース設定がアプリ全体で 1 つの件とプリセット切り替え時のコース図は未対応） |
| 🔴 **高 (P1)** | BUG-04 | 再生・状態管理 | 基準車スロット（Car 1）未割り当て・削除時に再生とシークが完全停止する | `src/App.tsx` | 未対応 |
| 🔴 **高 (P1)** | BUG-05 | 計測線・セクター判定 | ゲート交差判定に進行方向（通過向き）のチェックがない | `src/services/lapCalculator.ts` | 未対応 |
| 🔴 **高 (P1)** | BUG-06 | 車載動画同期・書き出し | 動画画面の競合・手動同期の自動上書き・MP4 メタデータ誤検出・書き出し拡張子不一致など（計9件） | `src/components/VideoSyncWindow.tsx`, `src/services/videoSyncManager.ts`, `src/services/videoMetadataParser.ts`, `src/services/telemetryVideoExporter.ts` | 未対応 |
| 🟡 **中 (P2)** | BUG-07 | 比較解析・距離補正 | `distanceOffsetM` / `alignLapLength` のグラフ・Delta・コーナー診断との不整合 | `src/components/SpeedGraphWindow.tsx`, `src/services/lapCalculator.ts`, `src/services/drivingAnalysis.ts` | 修正済み（05b9427 / 3a99299。Delta の不連続は再現せず） |
| 🟡 **中 (P2)** | BUG-08 | ラップ切り出し | 開始位置の違うログを重ねるとずれる問題の残り（計測線より後ろ開始など） | `src/services/lapCalculator.ts` | 一部実装済・確認待ち |
| 🟡 **中 (P2)** | BUG-09 | 生バイナリ解析・通信 | `.bnx4` 複数セッション連結・重複時刻未除去・ミリ秒補間無効化・メタデータ負座標バグ | `src/services/rawBinaryParser.ts`, `src/services/digspiceDevice.ts` | 未対応 |
| 🟡 **中 (P2)** | BUG-10 | NMEA 入出力 | 出力経路による GGA ダミー値混入・読み込み時の GGA 衛星数欠落・標高 `0 m` 未区別 | `src/services/nmeaParser.ts`, `src/services/nmeaExporter.ts`, `src/services/logConverter.ts` | 未対応 |
| 🟡 **中 (P2)** | BUG-11 | CSV / GPX / VBO 入出力 | 拡張子固定判定・GPX ダイアログ漏れ・CSV 列ずれ/方位欠落・GPX 最終秒切り捨て | `src/App.tsx`, `electron/main.cjs`, `src/services/csvParser.ts`, `src/services/externalFormats.ts` | 一部修正（GPX は a8b630c / 3a99299 で修正。拡張子固定判定・CSV は未対応） |
| 🟡 **中 (P2)** | BUG-12 | 物理計算 | G 値・旋回半径の微分ウィンドウがサンプル数固定（記録レートで値が変わる） | `src/services/physics.ts` | 未対応 |
| 🟡 **中 (P2)** | BUG-13 | 時刻フォーマット | 分・秒フォーマットの丸めによる `"1:60.000"` 繰り上がりバグ | `src/services/csvParser.ts`, `src/components/DataTab.tsx`, `src/services/videoSyncPinManager.ts`, `src/components/VideoSyncWindow.tsx` | 未対応 |
| 🟢 **低 (P3)** | BUG-14 | パフォーマンス | 高密度ログ再生時の毎フレーム全点 Canvas 再描画および $O(N)$ 線形探索 | `src/components/SpeedGraphWindow.tsx`, `src/components/TrackMapWindow.tsx`, `src/components/FrictionCircleWindow.tsx` | 未対応 |
| 🟢 **低 (P3)** | BUG-15 | コースデータ管理 | `.sci` 未使用・同名ファイル混在・保存失敗時の成功表示・隣接コース判定 | `src/services/userCircuitStorage.ts`, `src/services/circuitDatabase.ts` | 未対応 |
| 🟢 **低 (P3)** | BUG-16 | ロガー設定 UI・通信 | 「解析 & 単位設定」が未接続のダミー UI・レート変更副作用の未明示・欠落ブロック再取得 | `src/components/LoggerTab.tsx`, `src/services/digspiceDevice.ts` | 未対応 |

---

## 🔴 影響度：高（P1 — 解析結果の誤り・主要機能の破綻・データ汚染）

### BUG-01: セクター距離の定義不整合によるグラフ描画・セクター同時スタートの破綻

- **該当箇所**:
  - `src/services/lapCalculator.ts` (`L152`: `calculateLapSectors`)
  - `src/components/SpeedGraphWindow.tsx` (`L170`)
  - `src/App.tsx` (`L264-L271`: `handleSyncSectorStart`)
- **現象**:
  1. 車速グラフ（距離軸モード）において、S2 以降のセクター境界を示す縦破線が実際のコース上の位置ではなく、ラップ序盤（各セクターの区間長そのものの位置）に重なって描画される。
  2. リプレイ画面（`ReplayWindow`）でセクターボタン（S1 / S2 / S3...）を押して「セクター同時スタート」を実行すると、S1 を選んだのに S1 開始地点（`0.000 km`）ではなく S1 終了地点にシークし、S2 以降も累積距離ではなく区間長の位置へ誤シークする。
- **原因**:
  - `calculateLapSectors`（`lapCalculator.ts#L152`）は `LapSectorResult.distance` に「前セクターからの区間距離（`splitDist - prevSplitDist`）」を格納している。
  - 一方、`SpeedGraphWindow.tsx#L170` は `secRes.distance` をラップ先頭からの累積距離（X 座標）としてそのまま `<ReferenceLine x={secX} />` に渡している。
  - また `App.tsx#L264-L271` の `handleSyncSectorStart` も `handleSeekDistance(sec.distance)` を呼んでいる。
- **修正方針**:
  - `LapSectorResult` に区間距離 `distance` とは別に累積開始距離 `startDistance` / 終了距離 `endDistance`（または累積距離）を持たせ、グラフの境界線には `endDistance`、セクター同時スタートには `startDistance`（S1 なら `0`、S2 なら S1 の `endDistance`）を使用する。

---

### BUG-02: セクター未通過時の等分推計フォールバックによる「セクターベスト・仮想ベスト」の汚染と途中終了ラップのベストラップ誤判定

- **該当箇所**:
  - `src/services/lapCalculator.ts` (`L116-L123`: `calculateLapSectors`, `L345-L381`: `extractLaps`)
- **現象**:
  1. セクターラインを通過しなかった周（ピットイン周、ショートカット、または計測線 1 回通過で切り出された短い `isPartialLap`）があると、その周のセクタータイムが「周回タイムの等分値」で埋められ、それが **セクターベスト（紫色表示 / `isBest = true`）** として採用されてしまう。
  2. その結果、データ管理タブやラップ一覧に表示される **仮想ベスト（`theoreticalBestTime`）が実在しない異常に速いタイムに汚染**される。
  3. 計測線通過後 15 秒以上で走行を終えた `isPartialLap`（途中終了ラップ）が通常の完走ラップより短いタイムを持つため、常にその途中終了ラップにベストラップの王冠アイコン（`isBest = true`）が付く。
- **原因**:
  - `calculateLapSectors`（`L116-L123`）でゲート交差が見つからなかったセクターに対し、`const fraction = (s + 1) / (sectors.length + 1); splitTime = lapPoints[0].time + totalLapTime * fraction;` で推計値を入れ、実測か推計かのフラグを持たせていない。
  - `extractLaps`（`L348-L353`, `L365-L381`）でベストラップおよびセクターベストを集計する際、`!l.isOutLap && !l.isInLap` しかチェックしておらず、`!l.isPartialLap && !l.isWholeSession` やセクター実測通過の有無を除外していない。
- **修正方針**:
  - ベストラップ判定・セクターベスト判定の対象から `isPartialLap` と `isWholeSession` を除外する。
  - セクターライン未通過時は等分推計を行わず未計測（または推定フラグ付き）とし、セクターベストおよび `theoreticalBestTime` の集計対象から外す。

---

### BUG-03: 複数セッション読み込み時のコース設定・計測線・ポリラインの混線

- **該当箇所**:
  - `src/App.tsx` (`L345-L379`: `loadFileData`, `L460-L470`: `handleSelectCircuitPreset`)
- **現象**:
  1. 1 本目にサーキット A のログを読み込んだ後、2 本目にコース自動判定に一致しないログ（未登録コースや広場練習のログ等）を読み込むと、**1 本目のサーキット A のコース名・計測線・セクター設定がそのまま 2 本目に流用**され、コース不明ログ用の仮計測線（`createVirtualControlLine`）も作られない。
  2. 逆に 2 本目に別サーキット B のログを読み込むと、アプリ全体の `currentControlLine` / `currentSectors` / `currentCircuitName` / `currentPthPolylines` がサーキット B で上書きされ、1 本目（Car 1）のコース図やセクター表示がサーキット B のものにすり替わる。
  3. コースプリセットを手動で切り替えた際（`handleSelectCircuitPreset`）、前のコースの `.pth` / OSM コース図ポリライン（`currentPthPolylines`）が消えずに画面上に残り続ける。
- **原因**:
  - `loadFileData` 内の初期値が `let cl = controlLineRef.current; let sec = currentSectors; let circName = currentCircuitName;` になっており、`matched` が `null` の場合に前回の state が残る（特に `cl` が非 null のため `L370: if (!cl)` の仮計測線生成に入らない）。
  - コース設定がセッション単位ではなくアプリの単一グローバル state として保持されており、`handleSelectCircuitPreset` で `resolveCircuitPolylines` を呼んでいない。
- **修正方針**:
  - `matched` が `null` の場合は前回セッションのコース名・計測線を引き継がないようにする（同一コースで計測線が未通過なだけなのか、別場所のログなのかを座標距離で判定し、離れていれば `cl = null` にリセットする）。
  - `handleSelectCircuitPreset` 実行時にも `resolveCircuitPolylines` でポリラインを更新・クリアする。

---

### BUG-04: 基準車スロット（Car 1）のセッション削除・未割り当て時に再生・シークが完全停止する

- **該当箇所**:
  - `src/App.tsx` (`L91-L119`, `L129-L168`, `L255-L261`: `handleSeekDistance`, `L275-L286`: `handleStep`, `L842-L845`)
- **現象**:
  - 複数セッションを読み込んだ後に Car 1（`slot === 0`）のセッションを削除するか、データ管理タブで Car 1 の割り当てを外して Car 2（`slot === 1`）のみを残すと、各サブウインドウは `activeCars[0]`（Car 2）を基準車として表示するが、**再生ボタン・コマ送り・グラフクリックやマップドラッグによる距離シークが一切反応しなくなる**。
- **原因**:
  - `activeCars` は `[0, 1, 2, 3]` から存在するスロットを詰めて配列化するが、`App.tsx` の `baseSelected`（`L91`）は `selectedLaps.find(s => s.slot === 0)` と `slot === 0` にハードコードされているため、`baseLap` が `undefined` になる。
- **修正方針**:
  - `baseSelected` を `selectedLaps.find(s => s.slot === 0) ?? selectedLaps[0]`（`selectedLaps` は `slot` 昇順ソート済み）とし、常に `activeCars[0]` と一致させる。

---

### BUG-05: 計測線・セクターラインの交差判定に進行方向（通過向き）のチェックがない

- **該当箇所**:
  - `src/services/lapCalculator.ts` (`L37-L86`: `findGateCrossings`)
- **現象**:
  - ピットレーンや隣接する折り返しストレート、スピン・後退、8 の字コースやジムカーナ等で計測線・セクターラインを逆向きに横切った場合にもゲート通過と判定され、ラップやセクターが誤って分割される。
- **原因**:
  - `findGateCrossings` が車両の移動ベクトル `(p2 - p1)` とゲート線分 `(g2 - g1)` の線分交差のみを計算しており、外積 `denom` の符号（どちら側からどちら側へ横切ったか）を検証していない。
- **修正方針**:
  - 初回通過方向（またはコース定義の法線方向）を正方向として保持し、逆向きの交差を除外する。

---

### BUG-06: 車載動画の同期・書き出しまわりの不具合（計 9 件）

- **該当箇所**:
  - `src/components/VideoSyncWindow.tsx` (`L304-L315`, `L480`)
  - `src/services/videoSyncManager.ts` (`L75-L137`, `L195-L216`, `L280-L335`)
  - `src/services/videoMetadataParser.ts` (`L34-L102`)
  - `src/services/telemetryVideoExporter.ts` (`L25-L41`, `L114`, `L155-L215`)
- **内訳**:
  1. **動画タブとグラフ内動画画面の競合**: メインの「動画同期」タブと「解析グラフ」タブ内の動画ウインドウが同時にマウントされると、単一の `videoSyncManager` シングルトンに対して `onStateChange` コールバックや `<video>` 要素の再生時刻を取り合う。
  2. **トラック切り替え・セッション切り替えによる手動同期の上書き（新規発見）**: `VideoSyncWindow.tsx#L304-L315` の `useEffect` が `activeTrack.matchedSessionId !== baseSession.id` のときに自動で `videoSyncManager.resyncTrack` を呼ぶため、手動でオフセットや同期ピンを調整した後でも、トラック切り替えやセッション変更のたびに自動計算値で上書きされる。
  3. **動画追加時の既存手動同期の上書き**: 2 本目の動画を追加した際にも既存の同期状態がリセット・再計算される。
  4. **自動照合失敗時の 0 秒扱い**: GPS 時刻と動画作成日時の自動照合に失敗した動画を「オフセット 0 秒で一致済み」として扱う。
  5. **MP4 作成日時の誤検出と無警告フォールバック（新規発見）**: `videoMetadataParser.ts#L34-L90` の `findFourCC` が ISOBMFF（MP4/MOV）のボックスサイズを辿らず生バイト列から `'mvhd'` の 4 バイトを単純検索しているため、`mdat` 内の映像ストリームに偶然 `'mvhd'` と同じバイト列があると誤検出し、後続の本当の `mvhd` を探さずに失敗して `file.lastModified`（コピー日時等）へ無警告フォールバックする。また `version === 1`（64bit 時刻）のときオフセット `+20` から 8 バイト読むのに `+12 <= view.byteLength` しか境界チェックしていない（`L99`）。
  6. **同期プロジェクト（`.dssync.json`）の再選択時引き継ぎ不可**: 保存した同期プロジェクトを再起動後に読み込んでも、動画ファイルを選び直した際に保存済みのオフセット・ピン設定が引き継がれない。
  7. **同期プロジェクト（`.dssync.json`）の異常値未検証**: JSON 内の数値（`NaN` や極端な値）を検証しておらず、不正な値で画面がフリーズする。
  8. **動画書き出しの開始直後キャンセル不発・録画中の巻き戻し**: エクスポート開始直後にキャンセルすると終了しない。またエクスポート中に通常の再生同期ループが介入して録画位置を巻き戻すことがある。
  9. **動画書き出しのコンテナ形式と拡張子の不一致（新規発見）**: `telemetryVideoExporter.ts#L25-L41` で `MediaRecorder` が `video/mp4` 非対応のため `video/webm` にフォールバックした環境でも、`VideoSyncWindow.tsx#L480` の出力ファイル名が常に `.mp4` になり、WebM 中身に `.mp4` 拡張子が付いて QuickTime Player 等で開けなくなる。

---

## 🟡 影響度：中（P2 — 特定条件・比較モードでの計算ずれ・ファイル入出力の不整合）

### BUG-07: 距離補正（`distanceOffsetM`）およびラップ長伸縮（`alignLapLength`）の他機能との不整合

- **該当箇所**:
  - `src/components/SpeedGraphWindow.tsx` (`L43-L56`)
  - `src/services/lapCalculator.ts` (`L394-L432`: `calculateDeltaTimes`)
  - `src/services/drivingAnalysis.ts` (`L88-L106`: `buildLapGeometry`, `L263-L288`: `matchIndex`)
- **現象・原因**:
  1. **車速グラフの右端切れ・先頭欠落**: `SpeedGraphWindow.tsx#L43-L56` の横軸上限 `maxDomain` が `car.lap.totalDistance` のみから計算され `distanceOffsetM` を加算していないため、比較車に正の距離補正を入れるとグラフ右端が切れ、負の距離補正を入れると先頭が `0 km` 未満になって描画されない。
  2. **タイム差（Delta）の不連続**: `calculateDeltaTimes`（`lapCalculator.ts#L403-L426`）は比較車に正の距離オフセットがあるとき、オフセット区間中ずっと `targetIdx = 0`（`targetElapsed = 0`）に張り付き、先頭でのオフセット分の時間シフトが反映されず途中から急に変化する。
  3. **コーナー診断・ブレーキング診断への未反映と途中終了ラップの比較破綻**: `drivingAnalysis.ts` の `buildLapGeometry`（`L88-L106`）は `pts[i].distance` を使わず緯度経度から独自に距離 `s[i]` を再積算しているため、データ管理タブで設定した `distanceOffsetM` や `alignLapLength` が一切反映されない。さらに `matchIndex`（`L266`）は `const expectedS = (ref.s[refIndex] / refTotal) * target.s[n - 1]` で探索中心を決めるため、比較車が `isPartialLap`（途中終了ラップ、たとえば全長 2000m 中 1000m で終了）の場合に探索位置が半分に圧縮されて全く別のコーナーと比較し、「対応区間なし」になる。

---

### BUG-08: 開始位置の違うログを重ねるとずれる問題の残り

- **該当箇所**:
  - `src/services/lapCalculator.ts` (`L279-L315`: `extractLaps`)
- **現状**:
  - 計測線 1 回通過時の `isPartialLap` 切り出し、手動距離補正（`distanceOffsetM`）、ラップ長伸縮（`alignLapLength`）、コース不明時の仮計測線（`createVirtualControlLine`）まで実装済み（`dev` ブランチ、画面上での確認待ち）。
- **残課題**:
  - 計測線より後ろから始まるログ（通過がファイル末尾近くの 1 回だけ）や、仮の計測線より後ろから始まるログは自動では揃わない（現状は手動の距離補正で合わせる必要がある）。
  - ロガー機種ごとの GPS 受信・出力遅延（0.x 秒）は距離軸の重ね合わせには影響しないが、時間軸比較と動画同期には影響する。

---

### BUG-09: 生バイナリ（`.bnx4` / `.bon4`）の複数セッション連結・重複時刻・メタデータ計算の不備

- **該当箇所**:
  - `src/services/rawBinaryParser.ts` (`L197-L216`, `L332`)
  - `src/services/digspiceDevice.ts` (`L675-L791`: `applyOfficialMetadata`)
- **現象・原因**:
  1. **複数日・複数枠のログ連結と重複時刻の未除去**: フラッシュメモリ内に複数日や複数走行枠のログが残っている `.bnx4` を読み込むと、`parseRawBinary` が全レコードを 1 つのセッションとして連結するため、枠間の数時間〜数日の空白や自走移動まで 1 セッションに含まれる。また `L332` のコメントに「時間順にソート & 重複除去」とあるが実際には `rawRecords.sort(...)` のみで重複除去を行っていない。
  2. **ミリ秒補間の誤無効化**: `rawBinaryParser.ts#L197` の `hasAnyNonZeroMs` はファイル全体で 1 点でも `0 < ms < 1000` のレコードがあると `true` になるため、ノイズや部分的なレコードで 1 点でも非ゼロ ms が混ざると、残りの `ms === 0` の秒グループに対する等分補間がすべて無効化され、同一秒内の全点が同じタイムスタンプになる。
  3. **吸い出し時のメタデータ書き込み（`applyOfficialMetadata`）**: `digspiceDevice.ts#L696-L702` でチェックサム検証なしに `0xaa 0xaa` ヘッダだけでレコードを数えている。また `L721-L725` の `calcBitLength` で南半球（`firstLat < 0`）や西経（`firstLon < 0`）の座標が入ると `resFixed < 0n` となり `while (temp > 0n)` ループに入らず `bitLen = 0` が書き込まれる。

---

### BUG-10: NMEA 入出力の実装の不整合（`ds4_convert` v1.0.3〜v1.0.4 との差分）

- **該当箇所**:
  - `src/services/nmeaParser.ts` (`parseNmea`, `exportNmea`)
  - `src/services/nmeaExporter.ts` (`exportSessionToNmea`)
  - `src/services/logConverter.ts` (`convertToNmea`)
- **現象・原因**:
  1. **出力経路による GGA ダミー値の混入**: 変換タブ（`logConverter.ts` の `convertToNmea`）は実測の衛星数を出し未記録の HDOP 等を空欄にするが、データ管理タブの「NMEA出力」（`nmeaParser.ts` の `exportNmea`）と上部ヘッダーからの NMEA エクスポート（`nmeaExporter.ts` の `exportSessionToNmea`）は、常に衛星数 `12`・HDOP `0.9` のダミー値を出力している（さらに `exportNmea` は RMC → GGA の逆順・ミリ秒 2 桁になっている）。
  2. **NMEA 読み込み時の GGA 情報の欠落**: `parseNmea` が GGA から標高（`parts[9]`）しか読んでおらず、衛星数（`parts[7]`）や元の GGA フィールドを保持しないため、NMEA ログを読み込んで再出力すると衛星数などが失われる。また RMC を含まない GGA のみのログは 0 点になる。
  3. **標高未記録と `0 m` の区別がない**: `TelemetryPoint.altitude` が非 null の `number`（初期値 `0`）のため、標高が記録されていないログ（旧 `.bon` や RMC のみの NMEA 等）でも GGA 出力時に空欄ではなく `0.0,M` が出力される。

---

### BUG-11: CSV / GPX / VBO パーサーおよびファイル読み込みの個別不具合

- **該当箇所**:
  - `src/App.tsx` (`L295-L339`: `loadFileData`)
  - `electron/main.cjs` (`L164-L169`)
  - `src/services/csvParser.ts` (`L21-L106`: `parseCsv`)
  - `src/services/externalFormats.ts` (`L272-L292`: `parseGpx`)
- **現象・原因**:
  1. **拡張子と中身の判別不足 & GPX ダイアログフィルタ漏れ**:
     - `App.tsx#L308-L320` で `.txt` は常に `parseCsv` に渡されるため、NMEA 形式の `.txt` や VBO 形式の `.txt` が読み込めない（逆に `.log` は常に NMEA として処理され、CSV 形式の `.log` が読めない）。
     - `electron/main.cjs#L166` のネイティブ「ファイルを開く」ダイアログの拡張子フィルタに `gpx` が含まれておらず、Electron 版のメニューから `.gpx` を選択できない。
  2. **CSV パーサーの列ずれ・先頭時刻未正規化・方位/衛星数の欠落**:
     - `csvParser.ts#L21,L84`: `externalFormats.ts` には引用符対応の `splitCsvLine` があるが、`csvParser.ts` は単純な `.split(',')` を使っているため、カンマを含む引用符付きフィールドがあると列がずれる。
     - `csvParser.ts#L87`: 先頭行の時刻 `t0` を差し引いて正規化していないため、先頭が `0` 秒でない CSV を読むとセッション先頭時刻がずれる。
     - `csvParser.ts#L58-L74`: `heading`（方位）列・`satellites`（衛星数）列をパースしておらず、自アプリの「ログ変換」タブで出力した CSV を読み戻しても方位と衛星数が失われる。
  3. **GPX パーサーの最終秒グループ切り捨てと速度 0 落ち**:
     - `externalFormats.ts#L276`: 秒単位タイムスタンプしか持たない GPX の等間隔補間ループで、終了条件が `j < raw.length` のときのみ補間を実行しているため、**ファイル末尾の最終秒グループが補間されず**、直後の `finalize`（`dt <= 0` 除外）で末尾秒の 2 点目以降が切り捨てられる。
     - `externalFormats.ts#L284`: `const hasSpeed = raw.some(r => r.speedKmh !== null)` で判定しているため、ファイル内の 1 点でも `<speed>` があれば、`<speed>` が欠落している他のすべての点の速度が距離微分ではなく `0 km/h` になる。

---

### BUG-12: 物理計算（G 値・旋回半径・ドリフト指標）の微分ウィンドウがサンプル数固定

- **該当箇所**:
  - `src/services/physics.ts` (`L129`: `calculatePhysics`)
- **現象・原因**:
  - 速度微分・角速度微分に使う `windowSize = 2`（前後 2 サンプル = 計 4 インターバル）がサンプル数固定になっている。
  - そのため、記録レートが 50Hz のログでは `0.08 秒` 幅の微分になる一方、1Hz のログでは `4.0 秒` 幅、5Hz では `0.8 秒` 幅の移動平均微分になり、同じ走行でもロガーの記録レートによって縦 G・横 G・旋回半径・ドリフト指標のピーク値が大きく変わる。
- **修正方針**:
  - サンプリング周期 `dt` に応じて一定の目標時間幅（例: 前後 `0.2 秒` 相当）になるようサンプル数または時間窓を動的に決定する。

---

### BUG-13: 分・秒フォーマットの「60 秒」繰り上がりバグ

- **該当箇所**:
  - `src/services/csvParser.ts` (`L154`: `exportSessionCsv`, `L184`: `exportSummaryCsv`)
  - `src/components/DataTab.tsx` (`L58`: `formatTime`)
  - `src/services/videoSyncPinManager.ts` (`L49`: `formatPinTime`)
  - `src/components/VideoSyncWindow.tsx` (`L187`: `formatTime`)
- **現象・原因**:
  - `const mins = Math.floor(sec / 60); const s = (sec % 60).toFixed(3);` のように分と秒を別々に計算してから `toFixed` で丸めているため、`sec = 119.9996` などのときに `"1:60.000"` という不正な時刻文字列が出力・表示される。
- **修正方針**:
  - 表示桁の最小単位（ミリ秒なら `Math.round(sec * 1000)`）に丸めてから分・秒へ分解する共通フォーマット関数に統一する。

---

## 🟢 影響度：低（P3 — パフォーマンス・コース管理・UI 表示・補助機能）

### BUG-14: 点数の多いログでの再生性能と毎フレームの線形探索

- **該当箇所**:
  - `src/components/SpeedGraphWindow.tsx` (`L582`)
  - `src/components/TrackMapWindow.tsx` (`L210`, `L456`)
  - `src/components/FrictionCircleWindow.tsx` (`L102`)
- **現象・原因**:
  1. 再生中、毎フレーム全点の再計算・Canvas 再描画が走る（特に `FrictionCircleWindow` の全点散布図など、20 万点規模のログや `isWholeSession` 時にフレームレートが低下する）。
  2. `src/utils/telemetryMath.ts` に二分探索 `findClosestPointByDistance`（$O(\log N)$）が用意されているにもかかわらず、`SpeedGraphWindow.tsx#L582`（右上数値インジケーター）および `TrackMapWindow.tsx#L210,L456`（自車マーカー座標計算）が `points.reduce(...)` による線形探索（$O(N)$）を毎フレーム実行している。

---

### BUG-15: コースデータの登録・自動判定まわり

- **該当箇所**:
  - `src/services/userCircuitStorage.ts`
  - `src/services/circuitDatabase.ts`
- **内訳**:
  1. **コースデータの登録不備**: セクタファイル（`.sci`）は件数だけ表示して中身をパースしていない / 別フォルダの同名ファイル（`control.ini` 等）を一括選択した際に混ざる / `localStorage` の容量超過等で保存に失敗しても「保存しました」と成功表示する。
  2. **隣接コースの自動判定（利用者が読み込んだコースデータ側）**: 内蔵プリセットは計測線を実際に通過しているコースを優先するように対応済みだが、利用者が読み込んだコースデータ側はログの先頭座標に近いものを選ぶだけのままになっている。
  3. **内蔵の計測線の実走ログ確認残り**: 航空写真から作成した 12 コースのうち、手元に実走ログがないコースの通過確認が未了。

---

### BUG-16: ロガー設定タブのダミー UI と通信まわりの軽微な残件

- **該当箇所**:
  - `src/components/LoggerTab.tsx` (`L33-L34`, `L485-L517`)
  - `src/services/digspiceDevice.ts`
- **内訳**:
  1. **「解析 & 単位設定」が未接続のダミー UI（新規発見）**: `LoggerTab.tsx#L485-L517` にある「速度単位（`km/h` / `mph`）」および「Gフォース 微小微分フィルタ（`弱` / `標準` / `強`）」のボタンは、`LoggerTab` 内のローカル state（`unitSpeed`, `gFilter`）を切り替えるだけで、アプリの解析処理（`physics.ts`）にも各画面の単位表示にも一切接続されていない。
  2. **記録レート変更時の副作用の明示**: レート変更コマンドは記録マスク等も標準値で書き直す（公式ソフトと同じ動作）が、画面上にその旨の説明を出していない。
  3. **ログ吸い出しの欠落時の部分再取得**: 通信中のブロック欠落を検出したらエラーにする処理までは対応済みだが、欠けたブロックだけを再要求して復旧する処理は未対応。
