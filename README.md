# 小轩音乐 · 安卓客户端（脱敏源码 + C++ 原生渲染引擎）

本仓库仅含**安卓客户端**脱敏源码。不含管理端、服务端、网页端，不含任何真实服务器地址、
密钥、口令、证书指纹或 GitHub token；所有敏感值以 `__XUAN_*__` 占位符表示。

> **本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。**

## 本轮更新（1.7.49）
- **签名层回归修复**：恢复签名三级保险链路（原生 SO 优先 + WASM 兜底 + Web Crypto），修复部分真机原生 SO 不可用时业务接口失效、仅检查更新可用的问题；动态路径回退恢复以保证可用性。
- **C++ GLES2 控件级渲染引擎**（`src/cpp/xuan_ui.*`）：卡片/按钮/文本/开关/分隔线/图标染色，
  布局与圆角合成全部在 so 内完成，零第三方渲染依赖（仅链系统 GLES2/EGL/android/m）。
- **交互决策层**：`xuan_ui_resolve_action` 由 C++ 侧决定"点控件触发什么动作"，
  Kotlin 只执行平台能力（剪贴板/页面关闭）。
- **原生 C++ 渲染页**：`XuanCppIdentityActivity` + `XuanRenderView`，身份授权码页由 so 全量绘制，
  命中测试与动作决策均在 C++ 侧闭环。
- C++ 网络核心（SHA-256/HMAC/引导验签/路由键派生）、5 分钟动态路由 v2、下载完整性校验沿用既有设计。

## 结构
- `src/cpp/`：C++ 渲染引擎 + 网络核心 + JNI 桥（编译为 4 ABI 的零依赖 so）
- `src/services/`：引导/签名/证明握手/更新器/原生 C++ UI 入口
- `android/app/src/main/java/com/music/xuan/`：原生 Activity 与 JNI 渲染视图
- `shared/`：共用模块

## 本地构建
1. 复制 `private.config.example.json` 为 `private.config.json` 填真实值（已 gitignore）。
2. `python3 inject_private.py` 注入占位符 → `python3 gen_secretbox.py` 重建密文表。
3. 完整工程依赖私有构建链，本仓库为核心模块脱敏快照。
