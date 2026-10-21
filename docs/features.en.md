# LapLoupe features

[日本語](features.md) | **English**

[Back to the README](../README.en.md)

## 1. DigSpice IV USB communication and logger settings (`LoggerTab`)
- **Direct connection with the Web Serial API**: no native driver to build; one USB cable is enough.
- **Fast log download**: streams all driving data off the logger and saves it in the official-compatible `.bnx4` format.
- **Settings**: change the GPS rate (`20Hz` / `10Hz` / `5Hz`) and the logging start/stop speed (5–100 km/h), and confirm the change by reading the values back from the logger.
- **Erase logger memory**: erase the whole flash memory before your next session (with a lock against erasing by mistake).

## 2. Motorsport telemetry analysis (`Graph / DataTab`)
- **Speed graph comparison**: overlay the speed and distance of up to 4 cars (or 4 laps).
- **Track map and driving line**: plots the course using OpenStreetMap or your own circuit definitions. GSI (Geospatial Information Authority of Japan) aerial photos or maps can be shown as the background (internet connection required), and the map position can be nudged to match the GPS trace.
- **G-forces and friction circle**: distribution of acceleration, braking and cornering G, shown as a friction circle.
- **Corner analysis**: detects corners automatically and compares entry, minimum and exit speed between cars (laps).
- **Braking analysis**: braking point, peak deceleration, build-up, release and trail braking, as numbers and graphs (estimated from GPS speed).
- **Line difference heat map**: colours the track map by how far the driving line is left or right of the reference lap. GPS position offsets between laps are corrected automatically.
- **Other formats**: Racelogic VBO, RaceChrono CSV, GPX, MoTeC CSV (exported from i2) and AiM (Race Studio CSV, and the GPS in logger files `.xrk` / `.xrz`).
  - MoTeC and AiM support has only been checked with sample files published on the internet, not with logs recorded on the developer's own hardware. If a file does not load correctly, please let us know in an issue.
- **GPS from GoPro videos**: open a video (.MP4) shot with a GoPro that records GPS (HERO5 and later) with "ファイル読込" (Open file), and the GPS recorded in the video is loaded as a driving log. The same video is added to video sync and plays already aligned by GPS time. When one recording is split into several files (chapters), select them together to get one log. (The video is read on your device and is never loaded into memory as a whole.)
- **Log conversion page**: export a loaded log to NMEA (GGA + RMC), GPX, VBO, CSV, TXT (space-separated), KML (for Google Earth, line coloured by speed), DTB, map HTML (hover for time and speed) or MoTeC CSV, plus DigSpice-style telemetry CSV (with G) and a lap list CSV. You choose the range (the whole log, one lap, or a time range cut out on the graph) and the time offset (time zone). All exports live on this page; open it from "変換画面で開く" (Open in converter) for each log on the data tab.

### Course data (timing lines)
- **Built-in presets**: names and centre coordinates of 101 courses in Japan (circuits and kart tracks) and 26 circuits abroad (USA, Netherlands, France and Spain), with start/finish timing lines for 126 of them. All of this is the app's own data: centre coordinates come from the course shapes in OpenStreetMap, and timing lines were placed by checking the start line area on aerial photos (GSI in Japan; abroad, imagery each country allows to be used freely). For 3 circuits abroad the start line could not be confirmed on the photos, so the line is a placeholder in the middle of the pit lane; for 3 more, where no line was visible on the photos, the position is an estimate. Most of the kart tracks and small circuits in Japan use an estimated line perpendicular to the OpenStreetMap track, checked on the photos only to make sure it crosses the track surface. They work for splitting laps but may not match each circuit's official timing position (if the line is in a different place, lap times for the same session change slightly). 73 of them also have sector lines (SUGO uses the timing points on the official course map, Suzuka and Fuji are estimated from how races split the lap, Motegi is split into 4 equal parts, and the others into 3 equal parts as placeholders). The data is bundled as files in the DigSpice format (.cln / .sci) in [`courses/`](../courses/). If a line is in the wrong place, please open a [course data issue](https://github.com/oud0n/ds_universal/issues/new?template=course.yml) (a .cln / .sci exported from the course editor helps).
- **Using your own course data**: if you own the official DigSpice software, load the course folder on your PC (the folder containing `Circuit` / `ControlLine` / `Sector`) with "コースフォルダ一括設置" (Install course folder) on the data tab. Loaded data takes priority over the built-in presets. This app does not bundle or distribute the official course data.
- **Courses without a timing line**: enter the two points (latitude and longitude) of the line in "コース編集" (Course editor) on the data tab, or load a `.cln` file. If no line is set or the car never crossed it, the data tab shows a hint.
- Sources: the built-in coordinates are based on data from [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright) ([Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/)) and on the seamless aerial photos of [GSI](https://maps.gsi.go.jp/development/ichiran.html). The data is the files in [`courses/`](../courses/) (see [`courses/README.md`](../courses/README.md) for how they were made). The SUGO sector positions use the distances of the timing points on [SUGO's course map](https://www.sportsland-sugo.co.jp/assets/docs/course/c-racing/2026_racing-course_layout.pdf).

## 3. Onboard video (GoPro / DJI / generic MP4) sync (`VideoSyncWindow`)
- **Automatic time zone detection and 9-hour offset scan**: detects the time difference from the GPS position (JST inside Japan) and the video metadata (UTC/JST) and corrects the offset to the millisecond.
- **Seamless playback of GoPro 4 GB chapter files**:
  - Detects split files such as `GX010017.MP4` → `GX020017.MP4` → `GX030017.MP4` and joins them in order.
  - Plays seamlessly across chapter boundaries.
- **NLE-style multi-track timeline**:
  - Shows at a glance where the GPS log (each lap) and the onboard video (each chapter clip) sit on the session's absolute time.
  - Click or drag on the timeline to scrub.
- **Two-way seek sync with the speed window**:
  - The seek bar follows the selected lap (or the whole session).
- **Two cameras / picture-in-picture**:
  - Play a front camera and a rear camera (or a pedal camera, etc.) side by side (1:1) or as picture-in-picture, fully synchronised.
- **Manual keyframe sync (Sync Pin)**:
  - Press "ピン留め同期" (Pin sync) on a frame such as a kerb clipping point or the timing line crossing to lock the offset in one click.
- **Telemetry burn-in export**:
  - Renders and exports MP4 video with the speedometer, G-ball and lap time composited, using only standard browser features.
- **Flat design**:
  - A crisp, high-visibility UI without unnecessary shadows or rounded corners, as befits a professional motorsport analysis tool.

## 🌐 What the browser version connects to

Use it straight from your browser without installing anything. Logs are loaded, analysed and converted on your device and are never sent to a server.

The app only talks to outside services to show maps (map tiles), to fetch course definitions automatically (the course centre coordinates are sent to the OpenStreetMap Overpass API), and when you open an exported map HTML file (the display script comes from unpkg.com and the map tiles from OpenStreetMap). The browser version also uses [GoatCounter](https://www.goatcounter.com/) to count visits (it sends the page opened, the referrer and similar; no cookies are used and no log contents are sent). The desktop version does not include it.

- Analysis: <https://oud0n.github.io/ds_universal/>
- Log conversion: <https://oud0n.github.io/ds_universal/#convert>

USB communication with the logger (the logger settings tab) uses the Web Serial API, so it **only works in Chrome / Edge on a PC**. In Safari, Firefox or on smartphones you can still load, analyse and convert logs.

## 🚫 Features not implemented

- **The official software's drift scoring**: not implemented, because it could infringe the copyright of DigSpice Co., Ltd. (and there are no plans to implement it).
  The app used to have its own simple "drift" display, but it was removed on 2026-10-17.
- Reading and converting the logger's log data deals with the recorded data itself (position, time, speed, etc.) and the file's accompanying information; this is general analysis and is distinct from the above.

## 🔧 Technical notes

How the app talks to the logger and how the analysis works are written up here.

- [Reading the DigSpice IV GPS logger's protocol to use it from macOS (Zenn, Japanese)](https://zenn.dev/oud0n/articles/ace1347602c574) — why this app was made, and how the USB communication works
- [USB protocol analysis (Japanese)](../protocol_analysis.md)
- [Bluetooth (BLE) protocol analysis (Japanese)](../bluetooth_protocol_analysis.md)
