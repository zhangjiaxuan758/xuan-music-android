// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import { Capacitor, registerPlugin } from '@capacitor/core';

const OVERLAY_ATTR = 'data-xuan-overlay';
// 用户主动操作的持久弹窗（更新/下载进度）绝不能被黑边自愈心跳误删。
// 心跳的 force 清理只针对「登录瞬时层/僵尸层」，带此标记的层一律跳过。
const PERSIST_ATTR = 'data-xuan-overlay-persist';

const STALE_MS = 15 * 1000;

let nativeUi: { forceRestoreUi(): Promise<{ ok?: boolean }> } | null = null;

function restoreNativeUi(): void {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (!nativeUi) nativeUi = registerPlugin<{ forceRestoreUi(): Promise<{ ok?: boolean }> }>('XuanNative');
    void nativeUi.forceRestoreUi().then(r => {
      if (r && r.ok === false) console.warn('[uiUnlockGuard] forceRestoreUi 返回失败，需原生层复核注册');
    }).catch(e => { console.warn('[uiUnlockGuard] forceRestoreUi 调用失败:', e); });
  } catch (e) { console.warn('[uiUnlockGuard] restoreNativeUi 异常:', e); }
}

/** GitHub/Custom Tab 登录回调事件在多段延迟后仍补刀：Tab(popover) 真正关闭往往晚于事件触发，
 *  系统栏会在 Tab 关闭瞬间被 ROM 重新显示。单次 forceRestoreUi 的 120/400/900ms 补刀
 *  全部打在 Tab 关闭之前，故这里在 JS 侧再铺 300/900/1600/2600ms 四段，覆盖关闭后的时刻。 */
function forceRestoreWithFollowups(reason: string): void {
  unlockNow(reason, true);
  [300, 900, 1600, 2600].forEach((d, i) => {
    window.setTimeout(() => unlockNow(`${reason}+${i}`, true), d);
  });
}

type Tracked = { el: HTMLElement; created: number };

const tracked = new Set<Tracked>();
let installed = false;

let downloadActive = false;

let wasHidden = false;

// 心跳自己观察到的「不可见」状态：完全不依赖 visibilitychange/blur 事件。
// Custom Tab(popover) 返回时这些事件在部分 ROM 上根本不触发，导致 wasHidden 永远 false，
// 于是原来的恢复逻辑三重失效（原生 onResume 不触发 + JS 事件不触发 + 心跳条件不满足）。
let sawHiddenInHeartbeat = false;
let lastVisibleHeartbeat = 0;

// 打开外部网页后武装一段时间：这段时间内心跳无条件做原生 force 恢复，
// 覆盖「用户在网页停留很久、事件全部丢失、从任意路径返回」的场景。
let forceRestoreUntil = 0;

/** 打开外部网页（GitHub / Custom Tab）时调用，武装强制恢复窗口。 */
export function armForceRestore(durationMs = 60000): void {
  forceRestoreUntil = Date.now() + durationMs;
}

let forceRelease: (() => void) | null = null;

export function setDownloadActive(active: boolean): void {
  downloadActive = active;
}

export function setForceGuardRelease(fn: (() => void) | null): void {
  forceRelease = fn;
}

export function markOverlay(el: HTMLElement, kind: string, persistent = false): void {
  try {
    el.setAttribute(OVERLAY_ATTR, kind);
    if (persistent) el.setAttribute(PERSIST_ATTR, '1');
    tracked.add({ el, created: Date.now() });
  } catch {  }
}

/**
 * 清理登录弹窗僵尸层。
 * 关键：活跃弹窗由 React/AnimatePresence 挂载并带 data-xuan-login-active 标记，
 * 绝不能从 JS 侧 remove —— 否则「打开瞬间被删」「React 状态还在但 DOM 没了导致全屏黑」。
 * 这里只处理两类安全目标：
 *  1) 没有 active 标记（React 已卸载）且不可见/退场卡住的层 → remove；
 *  2) 依然可见但 body/html 误留 pointer-events:none → 在下方统一恢复，不动 DOM。
 */
function cleanLoginModalResidue(): void {
  document.querySelectorAll<HTMLElement>('[data-xuan-overlay="login-modal"]')
    .forEach(n => {
      try {
        if (n.getAttribute('data-xuan-login-active') === '1') return; // 活跃弹窗，交给 React
        const cs = window.getComputedStyle(n);
        const invisible = cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none';
        if (invisible) n.remove();
      } catch {  }
    });
}

export function unlockNow(reason = 'manual', force = false): void {
  try {
    document.getElementById('xuan-service-closed')?.remove();
    document.querySelectorAll('[data-xuan-service-banner]').forEach(n => n.remove());

    // 仅清理僵尸层；活跃登录弹窗保持 DOM 完整（治「瞬间消失/全屏黑」）。
    cleanLoginModalResidue();

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
      // 持久弹窗（更新/下载进度）绝不删除：它是用户主动操作，不是登录僵尸层。
      if (t.el.getAttribute(PERSIST_ATTR) === '1') return;
      if (!force && now - t.created < STALE_MS) return;
      if (!t.el.isConnected) { tracked.delete(t); return; }
      try { t.el.remove(); } catch {  }
      tracked.delete(t);
    });

    document.querySelectorAll<HTMLElement>(`body > [${OVERLAY_ATTR}]`).forEach(n => {
      if (n.getAttribute(PERSIST_ATTR) === '1') return; // 持久弹窗跳过清理
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
    // 登录弹窗僵尸层单独处理：活跃弹窗（带 active 标记，由 React 管理）绝不删除。
    cleanLoginModalResidue();
    document.querySelectorAll<HTMLElement>(`[${OVERLAY_ATTR}]`).forEach(n => {
      const kind = n.getAttribute(OVERLAY_ATTR) || '';
      if (kind === 'login-modal') return; // 已由 cleanLoginModalResidue 安全处理
      if (n.getAttribute(PERSIST_ATTR) === '1') return; // 更新/下载进度等用户主动弹窗，绝不清扫
      const cs = window.getComputedStyle(n);
      const invisible = cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none';
      const transient = kind === 'login' || kind === 'modal-exit';
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

  // 回到前台统一走这里：强制恢复原生全屏 + WebView 焦点，并武装短窗口持续补刀。
  // 之前事件路径只在 wasHidden 时恢复、且用 forceRestoreWithFollowups 补刀，
  // popover 模式下事件丢失就完全不恢复。现在事件只是「加速器」，真正兜底靠心跳。
  const restoreOnForeground = (reason: string) => {
    if (document.visibilityState === 'hidden') {
      wasHidden = true;
      sawHiddenInHeartbeat = true;
      return;
    }
    wasHidden = false;
    sawHiddenInHeartbeat = false;
    forceRestoreUntil = Math.max(forceRestoreUntil, Date.now() + 8000);
    unlockNow(reason, true);
  };
  const onVisible = () => restoreOnForeground('visible');
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', () => restoreOnForeground('pageshow'));
  window.addEventListener('focus', () => restoreOnForeground('focus'));

  window.addEventListener('pagehide', () => { wasHidden = true; sawHiddenInHeartbeat = true; });
  window.addEventListener('blur', () => { wasHidden = true; sawHiddenInHeartbeat = true; });

  window.addEventListener('xuan:github-connected', () => forceRestoreWithFollowups('github-connected'));
  window.addEventListener('xuan:ui-unlock', () => forceRestoreWithFollowups('ui-unlock'));
  window.addEventListener('xuan:provider-login-settled', () => forceRestoreWithFollowups('provider-login-settled'));
  // 登录弹窗打开/关闭、网易云登录确认：都强制恢复 WebView 渲染，
  // 避免 Custom Tab / 全屏半透明层返回后 surface 停止合成造成黑屏。
  window.addEventListener('xuan:login-modal-open', () => forceRestoreWithFollowups('login-modal-open'));
  window.addEventListener('xuan:login-modal-close', () => forceRestoreWithFollowups('login-modal-close'));
  window.addEventListener('xuan:netease-login-confirmed', () => forceRestoreWithFollowups('netease-login-confirmed'));

  // 心跳兜底：即使登录回调事件因 Custom Tab / 后台切换丢失，也周期性扫描残留遮罩
  // 并强制恢复。这是「登录后全部划不动、点不动」的最终自愈网（不依赖任何事件）。
  window.setInterval(() => {
    if (downloadActive) return;
    if (document.visibilityState !== 'visible') {
      // 心跳亲眼看到页面进入后台/被 Custom Tab 覆盖。不依赖 visibilitychange 事件，
      // 这是 popover 模式下最可靠的状态来源。
      sawHiddenInHeartbeat = true;
      lastVisibleHeartbeat = 0;
      return;
    }
    const now = Date.now();
    // 距上次心跳可见间隔异常（>8s）说明中间被切走过但事件丢失，也判为「曾离开」。
    const longGap = lastVisibleHeartbeat > 0 && (now - lastVisibleHeartbeat) > 3000;
    lastVisibleHeartbeat = now;

    let changed = false;
    try { changed = sweepResidualUI(); } catch {  }
    // 任何「曾离开」迹象（事件型 / 心跳自观察 / 长间隙）都要重新武装一段短窗口，
    // 覆盖部分 ROM 在返回数秒后才重新布局、再次露出状态栏黑边的情况。
    const leftPage = wasHidden || sawHiddenInHeartbeat || longGap;
    if (leftPage) forceRestoreUntil = Math.max(forceRestoreUntil, now + 8000);
    const armed = now < forceRestoreUntil;
    // 关键修复：任何「曾离开」迹象或 DOM 残留，或处于武装窗口内，都无条件做原生 force 恢复。
    // 之前仅判断 (wasHidden || changed)，popover 模式下两者都可能为 false → 永远不自愈。
    if (leftPage || armed || changed) {
      wasHidden = false;
      sawHiddenInHeartbeat = false;
      unlockNow('heartbeat', true);
    }
  }, 2500);
}

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|43fce3870d80|725deeff2cf2");}catch(_e){}
