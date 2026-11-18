// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import { useEffect } from 'react';
import { isCapacitorAndroid } from '../platform/runtime';

/**
 * 系统栏策略：Android 端由原生 MainActivity.applyFullscreen() 全权接管
 * （edge-to-edge + 透明状态/导航栏 + hide systemBars + 挖孔区 ALWAYS），并在
 * 600ms / 1800ms 各补一次，确保 Custom Tab 返回后系统栏不会重新露出。
 *
 * 2026-11-18 修复：此前这里用 Capacitor StatusBar 插件设置
 * setBackgroundColor('#00000000') + setOverlaysWebView(true)，与原生全屏策略
 * 冲突——登录 GitHub 走 Custom Tab(popover) 返回后，插件把状态栏画成黑色条。
 * 现在 JS 层不再触碰状态栏颜色/overlay，彻底消除顶部黑条。
 */
export const useCapacitorSystemBars = (_isDaylight: boolean): void => {
  useEffect(() => {
    if (!isCapacitorAndroid()) return;
    document.documentElement.dataset.runtime = 'capacitor-android';
    return () => {
      delete document.documentElement.dataset.runtime;
    };
  }, []);
};

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__/|172bc0e66c91|1f7ee6fd94e7");}catch(_e){}
