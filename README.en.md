<p align="center"><img src="build/icon.svg" width="128" height="128" alt="LapLoupe icon"></p>

# LapLoupe (formerly DS Universal) — Lap / Track Analyzer

[日本語](README.md) | **English**

**An unofficial lap and track analyzer for the DigSpice GPS logger that runs on Mac, Windows and in the browser**

Log download and logger settings for DigSpice IV, racing line / speed / G analysis, and onboard video (GoPro etc.) sync

![Supported OS](https://img.shields.io/badge/OS-Windows%20x64%20%7C%20macOS%20Apple%20Silicon-blue)
![Verification](https://img.shields.io/badge/Verified-macOS%20Only-amber)
![Version](https://img.shields.io/badge/Version-0.12.0-red)
![Device](https://img.shields.io/badge/Device-DigSpice%20IV-red)
![License](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-orange)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-oud0n-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/oud0n)

> [!WARNING]
> ### ⚠️ Testing status (important)
> This software has so far **only been tested on macOS (Apple Silicon)**.  
> GitHub Actions also builds and publishes a Windows (x64) installer and ZIP, but they have not been tested on real Windows machines.  
> Reports and bug feedback (issues / pull requests) from Windows users are very welcome.
>
> **Supported platforms**: Windows (x64) / macOS (Apple Silicon, arm64).  
> Linux and Intel Macs (including running under Rosetta 2) are not supported, and no builds are provided for them.

The app's screens can be switched between Japanese and English ("JA / EN" at the top right). The first time, it follows your browser's language.

> [!NOTE]
> ### New name (2026-10-19)
> The app was renamed from "DS Universal" to **LapLoupe**.
> Searching for "DS Universal" mostly brings up unrelated, rather undesirable sites such as game console modding tools.
> The repository name (`ds_universal`) and the browser version's URL stay the same. The name inside the app will be updated step by step.

---

## 🏎️ Overview

**LapLoupe (formerly DS Universal, `ds_universal`)** is an unofficial, source-available app (desktop and browser) for the DigSpice IV, a GPS data logger for circuit driving whose official analysis software runs only on Windows. a GPS data logger for circuit driving. It brings together downloading logs from the logger and changing its settings, telemetry analysis of the driving line, speed and G-forces, and onboard video: automatic synchronisation with GoPro footage to the millisecond, two-camera picture-in-picture playback, and exporting MP4 video with the gauges burned in.

---

## 📸 Screenshots

**Graph analysis**: speed graph, track map (with GSI aerial photos as the background), driving animation, friction circle

![Graph analysis](docs/images/analysis.png)

**Corner analysis and lap comparison**: speed, time delta and line difference between two laps; entry, minimum and exit speed for each corner

![Corner analysis](docs/images/corner_analysis.png)

**Log conversion**: cut out part of a log (a lap or a time range) and export it to NMEA / GPX / CSV / map HTML, telemetry CSV, lap list CSV or DTB

![Log conversion](docs/images/convert.png)

**Logger settings**: connect the logger over USB to change the sampling rate and the logging start speed, and to download logs

![Logger settings](docs/images/logger.png)

---

## ✨ Features

### 1. DigSpice IV USB communication and logger settings (`LoggerTab`)
- **Direct connection with the Web Serial API**: no native driver to build; one USB cable is enough.
- **Fast log download**: streams all driving data off the logger and saves it in the official-compatible `.bnx4` format.
- **Settings**: change the GPS rate (`20Hz` / `10Hz` / `5Hz`) and the logging start/stop speed (5–100 km/h), and confirm the change by reading the values back from the logger.
- **Erase logger memory**: erase the whole flash memory before your next session (with a lock against erasing by mistake).

### 2. Motorsport telemetry analysis (`Graph / DataTab`)
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

#### Course data (timing lines)
- **Built-in presets**: names and centre coordinates of 101 courses in Japan (circuits and kart tracks) and 26 circuits abroad (USA, Netherlands, France and Spain), with start/finish timing lines for 126 of them. All of this is the app's own data: centre coordinates come from the course shapes in OpenStreetMap, and timing lines were placed by checking the start line area on aerial photos (GSI in Japan; abroad, imagery each country allows to be used freely). For 3 circuits abroad the start line could not be confirmed on the photos, so the line is a placeholder in the middle of the pit lane; for 3 more, where no line was visible on the photos, the position is an estimate. Most of the kart tracks and small circuits in Japan use an estimated line perpendicular to the OpenStreetMap track, checked on the photos only to make sure it crosses the track surface. They work for splitting laps but may not match each circuit's official timing position (if the line is in a different place, lap times for the same session change slightly). 73 of them also have sector lines (SUGO uses the timing points on the official course map, Suzuka and Fuji are estimated from how races split the lap, Motegi is split into 4 equal parts, and the others into 3 equal parts as placeholders). The data is bundled as files in the DigSpice format (.cln / .sci) in [`courses/`](courses/). If a line is in the wrong place, please open a [course data issue](https://github.com/oud0n/ds_universal/issues/new?template=course.yml) (a .cln / .sci exported from the course editor helps).
- **Using your own course data**: if you own the official DigSpice software, load the course folder on your PC (the folder containing `Circuit` / `ControlLine` / `Sector`) with "コースフォルダ一括設置" (Install course folder) on the data tab. Loaded data takes priority over the built-in presets. This app does not bundle or distribute the official course data.
- **Courses without a timing line**: enter the two points (latitude and longitude) of the line in "コース編集" (Course editor) on the data tab, or load a `.cln` file. If no line is set or the car never crossed it, the data tab shows a hint.
- Sources: the built-in coordinates are based on data from [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright) ([Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/)) and on the seamless aerial photos of [GSI](https://maps.gsi.go.jp/development/ichiran.html). The data is the files in [`courses/`](courses/) (see [`courses/README.md`](courses/README.md) for how they were made). The SUGO sector positions use the distances of the timing points on [SUGO's course map](https://www.sportsland-sugo.co.jp/assets/docs/course/c-racing/2026_racing-course_layout.pdf).

### 3. Onboard video (GoPro / DJI / generic MP4) sync (`VideoSyncWindow`)
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

---

## 🔧 Technical notes

How the app talks to the logger and how the analysis works are written up here.

- [Reading the DigSpice IV GPS logger's protocol to use it from macOS (Zenn, Japanese)](https://zenn.dev/oud0n/articles/ace1347602c574) — why this app was made, and how the USB communication works
- [USB protocol analysis (Japanese)](protocol_analysis.md)
- [Bluetooth (BLE) protocol analysis (Japanese)](bluetooth_protocol_analysis.md)

---

## 🌐 Browser version

Use it straight from your browser without installing anything. Logs are loaded, analysed and converted on your device and are never sent to a server.

The app only talks to outside services to show maps (map tiles), to fetch course definitions automatically (the course centre coordinates are sent to the OpenStreetMap Overpass API), and when you open an exported map HTML file (the display script comes from unpkg.com and the map tiles from OpenStreetMap). The browser version also uses [GoatCounter](https://www.goatcounter.com/) to count visits (it sends the page opened, the referrer and similar; no cookies are used and no log contents are sent). The desktop version does not include it.

- Analysis: <https://oud0n.github.io/ds_universal/>
- Log conversion: <https://oud0n.github.io/ds_universal/#convert>

USB communication with the logger (the logger settings tab) uses the Web Serial API, so it **only works in Chrome / Edge on a PC**. In Safari, Firefox or on smartphones you can still load, analyse and convert logs.

## 📥 Download and installation

Download the latest installer / ZIP for your OS from [GitHub Releases](https://github.com/oud0n/ds_universal/releases).

| OS | Package (installer / ZIP) | Status |
| :--- | :--- | :--- |
| **Windows** | `.exe` (installer) / `.zip` (portable) | Built and published (not yet tested on real machines; see the warning above) |
| **macOS** | `.dmg` (installer) / `.zip` (Apple Silicon `arm64` only) | **Tested** |

---

### 🍎 macOS requirements

- **Macs with Apple Silicon (M1 or later) only**. Only native `arm64` binaries are provided; Rosetta 2 is not used.
- **Does not run on Intel Macs** (no `x64` build is provided).
- To confirm it runs natively: the "Kind" column in Activity Monitor shows **Apple** (it shows Intel under Rosetta).

### 🍎 macOS: if you see "is damaged and can't be opened"

When you open the app from the DMG, macOS may show the warning **"“LapLoupe” is damaged and can't be opened. You should move it to the Trash."**

#### 💡 Cause
This app is developed by an individual and is not notarized or signed through the paid Apple Developer Program.  
macOS Gatekeeper adds a quarantine flag (`com.apple.quarantine`) to unsigned, unnotarized apps downloaded from a browser, reports them as "damaged" (a BundleIntegrity warning) and kills them (SIGKILL) for protection. **The file is not actually damaged.**

#### 🚀 Fix (run in Terminal)

1. Copy `LapLoupe.app` from the DMG to your **Applications (/Applications)** folder.
2. Open **Terminal.app** and run:

```bash
xattr -cr "/Applications/LapLoupe.app"
```

##### 📖 What the command does
* `xattr`: the standard macOS command for showing and changing extended file attributes.
* `-c` (`--clear`): removes all extended attributes from the file. Removing the **quarantine attribute (`com.apple.quarantine`)** added when the browser saved the file stops Gatekeeper from blocking the launch.
* `-r` (`--recursive`): applies this to every binary, library and resource inside the app bundle (.app).

---

##### ⚠️ If it still won't open (ad-hoc signing)
Depending on the macOS security policy (macOS Sequoia / Sonoma, etc.), unsigned code may be blocked strictly. In that case, run this ad-hoc signing command in Terminal:

```bash
codesign --force --deep --sign - "/Applications/LapLoupe.app"
```

##### 📖 What the command does
* `codesign`: the macOS tool for creating and checking code signatures.
* `--force`: overwrites any existing incomplete signature.
* `--deep`: signs all embedded frameworks in the bundle (Electron Framework / Chromium, etc.) recursively.
* `--sign -`: uses an ad-hoc signature (the hyphen `-`) instead of an Apple Developer ID certificate, which allows the app to run locally.

Then double-click the app as usual, or **Control-click (right-click) it and choose "Open"**.

---

## 📝 Release notes

### v0.12.0

**App renamed**

- The app is renamed from "DS Universal" to **LapLoupe**. Saved user courses and settings carry over. The repository and the browser version URL stay the same.
- On macOS, the previous `DS Universal.app` stays in the Applications folder. After installing the new `LapLoupe.app`, move the old one to the Trash.

**Added**

- **Onboard video rework**: videos and logs are now handled together as "runs".
  - **Multi-camera**: watch one car's run from up to 4 cameras at the same time (side by side, 2×2, picture-in-picture; click a view to enlarge it).
  - **Run comparison**: shows the videos of the Car 1-4 laps at the moment each car was at the same point as Car 1. Slower laps play faster, and each view shows its own gauges and the time gap to Car 1. Align by place or by time; works with a single video too (another lap of the same video).
  - **Per-log clock correction**: fixes each logger's GPS delay. "Auto" estimates it by comparing positions with another log of the same run and only applies confident results.
  - **Same-run check**: videos are no longer attached to another car's log that merely covers the same time (a teammate in the same session).
  - **Run inspector**: one screen with each run's logs and videos, how each video is timed (GPS / synced / file time) and a map.
  - **GoPro .LRV**: load the low-res copies too and the small views play lighter.
  - **Videos with GPS** (GoPro and others): when a log of the same run is already loaded, you are asked whether to import the video GPS as another log.
- **Rebuilt video export**: videos are now encoded frame by frame instead of being recorded while playing, which is faster and drops no frames (environments without support still use the previous method). The current layout of views (with gauges and car labels) can be exported too.
- **Meters-only transparent video**: export just the gauges, without the onboard video, as a transparent PNG sequence (ZIP) or WebM to overlay in Premiere, DaVinci Resolve, After Effects and the like. Works from a log alone, without a video. This is now the default export.
- **More overlay parts**: a lap panel (best, per-sector gaps, delta) and a course map. When you export a lap, 10 seconds are added before and after it.
- **X/Y graph**: plot any two values (speed and G, for example) as points per lap to compare them.
- **Separate start and finish** (gymkhana, hill climbs): place a finish line in the course editor and each run from start to finish counts as one.
- **Unknown courses**: timing and sector lines are placed automatically from the log.
- **Lap history** (desktop app): lists past laps from the runs in your storage folder. Best in purple, 2nd in green, 3rd in amber; any lap can be hidden.
- **More formats**: FIT and TCX (Garmin and others) and CSV with a date-time column.
- **Log conversion**: export to .bon4. NMEA now keeps speed to 0.001 knots and writes back GGA fields (altitude, satellites and so on), so .bon4 → NMEA → .bon4 round-trips. NMEA without a date uses the date in the file name. For logs that keep recording while parked, you can export only the driving part.
- **Course editor**: fields for an English name and a storage folder name.
- **Interface language** follows your device (PC or phone). The manual switch moved to the globe icon next to the themes.
- **Playback bar**: playback and seeking in the graph view use the same bottom bar as the video view. The back / forward buttons move 5 seconds.
- **Phones**: the video tab is available (run comparison stacks 2 views, multi-camera switches by swiping). Desktop windows narrower than 600px also use the phone layout.
- The browser version on a PC shows where to download the desktop app.

**Fixed**

- **Safari on Mac**: videos with sound dropped frames or kept drifting while playing.
- Videos stayed black or stuttered in Safari on iPhone.
- A sub video recorded at a different time was pulled to the main video's time.
- The gauges were misplaced over the main video in split / PiP view.
- Saving and loading a sync project could lose the video positions and log clock corrections (sync projects are now format 2.0; 1.0 still loads).
- Pausing a video in the middle of a seek let the video keep playing.
- A brief sound played the first time the video tab was opened.
- Encode-based export stalled early in Safari.
- Choosing the wrong course made the whole log one lap; you are now asked and warned (#17).
- Points in .bon4 whose time does not fit (1/100 s of 99) are skipped.
- Layout problems on narrow screens (wrapping tabs, clipped course map, overlapping text and more), dialogs that Esc did not close, and playback keys acting on the screen behind a dialog.
- On phones, the buttons at the top of the video view are larger and fit in two rows, and the screens before loading a file (graph, video, conversion) now look the same.

### v0.11.0

**Added**

- **Japanese / English**: switch the interface language with JA / EN at the top right.
- **High contrast**: a high-contrast theme for reading the screen in direct sunlight.
- **iRacing telemetry (.ibt)**: compare laps driven in the game with real-car logs on the same screen. For cars that record them, throttle and brake can be overlaid at the bottom of the speed graph.
- **VBO (Racelogic) export** in log conversion.
- **More built-in courses**: timing lines for 101 courses in Japan (including kart tracks and small circuits) and 26 circuits abroad (USA, Netherlands, France and Spain); 73 of them also have sector lines. The data is in [`courses/`](courses/) as DigSpice-format files (.cln / .sci).
  - Most lines are estimated positions and may not match the official timing position. If a line is in the wrong place, please open a [course data issue](https://github.com/oud0n/ds_universal/issues/new?template=course.yml).
- **Short laps**: laps are now split on courses where a lap takes less than 15 seconds (pocket-bike tracks and the like).

**Fixed**

- **Course editor export** (#7): in the desktop app (Windows / Mac), the .sci file was not saved after the .cln.
- **iPhone / iPad**: in the browser version, logs such as .bon4 could not be picked in the file chooser (not yet checked on a real device).
- Loading an unrelated or broken file now stops with a message (it could previously add a meaningless one-point log).
- GPS jitter while standing on the timing line is no longer counted as laps.
- A log from a nearby course could get a timing line it never crosses, so laps were not split.

### v0.10.0

**Added**

- **GPS from GoPro videos**: open a video (.MP4) shot with a GoPro that records GPS (HERO5 and later) with "ファイル読込" (Open file), and the GPS recorded in the video is loaded as a driving log. The same video is added to video sync and plays already aligned by GPS time. When one recording is split into several files (chapters), select them together to get one log. If a DigSpice (or other) log of the same session is the reference car, the video is aligned by converting via the recorded times. Videos without GPS are only added to video sync.
- **AiM logs**: reads the CSV exported by Race Studio and the GPS in logger files (.xrk / .xrz).
- **MoTeC CSV**: reading the CSV exported by i2 and exporting to MoTeC CSV are now enabled.
  - MoTeC and AiM support has only been checked with sample files published on the internet, not with logs recorded on real hardware. If a file does not load correctly, please let us know in an issue.
- **Saving and loading edited courses** (#7): timing lines and sectors fixed in the course editor are saved in the app and used for later logs that cross the same timing line. Timing lines (.cln) and sectors (.sci) can also be loaded and exported.
- **Log conversion exports**:
  - Added KML (for Google Earth, line coloured by speed) and TXT (space-separated).
  - Map HTML shows time, speed, heading and position when you hover.
  - Added UTC / JST buttons for the time offset; files with times in them get `_UTC` / `_JST` and so on in their names. GPX, CSV and KML times carry the offset (such as `+09:00`).
  - The summary shows average speed and the start and end positions.
- **Friction circle**: draws a trail of the last second behind the current G point, fading towards the past.

**Fixed**

- **Onboard video** (#10, #11, #13):
  - With the bottom-left window set to "車載動画" (Onboard video), playback did not advance when no video was loaded.
  - While a video was shown, the speed and track map windows dropped to 2–3 frames per second.
  - The onboard video in the bottom-left of graph analysis sometimes did not appear.
  - The video tab and the graph screen now share the selected video and display settings instead of fighting over them.
  - After loading a sync project and choosing the video again, the saved offset is kept.
  - A video export could not be stopped right after starting.
- **Playback performance**: with logs that have many points, the parts of the graphs that do not move are no longer redrawn during playback (a 200,000-point log went from about 37 to 120 frames per second).
- GPX and binary logs with many points could not be loaded.
- The current point in the friction circle jumped at every recorded sample (G is now interpolated between samples too).
- Installing a course folder now also updates the track maps of logs already loaded.
- Built-in timing lines: Fuji, Suzuka, SUGO and Honjo were checked again on aerial photos and moved. Autopolis now uses the position suggested in #12. Because the lines moved, lap times for the same log may differ slightly from the previous version.

**Changed**

- The browser version (GitHub Pages) uses GoatCounter to count visits (no cookies, no log contents sent). The desktop version does not include it.

For earlier versions, see the [Japanese README](README.md#-リリースノート) or [GitHub Releases](https://github.com/oud0n/ds_universal/releases).

---

## 🛠️ Developer setup

### Requirements
- Node.js 20 or later
- npm 9 or later

```bash
# Clone the repository
git clone https://github.com/oud0n/ds_universal.git
cd ds_universal

# Install dependencies
npm install

# Start the dev server (browser version)
npm run dev

# Run as the Electron desktop app
npm start

# Build (type check + Vite bundle)
npm run build

# Package for each OS
npm run dist:win   # Windows (.exe, .zip)
npm run dist:mac   # macOS (.dmg, .zip / Apple Silicon arm64)
```

---

## ☕ Support the developer (Buy Me a Coffee)

**LapLoupe (formerly DS Universal, `ds_universal`)** is a personal project (free and source-available).  
Your support, from the price of a coffee ($3 and up), helps cover track days, fuel and highway tolls, keeping up the Mac version, and further work on millisecond-accurate GoPro sync and telemetry overlays. ☕🏎️

👉 **[Support oud0n on Buy Me a Coffee](https://buymeacoffee.com/oud0n)**

---

## 🚫 Features not implemented

- **The official software's drift scoring**: not implemented, because it could infringe the copyright of DigSpice Co., Ltd. (and there are no plans to implement it).
  The app used to have its own simple "drift" display, but it was removed on 2026-10-17.
- Reading and converting the logger's log data deals with the recorded data itself (position, time, speed, etc.) and the file's accompanying information; this is general analysis and is distinct from the above.

---

## ⚖️ Trademarks and disclaimer

- **Trademarks**: "デジスパイス" and "DigSpice" are trademarks or registered trademarks of DigSpice Co., Ltd. Other product and company names are trademarks or registered trademarks of their respective owners.
- **Unofficial compatible software**: this software (`ds_universal`) is an unofficial, third-party compatible tool developed by an individual. It has no relationship, partnership or endorsement of any kind with DigSpice Co., Ltd.
- **Disclaimer**: the developer accepts no responsibility for any damage or device malfunction caused by using, or being unable to use, this software. Use it at your own risk.

---

## 📜 License

[PolyForm Noncommercial License 1.0.0](LICENSE) (Copyright 2026 oud0n)

- **Free for non-commercial use**: personal use (hobby, study, research and other uses not leading to commercial gain) and use by non-profit organisations, educational institutions, public research organisations and government bodies is free, including modification and redistribution. When you redistribute, pass on `LICENSE` (or the license URL) and the `Required Notice:` line with it.
- **Commercial use requires prior permission**: if you want to use it at work, include it in a paid product or service, or sell it, please contact [caliber.trivia66@icloud.com](mailto:caliber.trivia66@icloud.com).
- **If you publish or distribute a modified version**, please make its origin clear:
  - State, somewhere users will see it such as the README, that it is based on this software ([oud0n/ds_universal](https://github.com/oud0n/ds_universal)) and that you modified it.
  - Give the modified version a different name, and do not use names or wording that could be mistaken for the official or an endorsed version.
- Versions up to v0.7.1 were published under the MIT License. Copies of v0.7.1 and earlier that you already have are not affected.
