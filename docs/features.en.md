# LapLoupe features

[日本語](features.md) | **English**

[Back to README](../README.en.md)

What works as of 1.1.0 (2026-10-27). Changes per version are in the [release notes](release-notes.en.md); step-by-step help is in the app's "Help" (browser version: https://oud0n.github.io/ds_universal/help/).

## What each version can do

| Feature | Browser | Desktop (Mac / Windows) | iPhone / iPad app |
|---|---|---|---|
| Load, analyze and convert logs; sync and export onboard video | ✓ | ✓ | ✓ |
| DigSpice USB (download logs, settings) | Chrome / Edge (PC) | ✓ | − |
| Bluetooth devices (DigSpice, RaceBox, GoPro, …) | Chrome (PC / Android) | ✓ | ✓ |
| Run library (storage folder, lap time list, names and notes, saved comparisons) | − (comparisons as files) | ✓ | ✓ (iCloud Drive or other folders) |
| Lap timer (measure while driving) | − | − | ✓ (phone GPS, DigSpice, …; record with the built-in camera) |
| Meter layout editor | ✓ (PC) | ✓ | choose a layout only |

The iPhone / iPad app was submitted to App Store review on 2026-10-27. The Android app is a test version.

## 1. Loggers and devices

- **DigSpice IV over USB**: download logs (official-compatible `.bnx4`), change the sampling rate (5 / 10 / 20 Hz) and the recording start speed (read back from the device to confirm), erase the device memory (with a lock against mistakes). No driver needed.
- **Bluetooth (BLE)**: DigSpice IV Bluetooth, RaceBox Mini / Micro, Drogger (BLE), heart-rate monitors, OBD-II (ELM327), GoPro (HERO9 and later; starts recording when timing starts and stops at the end). Register them on the devices screen with a display name and a file name. RaceBox, heart-rate, OBD-II and BLE Drogger follow public documentation and have not been tested with real devices.
- **Android test version**: also Bluetooth Classic GPS (Drogger DG-PRO1S, …).

## 2. Run library (apps and desktop)

- **Storage folder**: runs are kept as `<circuit>/<date>/` in a folder you choose and listed by date. Pick an iCloud Drive folder on the iPhone and open the same runs on the desktop.
- **Import**: a log that covers several circuits is split per run and circuit.
- **Run details**: name, note, car, tyre, weather (dry / damp / wet / heavy wet), air and track temperature. File names do not change; the details go to `runs.json`.
- **Filters**: filter the run list and the lap time list by car, tyre and weather (best laps and ranks are counted within the filter).
- **Lap time list**: lap, sector and top-speed per lap; in driven order or by time; hide laps.
- **Reference laps**: keep other people's runs (video-only ones too) separately and compare against them; they are not counted as your best. Video-only runs get laps by marking the timing line in the video.
- **Saved comparisons**: save the Car 1–4 assignment of Analysis and reopen it later. If timing lines change, laps are matched again by their start time.
- **Delete a run**: deletes only that run's files and records (other runs of the same day and shared videos are kept; goes to the Trash / Recently Deleted).

## 3. Lap timer (iPhone / iPad app)

- **Position source**: phone GPS (filled to 10 Hz with the motion sensor), DigSpice IV (BLE), RaceBox, Drogger.
- **Timing**: large start / stop buttons, automatic course detection, laps, sectors, delta, spoken lap times, screen orientation held while timing. Runs where you did not drive can be discarded.
- **Built-in camera**: record while timing (front camera too, brightness compensation, focus lock). The video is placed next to the run and opens already synced. If the phone gets too hot, only the recording stops.
- **Sensor logs**: heart-rate / OBD-II values go to `<run>.<name>.csv`, the motion sensor to `<run>.iphone_imu.csv`.

## 4. Analysis

- **Speed graph**: up to 4 cars (laps) by distance or time, delta, sector lines, value strips (throttle, brake, rpm, CSV values and formulas, each with its own scale).
- **Track map**: driving line over GSI aerial photos or maps; color by car, speed, acceleration or line deviation; follow mode (zoomed in); start all cars from a sector; corner numbers and names (`course/Corner/`).
- **G**: friction circle, longitudinal / lateral G (same calculation as the official software), turning radius.
- **Corner analysis and braking**: entry / minimum / exit speed per corner; braking point, peak deceleration, trail braking.
- **X/Y graph**, altitude, per-log clock correction (estimates each device's GPS delay), distance offset and lap length alignment.
- **Layout**: adapts to the screen width (phone, medium for iPad portrait and the open iPhone Duo, desktop).

## 5. Onboard video

- **Sync**: automatic by GPS time and the video's recording time (time zone detection), manual (offset field, sync pins), GoPro GPS in the video, continuous playback of GoPro chapter files, .LRV.
- **Watch / compare / sync**: up to 4 cameras, run comparison (Car 1–4 aligned at the same point), jump to the laps shown in the video.
- **Videos in the storage folder**: read only the parts needed, so multi-GB videos open quickly.

## 6. Meters and export

- **Meter layout**: drag, add, remove and resize parts (speed, G, lap panel, delta bar, track map, zoomed map, value bars, steering, graph strip, images, …). Templates (standard, more data, graph, minimal), a layout for small frames, and the layout is remembered per run. Build layouts on a computer; the apps choose one.
- **Export**: MP4 with meters burned in (frame-by-frame encoding: no dropped frames, faster than real time) or recorded during playback; meters only with transparency (PNG sequence ZIP, WebM); export the current layout of views. Range: lap, whole, or a time range.

## 7. CSV formats and formulas

- Define what each CSV column is (value, unit, time format) on a computer and save it to `formats/` in the storage folder; files are then read automatically (including `<run>.<name>.csv` next to a run).
- Formulas build new values (arithmetic, comparisons, min / max / abs / sqrt / round). Values can be shown in value strips and video meters.

## 8. Import and convert

- **Formats**: DigSpice (.bnx4 / .bon4 / .dtb), NMEA, Racelogic VBO, RaceChrono CSV, GPX, MoTeC CSV, AiM (CSV, GPS in .xrk / .xrz), Garmin FIT / TCX, RaceBox (VBO / GPX / CSV), iRacing (.ibt), GPS in GoPro videos.
  - MoTeC, AiM, FIT, TCX and RaceBox CSV were checked only with public samples or specifications. Please open an Issue if a file does not load.
  - iRacing is for comparing game and real driving on the same course (throttle, brake, steering, rpm and gear are read too).
- **Convert**: NMEA (GGA + RMC), GPX, VBO, CSV, TXT, KML (line colored by speed), DTB, map HTML, MoTeC CSV, .bon4, DigSpice-style run CSV (with G) and lap list CSV. Whole log, one lap or a time range; time zone adjustment.

## 9. Courses

- **Built-in presets**: names and centre coordinates of 101 courses in Japan (circuits and kart tracks) and 26 circuits abroad (USA, Netherlands, France and Spain), with start/finish timing lines for 126 of them. All of this is the app's own data: centre coordinates come from the course shapes in OpenStreetMap, and timing lines were placed by checking the start line area on aerial photos (GSI in Japan; abroad, imagery each country allows to be used freely). For 3 circuits abroad the start line could not be confirmed on the photos, so the line is a placeholder in the middle of the pit lane; for 3 more, where no line was visible on the photos, the position is an estimate. Most of the kart tracks and small circuits in Japan use an estimated line perpendicular to the OpenStreetMap track, checked on the photos only to make sure it crosses the track surface. They work for splitting laps but may not match each circuit's official timing position (if the line is in a different place, lap times for the same session change slightly). 73 of them also have sector lines (SUGO uses the timing points on the official course map, Suzuka and Fuji are estimated from how races split the lap, Motegi is split into 4 equal parts, and the others into 3 equal parts as placeholders). The data is bundled as files in the DigSpice format (.cln / .sci) in [`courses/`](../courses/). If a line is in the wrong place, please open a [course data issue](https://github.com/oud0n/ds_universal/issues/new?template=course.yml) (a .cln / .sci exported from the course editor helps).
- **Using your own course data**: if you own the official DigSpice software, load the course folder on your PC (the folder containing `Circuit` / `ControlLine` / `Sector`) with "コースフォルダ一括設置" (Install course folder) on the data tab. Loaded data takes priority over the built-in presets. This app does not bundle or distribute the official course data.
- **Courses without a timing line**: enter the two points (latitude and longitude) of the line in "コース編集" (Course editor) on the data tab, or load a `.cln` file. If no line is set or the car never crossed it, the data tab shows a hint.
- Sources: the built-in coordinates are based on data from [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright) ([Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/)) and on the seamless aerial photos of [GSI](https://maps.gsi.go.jp/development/ichiran.html). The data is the files in [`courses/`](../courses/) (see [`courses/README.md`](../courses/README.md) for how they were made). The SUGO sector positions use the distances of the timing points on [SUGO's course map](https://www.sportsland-sugo.co.jp/assets/docs/course/c-racing/2026_racing-course_layout.pdf).
- **Your own courses**: timing line, separate finish line, sector lines and a folder name set in the course editor are saved to `course/` in the storage folder and shared between devices.

## 10. Help and other

- **Help pages**: task-based help (18 pages, Japanese and English, steps and photos per device) and how-to videos. "Help" in the app opens the page for the current screen.
- Japanese / English; dark, light and high-contrast themes.

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
