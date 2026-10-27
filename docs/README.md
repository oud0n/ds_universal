# 文書の一覧

2026-10-27 (1.1.0) 時点。どこから読めばよいかと、各文書の状態。新しく入る人・ほかのエージェントは、まず上の 4 つを読む。

## まず読むもの

| 文書 | 中身 |
|---|---|
| [../AGENTS.md](../AGENTS.md) | エージェント向けの入口 (守ること・作業の流れ) |
| [architecture.md](architecture.md) | 構成 (Web・Electron・iOS・Android、ネイティブの窓口、保管場所の形、主なファイル) |
| [maintenance.md](maintenance.md) | 開発・試験・レビュー・リリース (PC・ブラウザ・App Store・TestFlight) の手順 |
| [../TODO.md](../TODO.md)・[../BUGS.md](../BUGS.md) | 今の状態と残件 |

## 利用者向け (公開)

| 文書 | 中身 |
|---|---|
| [../README.md](../README.md) (英語 [README.en.md](../README.en.md)) | 概要・ダウンロード |
| [features.md](features.md) (英語 [features.en.md](features.en.md)) | 対応している機能の一覧 |
| [install.md](install.md) (英語 [install.en.md](install.en.md)) | インストールの仕方 |
| [release-notes.md](release-notes.md) (英語 [release-notes.en.md](release-notes.en.md)) | 版ごとの変更 |
| `../public/help/` | アプリの中から開く使い方のページ (18 ページ、日本語・英語)。計画は [manual_plan.md](manual_plan.md) |
| [../courses/README.md](../courses/README.md) | 内蔵のコースデータの作り方・出典 |
| [../protocol_analysis.md](../protocol_analysis.md)・[../bluetooth_protocol_analysis.md](../bluetooth_protocol_analysis.md) | デジスパイスの USB・Bluetooth の通信の解析 |

## 開発者向け

| 文書 | 中身 |
|---|---|
| [development.md](development.md) (英語 [development.en.md](development.en.md)) | 開発の始め方 (npm の命令) |
| [../mobile/README.md](../mobile/README.md) | iPhone・Android のネイティブ部分、TestFlight へ送る手順 |
| [app_store.md](app_store.md) | App Store の文章・審査の準備 |
| [device_check_2026-10-25.md](device_check_2026-10-25.md) | 実機で確かめた記録 (1.1.0 の前) |

## 設計書 (状態つき)

| 文書 | 計画 | 状態 |
|---|---|---|
| [iphone_app_design.md](iphone_app_design.md) | PLAN-01 iPhone のアプリ | 実装済み (1.0〜1.1.0)。一部の構想は未 |
| [ios_native_study.md](ios_native_study.md) | PLAN-20 ネイティブ化の検討 | 結論: 画面はネイティブにしない。動画の WebCodecs は未着手 |
| [video_sets_design.md](video_sets_design.md) | PLAN-17 動画の走行とセット | 実装済み |
| [overlay_parts_design.md](overlay_parts_design.md) | メーターの部品 | 実装済み |
| [meter_layout_design.md](meter_layout_design.md) | PLAN-08・38 メーターの配置・画像・書き出しの範囲 | 実装済み |
| [session_storage_design.md](session_storage_design.md) | PLAN-18 比べ方の保存 | 実装済み |
| [run_storage_v2.md](run_storage_v2.md) | PLAN-29・32・33 runs.json の 2 版 | 実装済み (保管場所の形の正) |
| [corner_names_design.md](corner_names_design.md) | PLAN-27 コーナーの名前 | 実装済み |
| [csv_format_design.md](csv_format_design.md) | PLAN-36 CSV の形式・計算式 | 実装済み (残り 2 つは TODO) |
| [duo_layout_design.md](duo_layout_design.md) | PLAN-30・41 Duo・中くらいの配置 | 実装済み。Duo の実機での見直し (PLAN-41) は残り |
| [manual_plan.md](manual_plan.md) | PLAN-39 使い方のページと動画 | 実装済み |
| [ai_coach_design.md](ai_coach_design.md) | PLAN-02 AI のコーチ | 検討のみ |
| [carplay_study.md](carplay_study.md) | PLAN-34 CarPlay | 見送り |
| [dashware_gap.md](dashware_gap.md)・[overlay_tools_gap.md](overlay_tools_gap.md)・[racechrono_gap.md](racechrono_gap.md) | ほかのソフトとの差 | 参考 (2026-10-18 時点) |

## 記録

| 文書 | 中身 |
|---|---|
| [history/todo_until_1.1.0.md](history/todo_until_1.1.0.md) | 1.1.0 までの TODO の全文 (終えた計画の経緯・決めたこと) |
| [history/bugs_until_1.1.0.md](history/bugs_until_1.1.0.md) | BUG-01〜23 の調べ・直し方の全文 |
| `ui_review/`・`images/` | 画面の写真 (README・見直し用) |

## 文書を直すときの決まり

- 新しい計画・不具合は TODO.md / BUGS.md に ID を付けて足す。終えたら状態を書き換え、版を出すときに要らなくなった行を history に移す。
- 設計書を足したら、この一覧に状態つきで足す。
- 利用者向けの文書は日本語と英語の両方を直す。開発者向け・設計書は日本語だけでよい。
- 秘密 (API キー・トークン) は書かない。置き場所だけ書く (`_private/`)。
