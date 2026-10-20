# Release notes

[日本語](release-notes.md) | **English**

[Back to the README](../README.en.md)

## v0.12.0

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

## v0.11.0

**Added**

- **Japanese / English**: switch the interface language with JA / EN at the top right.
- **High contrast**: a high-contrast theme for reading the screen in direct sunlight.
- **iRacing telemetry (.ibt)**: compare laps driven in the game with real-car logs on the same screen. For cars that record them, throttle and brake can be overlaid at the bottom of the speed graph.
- **VBO (Racelogic) export** in log conversion.
- **More built-in courses**: timing lines for 101 courses in Japan (including kart tracks and small circuits) and 26 circuits abroad (USA, Netherlands, France and Spain); 73 of them also have sector lines. The data is in [`courses/`](../courses/) as DigSpice-format files (.cln / .sci).
  - Most lines are estimated positions and may not match the official timing position. If a line is in the wrong place, please open a [course data issue](https://github.com/oud0n/ds_universal/issues/new?template=course.yml).
- **Short laps**: laps are now split on courses where a lap takes less than 15 seconds (pocket-bike tracks and the like).

**Fixed**

- **Course editor export** (#7): in the desktop app (Windows / Mac), the .sci file was not saved after the .cln.
- **iPhone / iPad**: in the browser version, logs such as .bon4 could not be picked in the file chooser (not yet checked on a real device).
- Loading an unrelated or broken file now stops with a message (it could previously add a meaningless one-point log).
- GPS jitter while standing on the timing line is no longer counted as laps.
- A log from a nearby course could get a timing line it never crosses, so laps were not split.

## v0.10.0

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

For earlier versions, see the [Japanese release notes](release-notes.md#v090) or [GitHub Releases](https://github.com/oud0n/ds_universal/releases).
