# 小轩音乐 · 安卓客户端（脱敏源码）

本仓库仅含**安卓客户端**脱敏源码。不含管理端、服务端、网页端，不含任何真实服务器地址、
密钥、口令、证书指纹或 GitHub token；所有敏感值以 `__XUAN_*__` 占位符表示。

> **本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。**
> 主服务地址（裸域名，不含路径）以 `__XUAN_SERVER_BASE__` 占位，`inject_private.py` 注入真实值。

## 每个源码文件均嵌入三项
每个 `.ts/.cpp/.cjs/.py/.sh` 文件头部统一带有：主链接占位符、闭源专有软件声明、
强行逆向的法律责任提示。占位符在构建部署时被替换为真实裸域名，因此成品中每个文件
都指向你的主链接，而公开仓库始终不泄露它。

## 结构
- `src/cpp/xuan_net.cpp`：C++ 网络核心（SHA-256 / HMAC / 引导验签 / 路由键派生），编译为零 import wasm
- `src/services/routeMap.ts`：裸域名引导，`X-Xuan-Role: app`，5 分钟轮换动态路由表
- `src/services/secretBox.ts`：主链接等敏感值的密文表（编码占位符）
- `src/services/xuanNet.ts` / `wasm/xuanNetWasm.ts`：C++ 引擎封装
- `src/services/xuanServer.ts` / `appAttest.ts` / `appUpdater.ts`：签名、证明握手、下载完整性校验
- `shared/` 共用模块

## 本地构建
1. 复制 `private.config.example.json` 为 `private.config.json` 并填真实值（已 gitignore）。
2. `python3 inject_private.py` → 明文占位符替换；`python3 gen_secretbox.py` → **必须**，重建密文表。
3. 完整工程依赖私有构建链，本仓库为核心模块脱敏快照。
