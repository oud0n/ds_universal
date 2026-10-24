# コースデータを作る道具

`courses/` のデータ（計測線・セクター線）を作るためのスクリプト。作業用のファイル（`osm_*.json`・`center_*.json`・`gates_*.json`・`crop_*`・`view_*`）はこのフォルダにできるが、コミットしない（`.gitignore`）。

必要なもの: Node.js、macOS の `qlmanage`（SVG を PNG にして見るため）。

## 手順（1 コース）

```sh
cd tools/courses
node ov.mjs fetch <id> <緯度> <経度> <国>      # OpenStreetMap の raceway を取る。国は US / NL / FR / ES / JP（航空写真の取り先）
node ov.mjs crop <id> "" "" 450                # ピットロードの中ほどの航空写真に、OSM の線とマス目（100 px）を重ねる → crop_<id>.svg.png
node ov.mjs zoom <id> <x> <y> <幅m>            # 直前の写真の画素 (x, y) を中心に撮り直す
node ov.mjs line <id> <x1> <y1> <x2> <y2>      # 写真の画素で計測線を決める（ピットロードまで含める）
node ov.mjs pitline <id> 30                    # 写真で決められないとき: ピットロードの中ほどに仮の線
TARGET=<公式の長さm> node loops.mjs <id>       # 計測線を通る 1 周の候補（長さの近い順）
./fin.sh <id> <公式の長さm> <CW|CCW> [候補の番号] [区切り]   # 1 周を取り出し、セクター線を置いて view_<id>.svg.png を描く
node add_courses.mjs ../../courses <id>...     # courses/ に .cln・.sci と index.json の項目を書く（名前とメモは中の META）
```

- `EXCL="short|kart"` を付けると、名前が合う道（短いコース・カートコースなど）を外して 1 周を探す。
- 区切りは既定で 3 等分（`0.3333333,0.6666667`）。距離（m）でも指定できる。等分の位置の近くに並行する直線があるときは、±8% の範囲でずらす。
- 走る向き（CW / CCW）を間違えても、アプリが周回の計算でセクターを並べ直す。
- セクター線を入れないコースは、`add_courses.mjs` の META に `noSectors`（理由）を書く（.sci を書かず、`index.json` に `sci` を入れない）。
- セクター線の無いコースにまとめて置く: `node sectors_batch.mjs [id...]`（2026-10-24）。計測線を通るいちばん長い周を 3 等分し、ほかの路面にかからない長さの線にする。結果は `sectors_batch.json` と `view_<id>.svg`（確かめ用の図）。courses/ には書かないので、図を見て正しいものだけ入れる。

## 航空写真

使ってよいと確かめたものだけを使う（Google マップ・Esri・Bing は使わない）。

| 国 | 写真 | 条件 |
|---|---|---|
| US | USGS NAIP | パブリックドメイン |
| NL | Beeldmateriaal Nederland（PDOK） | CC BY 4.0 |
| FR | IGN BD ORTHO（Géoplateforme） | Licence Ouverte 2.0 |
| ES | PNOA（IGN España） | CC BY 4.0 |
| JP | 国土地理院 シームレス空中写真（XYZ タイルを並べる） | 国土地理院の利用規約に従う（出典を書く） |
