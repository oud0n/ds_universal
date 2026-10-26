# Release notes

[日本語](release-notes.md) | **English**

[Back to the README](../README.en.md)

## v1.1.1 (in preparation)

**Improved**

- **Video export**: the encode method (frame by frame, faster) can now be chosen for videos of runs opened from the storage folder too. Before, it was only available for videos opened by picking the file, and those runs fell back to recording while playing (iPhone and desktop).
- **Meters in small frames**: narrow video frames (such as iPhone portrait) now show a small course map in the top-left corner.

## v1.1.0

**Added**

- **Guide pages and videos**: task-based guide pages (18 pages in Japanese and English, with steps and screenshots for iPhone, Android, desktop and browser) and 8 how-to videos. Open the page for the current screen from Guide in the app's settings, the left column on PC and tablet, or the lap timer menu.
- **iPad**: the iPhone app now runs on iPad too (portrait and landscape, laid out for the screen width).
- **Folding iPhone (iPhone Duo)**: when unfolded, the graph, video and track map sit side by side. Folding or unfolding keeps playback going and does not rebuild the panels.
- **Meter layout**: drag, add, remove and resize the video gauges, save layouts by name and remember one per run. Includes template layouts, a layout for small tiles, a zoomed map around the car and an image part for logos.
- **Export range**: export video by lap, the whole run, or a time range.
- **CSV formats and formulas**: define on the PC what each column of another device's CSV means (throttle, brake, RPM, coolant, ...) and save it in the storage folder. It is then used automatically when opening files and runs (<run>.<name>.csv next to the run). Formulas create new values from existing ones. Show values as "strips" with their own scales under the speed graph, and on the video gauges.
- **Organising runs**: add a name, note, car, tyres, weather (dry, damp, wet, heavy wet), air and track temperature to runs. Filter the run list and lap times by car, tyres and weather (bests are counted within the filter).
- **Reference laps**: keep other people's runs (including video-only ones) apart as reference laps and compare them with your laps. For video-only ones, mark the timing line on the video to build laps.
- **Saved comparisons**: save the Car 1–4 assignment in Analysis and reopen it later (the browser version exports and imports a file).
- **Deleting runs**: delete just one run's files and record from the Runs screen (other runs on the same day stay).
- **Lap timer**:
  - Record video with the iPhone's camera while timing (the front camera too; exposure compensation and fixed focus).
  - When timing with the iPhone's GPS, the motion sensor fills the gaps for 10 Hz positions. Analysis also uses those motion-sensor values for G.
  - Runs stopped without driving ask whether to delete them.
- **Phone analysis**: a Video tab in the lower pane (watch Car 1's video).

**Changed**

- The lap timer's screen orientation switch (auto / portrait / landscape) is gone. Orientation follows the device and is locked only while timing (on the folding iPhone it could get stuck).
- The analysis animation window was merged into the track window.
- The zoomed map now keeps north up by default, like the track map (heading-up is still available).
- Checkboxes are bigger on touch screens.

**Fixed**

- Opening a run while iCloud was downloading a large video could leave the run list stuck on "Loading".
- Opening another run during playback could leave the previous run's video; while videos download from iCloud, their progress is shown.
- Reading DigSpice course data in the storage folder is faster (it slowed opening down when the files were only in iCloud; setting the digspice folder to "Keep Downloaded" in Files makes it faster still).
- Other small fixes found in review.

## v1.0.3

**Added**

- **Video**: a mute / unmute button in the playback bar. The choice is remembered on this device.
- **Video**: a full-screen button in the playback bar (hides the top toolbar and shows only the video and the playback bar).
- **Runs**: opening a run at a different circuit removes the previous circuit's logs from "Runs & course" (open Nikko, then Sodegaura, and only Sodegaura is left). Runs at the same circuit stay as before, and the run you opened last becomes Car 1.
- **iPhone app**: fuel tips (in-app purchase: 1 L, 5 L, 10 L). Tipping does not unlock anything.
- **course/ folder in your storage**: following the DigSpice course folder, the storage folder now has course/ (Circuit/ track maps, ControlLine/ timing lines, Sector/ sector lines, Corner/ corners). Corner names live in course/Corner/ (the old files are copied there the first time).
- **Courses edited in the course editor** are also written to course/, so your other devices (iPhone and Mac) use them too. When the same course is edited on two devices, the later save wins.
- **Remove installed courses**: a button in "Runs & course" removes the course data installed from a folder and goes back to the built-in courses.
- **Built-in courses**: 47 more courses (mostly kart tracks) got provisional 3-way sector lines; Nikko, Sodegaura and Tsukuba 2000 got corner names.

**Changes**

- **New format for run records (runs.json)**: one row per run; video sync changes for compared runs (Car 2–4) are now saved to their own run (they were not saved before), and sync pins are saved per video. Old records are still read; a run is rewritten in the new format only when its content changes (not when you just open it).
  - Versions 1.0.2 and earlier do not use the attached videos and sync of runs in a folder that has the new format (nothing is deleted). Please update to 1.0.3.
- **Corner editing**: in "Edit corners" on the track map, drag along the line to make that stretch one corner. Use it to join a compound corner or to redo corners that were joined.
- **DigSpice course data**: for a course that is also built in, only the DigSpice track map is used; the timing line, sector lines and corners come from the built-in course. A digspice/ folder (the DigSpice folder) in your storage is read at startup.

**Fixes**

- With DigSpice course data installed, courses without a DigSpice sector file (e.g. Sodegaura) showed no sector times in video and analysis.
- The circuit preset menu in "Runs & course" overflowed its card on desktop too.
- Split runs could get different part numbers in .bon4 and .nmea.

- In Runs, "Add as Car 2" could stay disabled ("Only runs on the same course can be compared") for a run at the same circuit.
- With your own edited copy of a built-in circuit, your corner names were not shown (C1… instead).
- English UI: the circuit filter in Runs and the run detail heading were in Japanese.
- Runs imported from the Runs screen did not show up until you switched screens.
- Phone: the Single / Grid / PinP buttons in video Compare did nothing and are now hidden; you can return from Compare to Watch without a video; import buttons no longer wrap mid-word.
- Phone: with a DigSpice registered, the ⚙ button was pushed off screen on Analysis.
- Lap timer: your own courses are listed in the course picker.
- Playback stops when the app goes to the background, so the video no longer jumps back when you return.
- The video toolbar wraps instead of hiding buttons; card borders are visible in the high-contrast theme.
- The "same course" check treated different circuits whose names differ only outside the brackets (e.g. two "… (East)" layouts), and unsorted runs, as the same course.
- Runs before 9:00 in the morning (Japan time) showed the previous day in Convert and in the video run inspector.
- Runs without a course no longer show "0 laps" in Runs; they show "No course (laps counted when opened)".
- When you import several files at once, the import sheet shows which file it is ("2/3").
- A compared run's (Car 2–4) video did not show in Compare when it had the same file name as Car 1's video (e.g. GoPro GX010017.MP4).
- If the screen was hidden while exporting the video layout, a cut-short video was saved; the export now stops and tells you.
- Runs timed with an old own course without a storage folder name could go to a different folder from its corner names.
- iPhone app: in landscape, the left and right edges were hidden behind the notch; pinch zoom is disabled.
- iPhone app: the screens are bundled in the app, so it starts without a connection (the previous version's saved data is copied once on first launch, including the preview page's data).
- With DigSpice course data in your storage (New Tokyo Circuit etc.), a log from a nearby built-in circuit (Sodegaura etc.) was imported as an unknown place into unsorted/.
- Opening a log file that is already in your storage with Open file now opens it like a run from Runs (it used to be added next to another circuit's logs).
- Desktop: runs that are only in iCloud (not yet downloaded to this Mac) could disappear from the list, and their lap cache and hidden-lap marks could be lost.

## v1.0.2

**Changes**

- **Video "Compare"** (especially in the iPhone app): less stutter when two videos play side by side. The audible Car 1 video now drives the playback clock, and Car 2–4 no longer change playback rate in tiny steps. In a 60-second test on a real iPhone, Car 1 frame stalls went from 7 to 0, and Car 2 from about 30 per minute to 1–2.
- **Video "Compare"**: "All" now switches to "Watch" and shows the whole run (before, it did nothing and stayed on the lap).
- **English display**: the runs list and the circuit filter showed Japanese circuit names. Built-in courses that are not in the English name table (about 120) are now shown with their English names, and notes such as "(カート)" and "(ユーザー設置)" are translated. Storage folder names do not change.

**iPhone app**

- Added the app icon and made the app ready for TestFlight.

## v1.0.1

**Changes**

- **Analysis "Runs and course"**: a run's name can now only be changed with the pencil button next to it (so a stray tap no longer edits it). Press Enter to confirm or Esc to cancel. Each run card can be folded with the ">" to the left of its name. The header wraps in narrow panels so the name and the clock correction are no longer squeezed.
- **iPhone app**: when a folder such as iCloud Drive is chosen as storage, run files are now moved to that folder instead of also being kept on the iPhone. Before, runs deleted in the folder (such as `unsorted/`) came back the next time the app was opened. Copies left on the iPhone by earlier versions that are missing from the folder are put back once, the first time this version opens; delete them again if you don't need them. Switching storage back to "This iPhone" leaves the moved runs in the folder.

**Fixes**

- iPhone app: changing a Car while "Compare" was open on the video screen could leave a video black.
- iPhone app: sharing a run that exists only in iCloud (for example as NMEA) froze the screen until it was downloaded.

## v1.0.0

**New layout**

- Screens are now switched from a sidebar on the left (desktop app), tabs at the top (browser) or tabs at the bottom (phone). Settings live under ⚙, which closes again when pressed a second time.
- **Runs screen** (desktop app): lists the runs in your storage folder by date. Pick a run to see its laps and the videos in the same folder, then open it in analysis, watch the video or add it as Car 2. Thousands of runs load quickly, and runs with no laps or videos are folded away. Choose the storage folder in Settings.
- **"Runs & course" in analysis**: the loaded runs, car slots, course and clock correction open in a drawer above the analysis.
- **Video screen**: switch between Watch / Compare / Align / Export to show only the tools you need.

**Added**

- **Importing logs** (desktop app): with a storage folder set, opening a log asks whether to import it, split by run and by circuit. A log that covers two circuits is filed into each circuit's folder and date folder. NMEA sentences are copied as they are, and the original file is kept untouched in `取り込み元/`. Existing files are never overwritten. Logs downloaded from the DigSpice over USB work the same way. You can also just open the log without importing it.
- **Corner names**: use "Edit corners" on the course map to name, merge, split, delete or add corners (tap the map). Names are saved to `corners.json` in the course folder and shown in the corner table and on the course map. Courses without names get C1… names automatically when a run is opened.
- **Opening a run makes it Car 1**: a run opened from the Runs screen becomes Car 1 (its fastest lap that is not hidden) and starts at the beginning of the lap. Cars from other courses are removed, and only runs on the same course can be added as Car 2–4.
- **Where runs are kept**: runs go into `circuit folder/date folder/` and `.nmea` is now the main file of a run. Whether to also write `.bon4` for the official DigSpice software is a setting (on by default).
- **First-run guide**: the Runs screen explains how to choose a storage folder and open files.

**Fixed**

- Video: after moving outside a lap in the whole-session view and switching to a lap (L◯), the video did not jump to the lap start and looked out of sync.
- Video: changing Car 1 to another run in analysis left the previous run's video on screen.
- Exported videos: two-digit lap labels overlapped the lap time.
- The top bar changed height between screens. On phones, "Open file" is now "Open".
- In run details, hiding and showing laps quickly in a row sometimes did not stick.

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
