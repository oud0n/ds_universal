#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

root=$(cd "$(dirname "$0")/.." && pwd)
fixtures="$root/scripts/tests/bridge"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

check_ios() {
  # WebView に送る文字列を受け取れるよう、WebKit だけを模擬の窓口に置き換える。
  sed '/^import WebKit$/d' "$root/mobile/ios/DSUniversal/NativeBridge.swift" > "$scratch/NativeBridge.swift"
  swiftc -swift-version 6 -module-cache-path "$scratch/cache" -o "$scratch/swift-check" \
    "$fixtures/swift/"*.swift "$scratch/NativeBridge.swift"
  "$scratch/swift-check"
}

check_android() {
  local gradle_dir="${GRADLE_HOME:-}" distribution cache directory java_bin cp
  if [[ -z "$gradle_dir" ]]; then
    distribution=$(sed -n 's|^distributionUrl=.*/\(gradle-.*\)-bin.zip$|\1|p' "$root/mobile/android/gradle/wrapper/gradle-wrapper.properties")
    cache="${GRADLE_USER_HOME:-$HOME/.gradle}/wrapper/dists/$distribution-bin"
    for directory in "$cache"/*/"$distribution"; do
      if [[ -d "$directory/lib" ]]; then gradle_dir="$directory"; break; fi
    done
  fi
  if [[ -z "$gradle_dir" || ! -d "$gradle_dir/lib" ]]; then
    echo "Set GRADLE_HOME to an installed Gradle distribution, or use an existing Android Gradle wrapper cache." >&2
    return 1
  fi
  local gson=("$gradle_dir"/lib/gson-[0-9]*.jar)
  local stdlib=("$gradle_dir"/lib/kotlin-stdlib-[0-9]*.jar)
  local compiler=("$gradle_dir"/lib/kotlin-compiler-embeddable-[0-9]*.jar)
  if [[ ${#gson[@]} != 1 || ${#stdlib[@]} != 1 || ${#compiler[@]} != 1 ]]; then
    echo "Gradle must include the Kotlin compiler, Kotlin stdlib and Gson." >&2
    return 1
  fi
  java_bin="${JAVA_HOME:+$JAVA_HOME/bin/}java"
  cp="${stdlib[0]}:${gson[0]}"
  "$java_bin" -cp "$gradle_dir/lib/*" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
    -no-stdlib -no-reflect -classpath "$cp" -d "$scratch/kotlin-check.jar" \
    "$root/mobile/android/app/src/main/java/io/github/oud0n/laploupe/NativeBridge.kt" "$fixtures/kotlin/"*.kt
  "$java_bin" -cp "$scratch/kotlin-check.jar:$cp" test.CheckKt
}

case "${1:-all}" in
  ios) check_ios ;;
  android) check_android ;;
  all) check_ios; check_android ;;
  *) echo "Usage: $0 [ios|android|all]" >&2; exit 2 ;;
esac
