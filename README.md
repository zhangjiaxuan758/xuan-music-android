# 小轩音乐 · 安卓客户端（脱敏源码 + C++ 原生渲染引擎）

本仓库仅含**安卓客户端**脱敏源码。不含管理端、服务端、网页端，不含任何真实服务器地址、
密钥、口令、证书指纹或 GitHub token；所有敏感值以 `__XUAN_*__` 占位符表示。

> **本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。**

## 本轮更新（1.7.51）
- **全 C++ 加密层，Web Crypto 清零**：签名/验签/路由键/四通道请求签名，以及 Cookie 代理加密（原生 AES-256-GCM，与服务端字节兼容）、下载整包校验（原生增量 SHA-256）、缓存键哈希（原生 SHA-256）、随机数（原生 CSPRNG）全部由原生 C++（Android libxuan_net.so / Windows xuan_native.node，含新增 xuan_aes.cpp）实现；业务代码 crypto.subtle 计数为 0，SO/.node 不可用时 fail-closed。
- **登录稳定性修复**：完整性失败弹窗改为可关闭+重试（去掉 history/keydown 绝对锁死）、加登录宽限期避免握手抖动误报黑屏；uiUnlockGuard 增加心跳自愈清除残留遮罩；状态栏交还 native 全屏管理，修复 GitHub 登录顶部黑条与"登录后划不动/点不动"。
- **身份授权码服务端同步**：复制时强制将已登录账号 + 全部本地配置加密上传服务端；输入授权码+密码跨设备/重装恢复账号与全部配置；修复"授权码不存在"（不再允许跳过保存、不再拒绝输入本机自己的码）。
- **原生 IO 缓冲扩容**：C++ g_io 16KB→256KB、参数槽 32KB；新增 aes/rng/shainit/shaupd/shafin 原生 op。
- **动态路径回退保留**：boot 表失效时走规范路径本地回退，保证业务可用（避免 1.7.48 全挂）。
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
