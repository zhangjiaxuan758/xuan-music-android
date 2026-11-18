// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import { Capacitor, registerPlugin } from '@capacitor/core';

const OVERLAY_ATTR = 'data-xuan-overlay';

const STALE_MS = 15 * 1000;

let nativeUi: { forceRestoreUi(): Promise<{ ok?: boolean }> } | null = null;

function restoreNativeUi(): void {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (!nativeUi) nativeUi = registerPlugin<{ forceRestoreUi(): Promise<{ ok?: boolean }> }>('XuanNative');
    void nativeUi.forceRestoreUi().catch(() => {  });
  } catch {  }
}

type Tracked = { el: HTMLElement; created: number };

const tracked = new Set<Tracked>();
let installed = false;

let downloadActive = false;

let wasHidden = false;

let forceRelease: (() => void) | null = null;

export function setDownloadActive(active: boolean): void {
  downloadActive = active;
}

export function setForceGuardRelease(fn: (() => void) | null): void {
  forceRelease = fn;
}

export function markOverlay(el: HTMLElement, kind: string): void {
  try {
    el.setAttribute(OVERLAY_ATTR, kind);
    tracked.add({ el, created: Date.now() });
  } catch {  }
}

export function unlockNow(reason = 'manual', force = false): void {
  try {
    document.getElementById('xuan-service-closed')?.remove();
    document.querySelectorAll('[data-xuan-service-banner]').forEach(n => n.remove());

    // Login modals (Netease QR / GitHub) use AnimatePresence exit animation.
    // If the exit animation stalls on Custom Tab return / background switch, a
    // leftover opacity:0 layer with pointer-events still active blocks all touch.
    // Such layers must be removed unconditionally, ignoring STALE_MS and wasHidden.
    document.querySelectorAll<HTMLElement>('[data-xuan-overlay="login-modal"]')
      .forEach(n => { try { n.remove(); } catch {  } });

    try { forceRelease?.(); } catch {  }
    if (force) restoreNativeUi();

    const b = document.body.style;
    const h = document.documentElement.style;
    if (b.pointerEvents === 'none') b.pointerEvents = '';
    if (b.touchAction === 'none') b.touchAction = '';
    if (h.pointerEvents === 'none') h.pointerEvents = '';
    if (h.touchAction === 'none') h.touchAction = '';
    // Some ROMs inject overflow:hidden / position:fixed on body after Custom Tab
    // return, making the whole page unscrollable. Reset only when not downloading.
    if (!downloadActive && force) {
      if (b.overflow === 'hidden') b.overflow = '';
      if (h.overflow === 'hidden') h.overflow = '';
      if (b.position === 'fixed') b.position = '';
    }

    if ((!wasHidden && !force) || downloadActive) return;
    const now = Date.now();
    tracked.forEach(t => {
      if (!force && now - t.created < STALE_MS) return;
      if (!t.el.isConnected) { tracked.delete(t); return; }
      try { t.el.remove(); } catch {  }
      tracked.delete(t);
    });

    document.querySelectorAll<HTMLElement>(`body > [${OVERLAY_ATTR}]`).forEach(n => {
      const born = Number(n.getAttribute('data-xuan-overlay-at') || 0);
      if (force || !born || now - born >= STALE_MS) n.remove();
    });
  } catch {  }
  void reason;
}

/**
 * 无副作用扫描并清理「视觉上已消失但仍拦截触摸」的残留层。
 * Custom Tab 返回 / 登录回调中断后，AnimatePresence 退场动画常卡住，
 * 留下 opacity:0 但 pointer-events 仍生效的 login-modal 层挡住全部触摸。
 * 返回是否实际改动过 DOM / 样式，供调用方决定是否恢复原生 surface。
 */
export function sweepResidualUI(): boolean {
  let changed = false;
  try {
    document.querySelectorAll<HTMLElement>(`[${OVERLAY_ATTR}]`).forEach(n => {
      const kind = n.getAttribute(OVERLAY_ATTR) || '';
      const cs = window.getComputedStyle(n);
      const invisible = cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none';
      const transient = kind === 'login-modal' || kind === 'login' || kind === 'modal-exit';
      if (transient || invisible) {
        try { n.remove(); changed = true; } catch {  }
      }
    });
    const b = document.body.style;
    const h = document.documentElement.style;
    if (b.pointerEvents === 'none') { b.pointerEvents = ''; changed = true; }
    if (b.touchAction === 'none') { b.touchAction = ''; changed = true; }
    if (h.pointerEvents === 'none') { h.pointerEvents = ''; changed = true; }
    if (h.touchAction === 'none') { h.touchAction = ''; changed = true; }
  } catch {  }
  return changed;
}

export function installUiUnlockGuard(): void {
  if (installed) return;
  installed = true;

  const onVisible = () => {
    if (document.visibilityState === 'hidden') { wasHidden = true; return; }
    if (wasHidden) unlockNow('visible');
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', () => { if (wasHidden) unlockNow('pageshow'); });
  window.addEventListener('focus', () => { if (wasHidden) unlockNow('focus'); });

  window.addEventListener('pagehide', () => { wasHidden = true; });
  window.addEventListener('blur', () => { wasHidden = true; });

  window.addEventListener('xuan:github-connected', () => unlockNow('github-connected', true));
  window.addEventListener('xuan:ui-unlock', () => unlockNow('ui-unlock', true));
  window.addEventListener('xuan:provider-login-settled', () => unlockNow('provider-login-settled', true));
  // 登录弹窗打开/关闭、网易云登录确认：都强制恢复 WebView 渲染，
  // 避免 Custom Tab / 全屏半透明层返回后 surface 停止合成造成黑屏。
  window.addEventListener('xuan:login-modal-open', () => unlockNow('login-modal-open', true));
  window.addEventListener('xuan:login-modal-close', () => unlockNow('login-modal-close', true));
  window.addEventListener('xuan:netease-login-confirmed', () => unlockNow('netease-login-confirmed', true));

  // 心跳兜底：即使登录回调事件因 Custom Tab / 后台切换丢失，也周期性扫描残留遮罩
  // 并强制恢复。这是「登录后全部划不动、点不动」的最终自愈网（不依赖任何事件）。
  window.setInterval(() => {
    if (document.visibilityState !== 'visible' || downloadActive) return;
    let changed = false;
    try { changed = sweepResidualUI(); } catch {  }
    if (wasHidden || changed) {
      wasHidden = false;
      unlockNow('heartbeat', true);
    }
  }, 2500);
}

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|43fce3870d80|725deeff2cf2");}catch(_e){}
