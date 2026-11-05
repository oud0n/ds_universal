#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# アプリと同じ窓口を、制御できる取引の列にだけ差し替えて試す。
sed '/^import StoreKit$/d' "$root/mobile/ios/DSUniversal/IapModule.swift" > "$scratch/IapModule.swift"
swiftc -swift-version 6 -module-cache-path "$scratch/cache" -o "$scratch/check" \
  "$root/scripts/tests/iap/FakeStoreKit.swift" "$scratch/IapModule.swift" "$root/scripts/tests/iap/Check.swift"
"$scratch/check"
