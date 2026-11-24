// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * 小轩音乐 · 原生 C++ 渲染界面桥
 * ---------------------------------------------------------------------------
 * 「除播放器外，界面与交互由 C++/so 渲染」全量迁移的 JS 入口。
 * 目前第一个真实落地页：身份授权码原生界面（libxuan_ui.so 渲染）。
 * Web/桌面端不可用时静默降级，不影响原 WebView 页面。
 */
interface XuanNativeCppUI {
  openCppIdentityPage(options: { code: string }): Promise<{ ok?: boolean; error?: string }>;
  openCppAiPage(options: { thinking?: boolean; search?: boolean }): Promise<{ ok?: boolean; error?: string }>;
  cppAiPush(options: { json: string }): Promise<{ ok?: boolean }>;
  cppAiError(options: { msg: string }): Promise<{ ok?: boolean }>;
  cppRenderVersion(): Promise<{ version: string; available: boolean }>;
}

let plugin: XuanNativeCppUI | null = null;

function getPlugin(): XuanNativeCppUI | null {
  if (!Capacitor.isNativePlatform()) return null;
  if (!plugin) {
    try {
      plugin = registerPlugin<XuanNativeCppUI>('XuanNative');
    } catch {
      return null;
    }
  }
  return plugin;
}

/** 是否支持原生 C++ 渲染界面。 */
export function isCppUIAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

/** 打开身份授权码原生 C++ 渲染界面；传入本机身份授权码，保证与设置页一致。 */
export async function openCppIdentityPage(code: string): Promise<boolean> {
  const p = getPlugin();
  if (!p) return false;
  try {
    const r = await p.openCppIdentityPage({ code });
    return Boolean(r?.ok);
  } catch {
    return false;
  }
}

/** 打开 C++ 渲染的 AI 对话界面；配置由服务端动态下发，这里只透传当前思考/联网开关。 */
/** 最近一次 openCppAiPage 的诊断信息（供入口提示，定位静默降级原因）。 */
export let lastCppAIDiag = '';

export async function openCppAiPage(thinking: boolean, search: boolean): Promise<boolean> {
  const p = getPlugin();
  if (!p) { lastCppAIDiag = '原生插件未就绪或当前非原生平台'; return false; }
  try {
    const r = await p.openCppAiPage({ thinking, search });
    if (!r?.ok) {
      lastCppAIDiag = String((r as any)?.error || '原生层返回启动失败');
      return false;
    }
    lastCppAIDiag = 'OK';
    return true;
  } catch (e: any) {
    lastCppAIDiag = String(e?.message || e || '调用原生插件时异常');
    return false;
  }
}

/** 读取自研 C++ 渲染引擎版本（自检用）。 */
export async function cppRenderVersion(): Promise<{ version: string; available: boolean } | null> {
  const p = getPlugin();
  if (!p) return null;
  try {
    return await p.cppRenderVersion();
  } catch {
    return null;
  }
}

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|cd50be819159|e097dfdef586");}catch(_e){}
