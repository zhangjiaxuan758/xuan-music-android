#!/usr/bin/env bash
# ==================================================================
# 小轩音乐 · 闭源专有软件
# 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
# 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
# ==================================================================
XUAN_WM_71b257da7170="XUANSRC|__XUAN_SERVER_BASE__|71b257da7170|f9bff60cc22d"
export XUAN_WM_71b257da7170
# 小轩音乐 · 用 Android NDK 把真实 C++ 网络层编译成 libxuan_net.so
# 安全整改 M4：Android 端不再用内嵌 WASM，改真 .cpp → .so → JNI。
set -euo pipefail

NDK="/opt/android-ndk-dl/android-ndk-r27c"
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$(cd "$SRC_DIR/../.." && pwd)"
JNI_LIBS="$PROJ_DIR/android/app/src/main/jniLibs"
API=29

# 目标 ABI → clang target 前缀
declare -A TARGETS=(
  [arm64-v8a]="aarch64-linux-android"
  [armeabi-v7a]="armv7a-linux-androideabi"
  [x86_64]="x86_64-linux-android"
  [x86]="i686-linux-android"
)

echo "[xuan-net-so] NDK=$NDK  API=$API"
echo "[xuan-net-so] SRC=$SRC_DIR  OUT=$JNI_LIBS"

for abi in arm64-v8a armeabi-v7a x86_64 x86; do
  prefix="${TARGETS[$abi]}"
  cxx="$TOOLCHAIN/${prefix}${API}-clang++"
  if [ ! -x "$cxx" ]; then
    echo "[xuan-net-so] MISSING compiler: $cxx" >&2
    exit 1
  fi
  out="$JNI_LIBS/$abi"
  mkdir -p "$out"
  echo "[xuan-net-so] building $abi ..."
  # -static-libstdc++：把 libc++ 静态链入 SO，去掉对 libc++_shared.so 的 NEEDED 依赖。
  # Android 系统不提供 libc++_shared.so，若不随 APK 打包会导致 System.loadLibrary
  # 抛 UnsatisfiedLinkError（真机网络层全挂）。静态链入后 SO 完全自包含。
  "$cxx" -std=c++17 -O2 -fPIC -shared -fvisibility=hidden -ffunction-sections -fdata-sections \
    -static-libstdc++ \
    -Wl,--gc-sections -Wl,-z,relro -Wl,-z,now -Wl,-z,noexecstack \
    -Wl,-z,max-page-size=16384 \
    "$SRC_DIR/xuan_net.cpp" "$SRC_DIR/xuan_aes.cpp" "$SRC_DIR/xuan_net_jni.cpp" \
    -o "$out/libxuan_net.so"
  "$TOOLCHAIN/llvm-strip" --strip-unneeded "$out/libxuan_net.so" 2>/dev/null || true
  echo "[xuan-net-so]   -> $out/libxuan_net.so ($(stat -c%s "$out/libxuan_net.so") bytes)"
done

echo "[xuan-net-so] DONE"
