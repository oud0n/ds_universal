# Download and installation

[日本語](install.md) | **English**

[Back to the README](../README.en.md)

Download the latest installer / ZIP for your OS from [GitHub Releases](https://github.com/oud0n/ds_universal/releases).

| OS | Package (installer / ZIP) | Status |
| :--- | :--- | :--- |
| **Windows** | `.exe` (installer) / `.zip` (portable) | Built and published (not yet tested on real machines; see the warning in the [README](../README.en.md)) |
| **macOS** | `.dmg` (installer) / `.zip` (Apple Silicon `arm64` only) | **Tested** |

---

## 🍎 macOS requirements

- **Macs with Apple Silicon (M1 or later) only**. Only native `arm64` binaries are provided; Rosetta 2 is not used.
- **Does not run on Intel Macs** (no `x64` build is provided).
- To confirm it runs natively: the "Kind" column in Activity Monitor shows **Apple** (it shows Intel under Rosetta).

## 🍎 macOS: if you see "is damaged and can't be opened"

When you open the app from the DMG, macOS may show the warning **"“LapLoupe” is damaged and can't be opened. You should move it to the Trash."**

### 💡 Cause

**From v1.0.2 the Mac version is signed with a Developer ID and notarized by Apple, so this warning does not appear.** The rest of this section is for older versions.

This app is developed by an individual and is not notarized or signed through the paid Apple Developer Program.  
macOS Gatekeeper adds a quarantine flag (`com.apple.quarantine`) to unsigned, unnotarized apps downloaded from a browser, reports them as "damaged" (a BundleIntegrity warning) and kills them (SIGKILL) for protection. **The file is not actually damaged.**

### 🚀 Fix (run in Terminal)

1. Copy `LapLoupe.app` from the DMG to your **Applications (/Applications)** folder.
2. Open **Terminal.app** and run:

```bash
xattr -cr "/Applications/LapLoupe.app"
```

#### 📖 What the command does
* `xattr`: the standard macOS command for showing and changing extended file attributes.
* `-c` (`--clear`): removes all extended attributes from the file. Removing the **quarantine attribute (`com.apple.quarantine`)** added when the browser saved the file stops Gatekeeper from blocking the launch.
* `-r` (`--recursive`): applies this to every binary, library and resource inside the app bundle (.app).

---

#### ⚠️ If it still won't open (ad-hoc signing)
Depending on the macOS security policy (macOS Sequoia / Sonoma, etc.), unsigned code may be blocked strictly. In that case, run this ad-hoc signing command in Terminal:

```bash
codesign --force --deep --sign - "/Applications/LapLoupe.app"
```

#### 📖 What the command does
* `codesign`: the macOS tool for creating and checking code signatures.
* `--force`: overwrites any existing incomplete signature.
* `--deep`: signs all embedded frameworks in the bundle (Electron Framework / Chromium, etc.) recursively.
* `--sign -`: uses an ad-hoc signature (the hyphen `-`) instead of an Apple Developer ID certificate, which allows the app to run locally.

Then double-click the app as usual, or **Control-click (right-click) it and choose "Open"**.
