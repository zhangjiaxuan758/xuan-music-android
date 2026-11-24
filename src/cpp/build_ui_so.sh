#!/usr/bin/env bash
# ==================================================================
# 小轩音乐 · 闭源专有软件
# 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
# 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
# ==================================================================
XUAN_WM_98f72bd7b19a="XUANSRC|__XUAN_SERVER_BASE__|98f72bd7b19a|5241f17bf2a8"
export XUAN_WM_98f72bd7b19a
# 小轩音乐 · 自研原生渲染引擎 libxuan_ui.so 构建脚本
# 真实依赖：GLES2 / EGL / android(ANativeWindow,AndroidBitmap) / m —— 全部 Android 系统库。
# 不使用任何第三方库、不链接 libc++_shared（静态链入）。
set -euo pipefail

NDK="/opt/android-ndk-dl/android-ndk-r27c"
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
SYSROOT="$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$(cd "$SRC_DIR/../.." && pwd)"
JNI_LIBS="$PROJ_DIR/android/app/src/main/jniLibs"
API=29

declare -A TARGETS=(
  [arm64-v8a]="aarch64-linux-android"
  [armeabi-v7a]="armv7a-linux-androideabi"
  [x86_64]="x86_64-linux-android"
  [x86]="i686-linux-android"
)

echo "[xuan-ui] NDK=$NDK  API=$API"
echo "[xuan-ui] SRC=$SRC_DIR  OUT=$JNI_LIBS"

for abi in arm64-v8a armeabi-v7a x86_64 x86; do
  prefix="${TARGETS[$abi]}"
  cxx="$TOOLCHAIN/${prefix}${API}-clang++"
  if [ ! -x "$cxx" ]; then echo "[xuan-ui] MISSING $cxx" >&2; exit 1; fi
  out="$JNI_LIBS/$abi"; mkdir -p "$out"

  # 链接库目录：按 ABI 选择
  case "$abi" in
    arm64-v8a) libdir="$SYSROOT/usr/lib/aarch64-linux-android/$API" ;;
    armeabi-v7a) libdir="$SYSROOT/usr/lib/arm-linux-androideabi/$API" ;;
    x86_64) libdir="$SYSROOT/usr/lib/x86_64-linux-android/$API" ;;
    x86) libdir="$SYSROOT/usr/lib/i686-linux-android/$API" ;;
  esac

  echo "[xuan-ui] building $abi ..."
  "$cxx" -std=c++17 -O2 -fPIC -shared -fvisibility=hidden -ffunction-sections -fdata-sections \
    -static-libstdc++ \
    --sysroot="$SYSROOT" -I"$SRC_DIR" \
    -L"$libdir" \
    "$SRC_DIR/xuan_ui.cpp" "$SRC_DIR/xuan_ui_jni.cpp" \
    -lGLESv2 -lEGL -landroid -ljnigraphics -lm \
    -Wl,--gc-sections -Wl,-z,relro -Wl,-z,now -Wl,-z,noexecstack \
    -Wl,-z,max-page-size=16384 \
    -o "$out/libxuan_ui.so"
  "$TOOLCHAIN/llvm-strip" --strip-unneeded "$out/libxuan_ui.so" 2>/dev/null || true
  echo "[xuan-ui]   -> $out/libxuan_ui.so ($(stat -c%s "$out/libxuan_ui.so") bytes)"
done

echo "[xuan-ui] DONE"
