#!/usr/bin/env python3
# ==================================================================
# 小轩音乐 · 闭源专有软件
# 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
# 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
# ==================================================================
# -*- coding: utf-8 -*-
"""把 private.config.json 里的真实值注入到源码占位符中（部署/构建前执行）。
private.config.json 已在 .gitignore，绝不入库。示例见 private.config.example.json。"""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent
CFG = ROOT / 'private.config.json'
if not CFG.exists():
    print('缺少 private.config.json（参考 private.config.example.json）'); sys.exit(1)
cfg = json.loads(CFG.read_text(encoding='utf-8'))
# 占位符 -> 配置键
MAP = {
    '__XUAN_SERVER_BASE__': 'serverBase',
    '__XUAN_SERVER_HOST__': 'serverHost',
    '__XUAN_GITHUB_CLIENT_ID__': 'githubClientId',
    '__XUAN_GITHUB_CLIENT_SECRET__': 'githubClientSecret',
    '__XUAN_APP_SIGN_SECRET__': 'appSignSecret',
    '__XUAN_CERT_SHA256__': 'certSha256',
    '__XUAN_ADMIN_DEFAULT_PASSWORD__': 'adminDefaultPassword',
    '__XUAN_SERVER_IP__': 'serverIp',
    '__XUAN_GITHUB_ACCOUNT__': 'githubAccount',
}
exts = {'.py','.ts','.tsx','.cjs','.js','.sh','.json','.cpp','.example'}
# 处理占位符的工具脚本本身不能被注入：否则 gen_secretbox.py 里的键会被提前替换成真实值，
# 密文表重建就会失效（解密出的占位符再也匹配不上）。
SKIP_FILES = {'private.config.json', 'private.config.example.json',
              'inject_private.py', 'gen_secretbox.py'}
count = 0
for f in ROOT.rglob('*'):
    if not f.is_file() or f.suffix not in exts: continue
    if f.name in SKIP_FILES: continue
    t = f.read_text(encoding='utf-8', errors='replace'); o = t
    for ph, key in MAP.items():
        if key in cfg: t = t.replace(ph, str(cfg[key]))
    if t != o:
        f.write_text(t, encoding='utf-8'); count += 1
print('已注入文件数:', count)
