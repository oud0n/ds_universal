# Developer setup

[日本語](development.md) | **English**

[Back to the README](../README.en.md)

## Requirements
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
