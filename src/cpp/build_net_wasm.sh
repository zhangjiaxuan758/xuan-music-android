#!/usr/bin/env bash
# ==================================================================
# 小轩音乐 · 闭源专有软件
# 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
# 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
# ==================================================================
# 小轩音乐 C++ 网络层核心 → WebAssembly（安卓 WebView / 管理端 WebView / Electron 共用同一份产物）
# 依赖：clang 18（自带 wasm32 target 与 wasm-ld），无需 Emscripten / NDK / libc。
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
OUT="$SRC/../services/wasm/xuan_net.wasm"
mkdir -p "$(dirname "$OUT")"

clang++ --target=wasm32 -O3 -nostdlib -fno-exceptions -fno-rtti \
    -fno-builtin -Wl,--no-entry -Wl,--export-all -Wl,--export-memory \
    -Wl,--allow-undefined -Wl,--strip-all \
    -o "$OUT" "$SRC/xuan_net.cpp"

python3.11 - "$OUT" <<'PY'
import sys, struct
p = sys.argv[1]
d = open(p, 'rb').read()
assert d[:4] == b'\x00asm', 'not a wasm file'
def uleb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7f) << s
        if not (x & 0x80): break
        s += 7
    return r, i
i = 8; imports = 0; exports = []
while i < len(d):
    sid = d[i]; i += 1
    size, i = uleb(d, i)
    end = i + size
    if sid == 2:
        cnt, _ = uleb(d, i); imports = cnt
    if sid == 7:
        cnt, j = uleb(d, i)
        for _ in range(cnt):
            nl, j = uleb(d, j)
            name = d[j:j+nl].decode('latin1'); j += nl
            j += 1; _, j = uleb(d, j)
            exports.append(name)
    i = end
print('wasm bytes =', len(d), '| magic OK | imports =', imports, '(应为 0)')
need = ['xn_io','xn_io_cap','xn_version','xn_sha_hex','xn_hmac_hex','xn_route_key','xn_boot_verify','xn_ct_eq','memory']
missing = [n for n in need if n not in exports]
print('exports =', ','.join(exports))
assert imports == 0, 'unexpected imports'
assert not missing, 'missing exports: ' + ','.join(missing)
PY
echo "BUILD_NET_WASM_DONE -> $OUT"
