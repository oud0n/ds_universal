<p align="center"><img src="build/icon.svg" width="128" height="128" alt="LapLoupe icon"></p>

# LapLoupe (formerly DS Universal) — Lap / Track Analyzer

[日本語](README.md) | **English**

**An unofficial lap and track analyzer for the DigSpice GPS logger that runs on Mac, Windows and in the browser**

Log download and logger settings for DigSpice IV, racing line / speed / G analysis, and onboard video (GoPro etc.) sync

![Supported OS](https://img.shields.io/badge/OS-Windows%20x64%20%7C%20macOS%20Apple%20Silicon-blue)
![Verification](https://img.shields.io/badge/Verified-macOS%20Only-amber)
![Version](https://img.shields.io/badge/Version-1.1.0-red)
![Device](https://img.shields.io/badge/Device-DigSpice%20IV-red)
![License](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-orange)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-oud0n-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/oud0n)

> [!WARNING]
> **Tested on macOS (Apple Silicon) only.** A Windows (x64) build is also built and published automatically, but it has not been tested on real machines yet. Reports from Windows users (issues / pull requests) are very welcome.
> Linux and Intel Macs (including Rosetta 2) are not supported, and no builds are provided for them.

> [!NOTE]
> On 2026-10-19 the app was renamed from "DS Universal" to **LapLoupe**. The repository name (`ds_universal`) and the browser version's URL stay the same.

The app's screens are available in Japanese and English (it follows your device's language; switch with the globe icon).

---

## 🏎️ Overview

**LapLoupe (formerly DS Universal)** is an unofficial lap and track analyzer for the DigSpice IV, a GPS data logger for circuit driving. The official analysis software runs only on Windows; LapLoupe runs on **Mac, Windows and in the browser**, and you can also view logs in a smartphone browser.

- Connect the DigSpice over USB to download logs and change the logger's settings (works on a Mac too)
- Overlay and compare the driving line, speed, G and corner speeds between laps and cars
- Sync onboard video from a GoPro and other cameras with the log automatically, and export video with gauges
- Free and source-available. Logs are processed on your device and never sent to a server

---

## ✨ Features

| Area | What it does |
| :--- | :--- |
| **Logger** | USB connection to the DigSpice IV, log download (`.bnx4`), sampling rate (5 / 10 / 20 Hz) and logging start speed settings, erasing the logger's memory |
| **Analysis** | speed graph comparison of up to 4 cars (4 laps), track map and driving line (with GSI aerial photos as the background), G and friction circle, corner analysis, braking analysis, line difference heat map, X/Y graph |
| **Run library** (desktop app) | list of the runs in your storage folder by date, importing logs split by run and circuit, lap time records, corner names (`corners.json`) |
| **Course data** | 101 courses in Japan and 26 circuits abroad built in, automatic timing and sector lines for unknown courses, course editor, loading the official software's course folder |
| **Onboard video** | automatic sync of GoPro / DJI / generic MP4 with the log, seamless playback of GoPro chapter files, multi-camera view of up to 4 cameras, lap-to-lap comparison, export of video with gauges or of transparent gauge-only video |
| **Import formats** | DigSpice (.bnx4 / .bon4), Racelogic VBO, RaceChrono CSV, GPX, NMEA, MoTeC CSV, AiM (CSV, .xrk / .xrz), Garmin FIT / TCX, RaceBox, iRacing (.ibt), GPS from GoPro videos |
| **Log conversion** | export to NMEA, GPX, VBO, CSV, KML, DTB, MoTeC CSV, map HTML, .bon4 and more; cut out laps or time ranges, adjust the time zone |

See **[Features](docs/features.en.md)** for the details.

---

## 📸 Screenshots

**Graph analysis**: speed graph, track map (with GSI aerial photos as the background; it can follow the car close up and start all cars from a sector), friction circle

![Graph analysis](docs/images/analysis.png)

**Corner analysis and lap comparison**: speed, time delta and line difference between two laps; entry, minimum and exit speed for each corner

![Corner analysis](docs/images/corner_analysis.png)

**Log conversion**: cut out part of a log (a lap or a time range) and export it to NMEA / GPX / CSV / map HTML and more

![Log conversion](docs/images/convert.png)

**Logger settings**: connect the logger over USB to change the sampling rate and the logging start speed, and to download logs

![Logger settings](docs/images/logger.png)

---

## 🌐 Browser version (no installation)

- Analysis: <https://oud0n.github.io/ds_universal/>
- Log conversion: <https://oud0n.github.io/ds_universal/#convert>

USB communication with the logger **only works in Chrome / Edge on a PC** (it uses the Web Serial API). In Safari, Firefox or on smartphones you can load, analyse and convert logs.
Logs are processed on your device and never sent to a server (what the app does connect to, such as map tiles, is listed in [Features](docs/features.en.md#-what-the-browser-version-connects-to)).

---

## 📥 Download and installation

Download the latest version for your OS from [GitHub Releases](https://github.com/oud0n/ds_universal/releases).

| OS | Files | Status |
| :--- | :--- | :--- |
| **Windows** (x64) | `.exe` (installer) / `.zip` (portable) | Published (not yet tested on real machines) |
| **macOS** (Apple Silicon `arm64`) | `.dmg` (installer) / `.zip` | **Tested** |

### 🍎 macOS: if you see "is damaged and can't be opened"

From v1.0.2 the Mac version is signed and notarized by Apple, so it opens normally. Only if an older version shows this message, open it as follows (the file is not actually damaged).

1. Copy `LapLoupe.app` from the DMG to your Applications folder.
2. Run this command in Terminal.app (it removes the mark added when the file was downloaded):

```bash
xattr -cr "/Applications/LapLoupe.app"
```

If it still won't open, run this command, then Control-click the app and choose "Open":

```bash
codesign --force --deep --sign - "/Applications/LapLoupe.app"
```

- **Macs with Apple Silicon (M1 or later) only.** It does not run on Intel Macs.
- What the commands do, and more steps if it still fails, are in **[Installation](docs/install.en.md)**.

---

## 📚 Documentation

| Document | Contents |
| :--- | :--- |
| [Features](docs/features.en.md) | details of each feature, where the course data (timing lines) comes from, features not implemented |
| [Installation](docs/install.en.md) | requirements, detailed steps when the app won't open on macOS |
| [Release notes](docs/release-notes.en.md) | changes in each version (latest: v1.1.0) |
| [Developer setup](docs/development.en.md) | running, building and packaging from source |
| [Developer documents](docs/README.md) | architecture, procedures, design notes and open items (Japanese; for developers and AI agents) |
| [Course data](courses/README.md) | the built-in course files and how they were made (Japanese) |
| [Zenn article (Japanese)](https://zenn.dev/oud0n/articles/ace1347602c574) | why this app was made, and how the DigSpice's USB communication works |

Report bugs or send requests in [Issues](https://github.com/oud0n/ds_universal/issues). If a timing line is in the wrong place, please open a [course data issue](https://github.com/oud0n/ds_universal/issues/new?template=course.yml).

---

## ☕ Support the developer (Buy Me a Coffee)

LapLoupe is a free, personal project. Your support, from the price of a coffee ($3 and up), helps cover track days, keeping up the Mac version, and further work on the video features.

👉 **[Support oud0n on Buy Me a Coffee](https://buymeacoffee.com/oud0n)**

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
