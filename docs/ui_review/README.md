# UI レビュー用の画面キャプチャ

v0.7.1 時点の各画面です（2026-10-13 撮影）。UI の指摘・修正案の検討に使います。

- 撮影環境: macOS のアプリ版（開発モード）、ウィンドウ 1400×868（画像は 2 倍の 2800×1736）
- 使用ログ: 袖ヶ浦フォレストレースウェイの走行ログ（16 ラップ）
- ロガー接続中の画面（15〜18）は、開発用シミュレーターに接続して撮影
- `mobile_390_*` は、ブラウザ版を幅 390 px（スマートフォン相当）で表示したもの。レイアウトは未対応

## グラフ解析

| ファイル | 内容 |
| :--- | :--- |
| `01_graph_default.png` | 読み込み直後（車速グラフ、コース図、走行アニメーション、フリクションサークル） |
| `02_graph_latg_aerial_corners.png` | G 表示: 横 G、コース図の背景: 航空写真、コーナー番号 |
| `03_graph_2cars_delta_line_corner.png` | 2 台比較、ライン偏差、コーナー解析（上部のメニューが折り返している） |
| `04_graph_speedheat_braking.png` | コース図: 車速ヒート、ブレーキング |
| `05_graph_accel_drift.png` | コース図: 加減速、ドリフト採点・評価 |
| `06_graph_video_sync_panel.png` | 右下: 車載動画同期 |
| `07_graph_onboard_video.png` | 左下: 車載動画 (GoPro/MP4) |
| `08_graph_time_altitude.png` | 横軸: 時間、標高表示 |
| `21_empty_graph.png` | ログ未読み込み |

## 動画同期

| ファイル | 内容 |
| :--- | :--- |
| `09_video_sync_tab.png` | ログ読み込み済み、動画なし |
| `23_empty_video.png` | ログ未読み込み |

## データ管理

| ファイル | 内容 |
| :--- | :--- |
| `10_data_top.png` | 上部（セッション、コース設定、書き出し） |
| `11_data_bottom.png` | ラップ一覧（スロット選択） |
| `19_circuit_editor_modal.png` | コース編集ダイアログ |
| `22_empty_data.png` | ログ未読み込み |

## ログ変換

| ファイル | 内容 |
| :--- | :--- |
| `12_convert.png` | ログ読み込み済み |
| `24_empty_convert.png` | ログ未読み込み |

## ロガー設定

| ファイル | 内容 |
| :--- | :--- |
| `13_logger_disconnected_top.png` | 未接続（上部） |
| `14_logger_disconnected_bottom.png` | 未接続（下部） |
| `15_logger_connected_top.png` | 接続中（上部） |
| `16_logger_connected_middle.png` | 接続中（本体設定） |
| `17_logger_connected_bottom.png` | 接続中（通信コンソール、解析 & 単位設定） |
| `18_logger_downloaded.png` | ログ吸い出し後 |

## その他

| ファイル | 内容 |
| :--- | :--- |
| `20_donate_modal.png` | 開発支援ダイアログ |
| `mobile_390_graph.png` | スマートフォン幅: グラフ解析 |
| `mobile_390_data.png` | スマートフォン幅: データ管理 |
| `mobile_390_convert.png` | スマートフォン幅: ログ変換 |
| `mobile_390_logger.png` | スマートフォン幅: ロガー設定 |
