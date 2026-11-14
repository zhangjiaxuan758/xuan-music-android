#!/usr/bin/env python3
# ==================================================================
# 小轩音乐 · 闭源专有软件
# 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
# 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
# ==================================================================
# -*- coding: utf-8 -*-
"""读取 private.config.json，把占位符替换为真实值后重建 secretBox.ts 的密文表。
用法: python3 gen_secretbox.py   （在 inject_private.py 之后、构建之前执行）"""
import re, json
from pathlib import Path
ROOT = Path(__file__).resolve().parent
cfg = json.loads((ROOT/'private.config.json').read_text(encoding='utf-8'))
# 键以拼接方式构造：即使本文件被纯文本注入脚本扫到，也不会把「占位符字面量」提前改掉。
def PH(name):
    return '__XUAN_' + name + '__'
REPL = {
    PH('SERVER_BASE'): cfg['serverBase'],
    PH('SERVER_HOST'): cfg['serverHost'],
    PH('APP_SIGN_SECRET'): cfg['appSignSecret'],
}
def rebuild(path):
    s = path.read_text(encoding='utf-8')
    def arr(name):
        m = re.search(r'const '+name+r': readonly number\[\] = \[([^\]]+)\]', s, re.S)
        return [int(x) for x in m.group(1).replace('\n','').split(',') if x.strip()]
    K, R, P = arr('K'), arr('R'), arr('P')
    def dec(i):
        off, ln = P[2*i], P[2*i+1]
        return ''.join(chr(R[off+j]^K[(off+j)%32]) for j in range(ln))
    vals = []
    for i in range(len(P)//2):
        v = dec(i)
        for ph, real in REPL.items(): v = v.replace(ph, real)
        vals.append(v)
    buf = bytearray(); P2 = []
    for v in vals:
        b = v.encode('utf-8') if any(ord(c) > 127 for c in v) else v.encode('latin1')
        off = len(buf)
        for j, ch in enumerate(b): buf.append(ch ^ K[(off+j)%32])
        P2 += [off, len(b)]
    R2 = list(buf)
    def fmt(a, per=16):
        return '\n'.join('    '+','.join(str(x) for x in a[i:i+per])+',' for i in range(0,len(a),per)).rstrip(',')
    s = re.sub(r'(const R: readonly number\[\] = \[)[^\]]+(\])', lambda m: m.group(1)+'\n'+fmt(R2)+'\n'+m.group(2), s, count=1, flags=re.S)
    s = re.sub(r'(const P: readonly number\[\] = \[)[^\]]+(\])', lambda m: m.group(1)+'\n'+fmt(P2)+'\n'+m.group(2), s, count=1, flags=re.S)
    path.write_text(s, encoding='utf-8')
    print('rebuilt', path)
for p in [ROOT/'client/src/services/secretBox.ts', ROOT/'admin/src/secretBox.ts']:
    if p.exists(): rebuild(p)
