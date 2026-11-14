// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
/**
 * 客户端在线更新
 * ------------------------------------------------------------------
 * 管理端上传新 APK → 服务端 update 段更新 → 客户端下次启动检查 →
 * 弹窗「已有新版本 是否更新软件」→ 确定/取消 → 下载 → 点击安装。
 *
 * 覆盖安装：新 APK 与旧版同包名 com.music.xuan、同一签名密钥，
 * Android 系统会直接升级覆盖，不会出现两个软件。
 * 更新地址与所有接口均走 __XUAN_SERVER_BASE__。
 *
 * 下载通道：优先 WebView fetch 流式下载（有进度、内存友好）；失败时回退到
 * CapacitorHttp（原生 HTTP，与取票据同一 UA，不受 WebView CORS / UA 差异影响）。
 */

import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { checkUpdate, downloadUrl, initXuanServer, type UpdateInfo } from './xuanServer';
import { ud, udVer, udTheme } from './remoteResources';

const XuanNative = registerPlugin<{
  installApk(options: { path: string }): Promise<{ ok: boolean }>;
  getApkVersion(): Promise<{ versionCode: number; versionName: string }>;
  updateMedia(options: MediaOptions): Promise<void>;
  hideMedia(): Promise<void>;
  /** Android：启动后台更新前台服务（切后台/锁屏继续下载 + 通知栏进度） */
  backgroundDownload(options: {
    url: string; fileName: string; expectedSize: number;
    expectedSha256: string; expectedSign: string; versionName: string;
  }): Promise<{ ok: boolean }>;
} & Record<string, any>>('XuanNative');

export interface MediaOptions {
  title: string; artist: string; playing: boolean; cover?: string | null;
  showFavorite: boolean; liked: boolean;
}

// 当前客户端 versionCode；构建脚本会注入真实值，仅作原生读取失败时的兜底
declare const __XUAN_VERSION_CODE__: number | undefined;
export const CURRENT_VERSION_CODE: number =
  (typeof __XUAN_VERSION_CODE__ !== 'undefined' ? __XUAN_VERSION_CODE__ : 10629);

/**
 * 运行时版本码：优先从原生 PackageManager 读取 APK 真实 versionCode。
 * 构建注入值可能过期（旧构建弹「有新版」、系统装不上同版本），原生读取才能根治。
 */
export async function resolveCurrentVersionCode(): Promise<number> {
  if (Capacitor.isNativePlatform()) {
    try {
      const v = await XuanNative.getApkVersion();
      if (v && Number.isFinite(v.versionCode) && v.versionCode > 0) return v.versionCode;
    } catch { /* 旧包无此方法时走兜底 */ }
  }
  return CURRENT_VERSION_CODE;
}

// 管理端「更新说明」留空时的兜底文案（服务端也会下发同一默认值）
export const DEFAULT_CHANGELOG = '修复已知问题，请尽快更新';

// 每次冷启动都检查并弹窗；点「取消」只关闭本次弹窗，不写入任何抑制标记，
// 保证下次启动仍会重新弹（与旧版行为一致）。

function el(tag: string, style: Partial<CSSStyleDeclaration>, text?: string): HTMLElement {
  const n = document.createElement(tag);
  Object.assign(n.style, style);
  if (text) n.textContent = text;
  return n;
}

/** 轻提示（与更新弹窗同风格）；用于「已是最新版本」等反馈 */
function toast(msg: string, ms = 2200) {
  const t = el('div', {
    position: 'fixed', left: '50%', bottom: '42px', transform: 'translateX(-50%)',
    zIndex: '100000', background: 'rgba(30,30,32,.94)', color: '#f2f2f3',
    padding: '10px 18px', borderRadius: '999px', fontSize: '13px', fontWeight: '600',
    boxShadow: '0 10px 30px rgba(0,0,0,.4)', fontFamily: 'system-ui, -apple-system, sans-serif',
    opacity: '0', transition: 'opacity .2s, transform .2s',
  }, msg);
  document.body.append(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; });
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 250);
  }, ms);
}

let dialogOpen = false;
// 强制更新期间拦截安卓返回键 / Esc / 浏览器后退：不允许绕过更新弹窗。
let forceGuard: (() => void) | null = null;

function releaseForceGuard() {
  if (!forceGuard) return;
  forceGuard();
  forceGuard = null;
}

function installForceGuard() {
  releaseForceGuard();
  // 压入一条历史记录，用户按返回键只会触发 popstate，被我们吞掉后立刻补回，
  // 从而无法退出 App 或关闭强制更新弹窗。
  let pushed = false;
  try { history.pushState({ xuanForceUpdate: true }, ''); pushed = true; } catch { /* noop */ }
  const onPop = () => {
    try { history.pushState({ xuanForceUpdate: true }, ''); } catch { /* noop */ }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Back') {
      e.preventDefault(); e.stopPropagation();
    }
  };
  window.addEventListener('popstate', onPop, true);
  window.addEventListener('keydown', onKey, true);
  forceGuard = () => {
    window.removeEventListener('popstate', onPop, true);
    window.removeEventListener('keydown', onKey, true);
    // 保留压入的历史，避免后退时把应用直接关掉；下次启动会重新走检查流程。
    void pushed;
  };
}

function showUpdateDialog(info: UpdateInfo, onConfirm: () => void) {
  if (dialogOpen) return;
  dialogOpen = true;
  // 弹窗文案 / 主题优先取服务端远程资源，缺失一律回退内置默认
  const th = udTheme();
  // force 由服务端更新段下发（管理端两个「强制更新」开关共同控制）。
  // 强制时：只有一个「立即更新」按钮、无取消、点遮罩/Esc/返回键都不关闭，必须更新。
  const forced = !!info.force;
  const overlay = el('div', {
    position: 'fixed', inset: '0', zIndex: '99999', display: 'flex',
    alignItems: 'center', justifyContent: 'center', background: th.overlay,
    backdropFilter: 'blur(6px)', fontFamily: 'system-ui, -apple-system, sans-serif',
  });
  const card = el('div', {
    width: 'min(420px, 86vw)', background: th.cardBg, color: th.cardFg,
    borderRadius: '18px', padding: '28px', boxShadow: '0 24px 70px rgba(0,0,0,.55)',
    border: '1px solid rgba(255,255,255,.08)',
  });
  const title = el('div', { fontSize: '19px', fontWeight: '700', marginBottom: '8px' },
    forced ? ud('titleForce', '必须更新后才能继续使用') : ud('titleNew', '已有新版本'));
  const ver = el('div', { fontSize: '13px', color: th.verColor, marginBottom: '14px' },
    udVer(info.versionName || '', info.versionCode));
  const desc = el('div', {
    fontSize: '13px', color: th.descColor, lineHeight: '1.7', marginBottom: '24px',
    maxHeight: '150px', overflowY: 'auto', whiteSpace: 'pre-wrap',
  }, (info.changelog || '').trim() || ud('defaultChangelog', DEFAULT_CHANGELOG));
  if (forced) {
    const hint = el('div', {
      fontSize: '12px', color: th.hintColor, lineHeight: '1.6', marginBottom: '16px',
      marginTop: '-10px',
    }, ud('forceHint', '本次为强制更新，请更新到最新版本后继续使用。'));
    card.append(hint);
  }

  const row = el('div', { display: 'flex', gap: '12px', justifyContent: 'flex-end' });
  const btn = (label: string, primary: boolean, cb: () => void) => {
    const b = el('button', {
      padding: '10px 22px', borderRadius: '10px', border: 'none', cursor: 'pointer',
      fontSize: '14px', fontWeight: '600', transition: 'opacity .15s',
      background: primary ? th.primaryBg : th.secondaryBg,
      color: primary ? th.primaryFg : th.secondaryFg,
    }, label) as HTMLButtonElement;
    b.onmouseenter = () => { b.style.opacity = '.82'; };
    b.onmouseleave = () => { b.style.opacity = '1'; };
    b.onclick = cb;
    return b;
  };

  const close = () => { overlay.remove(); dialogOpen = false; releaseForceGuard(); };
  if (forced) {
    // 只有一个按钮，没有「取消」；关闭只发生在用户点击「立即更新」并开始下载后。
    const only = btn(ud('btnForce', '立即更新'), true, () => { close(); onConfirm(); });
    only.style.flex = '1';
    row.append(only);
    installForceGuard();
  } else {
    // 取消：仅关闭弹窗，不记录任何状态 → 下次启动仍会重新弹
    const cancel = btn(ud('btnCancel', '取消'), false, () => { close(); });
    // 确定：关闭弹窗并立即开始下载/更新
    const confirm = btn(ud('btnConfirm', '确定'), true, () => { close(); onConfirm(); });
    row.append(cancel, confirm);
  }
  card.append(title, ver, desc, row);
  overlay.append(card);
  // 强模态：点击遮罩/卡片外的任何位置都不关闭，只有按钮可操作
  overlay.addEventListener('click', e => { e.stopPropagation(); });
  card.addEventListener('click', e => { e.stopPropagation(); });
  document.body.append(overlay);
}

interface ProgressUI {
  set: (pct: number, text: string) => void;
  /** onCancel：失败时额外提供「取消」按钮；传了即代表本次更新可被放弃。 */
  done: (ok: boolean, install: () => void, errMsg?: string, okLabel?: string,
         okHint?: string, onCancel?: () => void) => void;
}

function showProgressDialog(titleText?: string): ProgressUI {
  const th = udTheme();
  const resolvedTitle = titleText ?? ud('dlTitle', '正在下载更新');
  const overlay = el('div', {
    position: 'fixed', inset: '0', zIndex: '99999', display: 'flex',
    alignItems: 'center', justifyContent: 'center', background: th.overlay,
    backdropFilter: 'blur(6px)', fontFamily: 'system-ui, -apple-system, sans-serif',
  });
  const card = el('div', {
    width: 'min(420px, 86vw)', background: th.cardBg, color: th.cardFg,
    borderRadius: '18px', padding: '28px', border: '1px solid rgba(255,255,255,.08)',
  });
  const title = el('div', { fontSize: '17px', fontWeight: '700', marginBottom: '16px' }, resolvedTitle);
  const label = el('div', { fontSize: '12px', color: th.verColor, marginBottom: '10px' },
    ud('dlPreparing', '准备中…'));
  const track = el('div', { height: '6px', borderRadius: '4px', background: 'rgba(255,255,255,.10)', overflow: 'hidden' });
  const fill = el('div', { height: '100%', width: '0%', background: th.primaryBg, transition: 'width .2s' });
  track.append(fill);
  card.append(title, label, track);
  overlay.append(card);
  document.body.append(overlay);

  return {
    set: (pct, text) => { fill.style.width = `${Math.min(100, Math.max(0, pct))}%`; label.textContent = text; },
    done: (ok, install, errMsg, okLabel, okHint, onCancel) => {
      title.textContent = ok ? ud('okTitle', '校验通过') : ud('failTitle', '下载失败');
      label.textContent = ok
        ? (okHint || ud('okHint', '安装包完整性校验通过，点击下方按钮安装'))
        : (errMsg
            ? ud('reasonTpl', '原因：{msg}（可重试，或取消本次更新）').replace('{msg}', errMsg)
            : ud('failHint', '可重试，或取消本次更新'));
      const mkBtn = (text: string, primary: boolean, cb: () => void,
                     extra: Partial<CSSStyleDeclaration> = {}) => {
        const b = el('button', {
          padding: '12px', borderRadius: '10px', border: 'none', cursor: 'pointer',
          background: primary ? th.primaryBg : th.secondaryBg,
          color: primary ? th.primaryFg : th.secondaryFg, fontWeight: '600', fontSize: '14px',
          transition: 'opacity .15s', ...extra,
        }, text) as HTMLButtonElement;
        b.onmouseenter = () => { b.style.opacity = '.82'; };
        b.onmouseleave = () => { b.style.opacity = '1'; };
        b.onclick = cb;
        return b;
      };
      if (!ok && onCancel) {
        // 下载失败：两个按钮。「取消」= 放弃本次更新（不重试、不再弹更新窗）；
        // 「重试」= 重新走一遍下载（install 回调即 retryUpdate）。
        const row = el('div', { display: 'flex', gap: '10px', marginTop: '20px' });
        row.append(
          mkBtn(ud('btnCancel', '取消'), false, () => { overlay.remove(); onCancel(); }, { flex: '1' }),
          mkBtn(ud('btnRetry', '重试'), true, () => { overlay.remove(); install(); }, { flex: '1' }),
        );
        card.append(row);
      } else {
        // 成功 / 强制更新失败：单按钮。强制更新不提供取消，点击重试会重新弹出
        // 「只有更新按钮」的强制窗，杜绝绕过强制更新。
        card.append(mkBtn(
          ok ? (okLabel || ud('btnInstall', '安装'))
             : (errMsg ? ud('btnRetry', '重试') : ud('btnClose', '关闭')),
          ok,
          () => { overlay.remove(); install(); },
          { marginTop: '20px', width: '100%' },
        ));
      }
    },
  };
}

/** 最近一次下载响应头里的发布签名（服务端 X-Release-Sign），供 verifyDownload 与 check 下发值比对。 */
let lastDownloadReleaseSign = '';

/** 单次流式下载（有进度、内存友好）；严格按 Content-Length 判定是否被截断。 */
async function fetchOnce(url: string, ui: ProgressUI, expectedSize: number, attempt: number, maxAttempts: number): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  lastDownloadReleaseSign = res.headers.get('X-Release-Sign') || '';
  const declared = Number(res.headers.get('content-length') || 0);
  // 服务端 X-Accel 会带 Content-Length；缺失时用 checkUpdate 下发的登记大小
  const total = declared || expectedSize || 0;
  const reader = res.body?.getReader();
  if (!reader) throw new Error('不支持流式下载');
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const pct = total ? (received / total) * 100 : Math.min(95, (received / (15 * 1048576)) * 100);
    const a = (received / 1048576).toFixed(1);
    const b = (total / 1048576).toFixed(1);
    const prefix = attempt > 1 ? ud('dlRetryTag', '重试 {n}/{m} · ').replace('{n}', String(attempt)).replace('{m}', String(maxAttempts)) : '';
    ui.set(pct, prefix + (total
      ? ud('dlProgressTotal', '已下载 {a} MB / {b} MB').replace('{a}', a).replace('{b}', b)
      : ud('dlProgress', '已下载 {a} MB').replace('{a}', a)));
  }
  // 截断判定：以 Content-Length 或服务端登记的发布大小为准，少一个字节都视为不完整。
  const authoritative = declared || expectedSize || 0;
  if (authoritative && received !== authoritative) {
    throw new Error(`下载不完整（应为 ${authoritative} 字节，实际 ${received} 字节）`);
  }
  const all = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return all;
}

/** 严谨下载：网络抖动/连接中断导致的截断自动重试，杜绝「下载之后说不完整」。 */
async function fetchApkBytes(url: string, ui: ProgressUI, expectedSize?: number): Promise<Uint8Array> {
  const MAX = 3;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      return await fetchOnce(url, ui, expectedSize || 0, attempt, MAX);
    } catch (e) {
      lastErr = e;
      lastDownloadReleaseSign = '';
      if (attempt < MAX) {
        ui.set(0, ud('dlRetrying', '连接中断，正在重新下载…'));
        await new Promise(r => setTimeout(r, 600 * attempt));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr || '下载失败'));
}

/** 兜底：CapacitorHttp 原生下载，与取票据同一 UA，不受 WebView CORS / UA 差异影响 */
async function nativeFallbackBytes(url: string, ui: ProgressUI): Promise<Uint8Array> {
  ui.set(30, ud('dlNative', '切换原生通道下载…'));
  const r = await CapacitorHttp.request({
    method: 'GET', url, responseType: 'blob',
    connectTimeout: 30000, readTimeout: 180000,
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}（原生通道）`);
  const rh: Record<string, string> = (r as any).headers || {};
  const hit = Object.keys(rh).find(k => k.toLowerCase() === 'x-release-sign');
  lastDownloadReleaseSign = hit ? String(rh[hit] || '') : '';
  const b64 = typeof r.data === 'string' ? r.data : '';
  if (!b64) throw new Error('原生通道返回为空');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 整包 SHA-256（十六进制）。crypto.subtle 在 WebView(https://localhost) 与 Electron(file://) 均可用。 */
async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  const buf = await crypto.subtle.digest('SHA-256', view);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 下载后的端到端完整性校验（信任链：服务端验签/验包名 → 端上验哈希）。
 * 任一不符立即抛错，绝不写盘、绝不进安装器：
 *   - 体积必须与服务端登记值一致（防截断 / 拼接 / 换成别的包）
 *   - 魔数：APK=PK\x03\x04，EXE=MZ（防伪装成安装包的任意文件）
 *   - SHA-256 必须与 /api/update/check 下发的登记值完全一致（防中间人替换 / 降级到旧包）
 */
async function verifyDownload(bytes: Uint8Array, info: UpdateInfo, kind: 'apk' | 'exe'): Promise<void> {
  if (bytes.length < 1024 * 1024) throw new Error('安装包不完整');
  if (info.size && bytes.length !== info.size) {
    throw new Error(`安装包大小不符（应为 ${info.size} 字节，实际 ${bytes.length}）`);
  }
  const magic = kind === 'apk' ? [0x50, 0x4b, 0x03, 0x04] : [0x4d, 0x5a];
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) throw new Error('安装包格式错误（文件头不符）');
  }
  if (info.sha256) {
    const actual = await sha256HexOfBytes(bytes);
    if (actual.toLowerCase() !== info.sha256.toLowerCase()) {
      throw new Error('安装包校验失败（SHA-256 不一致），已阻止安装');
    }
  } else {
    // 服务端未下发哈希时（旧服务端）仍需最基本的完整性保证，并明确告警，绝不静默放行
    console.warn('[Updater] 服务端未下发 sha256，降级为魔数+体积校验；请升级服务端');
  }
  // 发布签名闭环：check 下发的签名必须与下载响应头一致，且两者都非空。
  // 这样即便有人替换了下载链路上的包，哈希与签名也无法同时对齐（防恶意换包）。
  if (info.releaseSign) {
    if (!lastDownloadReleaseSign
        || lastDownloadReleaseSign.toLowerCase() !== info.releaseSign.toLowerCase()) {
      throw new Error('安装包发布签名校验失败（可能被替换为非官方包），已阻止安装');
    }
  }
}

/** 下载失败后点「取消」：放弃本次更新。
 *  关闭失败弹窗后既不重试、也不再弹更新窗；不写入任何抑制标记，
 *  下次冷启动仍会重新检查（升级通道需永久保留，随时可能发新版）。 */
function cancelUpdate() {
  toast('已取消更新');
}

/**
 * Android 原生后台下载通道：点击更新后启动前台服务，
 * App 切后台 / 锁屏 / 清除到后台都继续下载，通知栏显示「后台更新中」与进度，
 * 完成后通知栏「点击安装」；WebView 在前台时进度窗同步显示。
 *
 * 返回 true 表示已接管（结果通过 updateEvent 事件处理，调用方直接 return）；
 * 返回 false 表示原生通道不可用（旧包 / 启动失败），调用方回退 WebView 下载。
 * 事件回调里 done/failed 都先摘掉监听，避免重试时重复注册。
 */
async function tryNativeBackgroundDownload(
  info: UpdateInfo, url: string, ui: ProgressUI,
): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  let handle: { remove?: () => void } | undefined;
  // done/failed 只处理一次（重试会重新走整条链路）
  let settled = false;
  try {
    handle = (XuanNative as any).addListener?.('updateEvent', (e: any) => {
      const type = String(e?.type || '');
      if (type === 'progress') {
        const received = Number(e?.received || 0);
        const total = Number(e?.total || 0);
        const pct = total > 0 ? (received / total) * 100 : Math.min(95, (received / (info.size || 15 * 1048576)) * 100);
        const a = (received / 1048576).toFixed(1);
        const b = (total / 1048576).toFixed(1);
        ui.set(pct, total > 0
          ? ud('dlProgressTotal', '已下载 {a} MB / {b} MB').replace('{a}', a).replace('{b}', b)
          : ud('dlProgress', '已下载 {a} MB').replace('{a}', a));
        return;
      }
      if (settled) return;
      settled = true;
      try { handle?.remove?.(); } catch { /* noop */ }
      if (type === 'done' && e?.path) {
        ui.set(100, '正在校验安装包完整性…');
        ui.done(true, () => { void installApk(String(e.path)); }, undefined, '安装',
          '后台下载完成，完整性校验通过；也可点击通知栏「安装」直接更新');
      } else if (type === 'failed') {
        const msg = String(e?.msg || '未知错误');
        // 强制更新不允许「取消」（否则可绕过强制窗），只有普通更新提供该按钮。
        ui.done(false, () => retryUpdate(info, downloadApk), msg,
          undefined, undefined, info.force ? undefined : cancelUpdate);
      }
    });
    await (XuanNative as any).backgroundDownload({
      url,
      fileName: 'xuan-update.apk',
      expectedSize: info.size || 0,
      expectedSha256: info.sha256 || '',
      expectedSign: info.releaseSign || '',
      versionName: info.versionName || '',
    });
    return true;
  } catch (e) {
    // backgroundDownload 调用本身失败（旧包无此方法 / 服务启动失败）→ 回退 WebView 通道
    settled = true;
    try { handle?.remove?.(); } catch { /* noop */ }
    console.warn('[Updater] 原生后台下载不可用，回退 WebView 通道:', e);
    return false;
  }
}

/** 下载/校验失败后重新弹出更新窗重试：
 *  强制更新 → 仍是「只有更新按钮」的强制窗，杜绝绕过；
 *  普通更新 → 恢复「取消 + 确定」的普通窗，用户可选择重试或稍后再说。 */
function retryUpdate(info: UpdateInfo, action: (i: UpdateInfo) => void) {
  window.setTimeout(() => showUpdateDialog(info, () => action(info)), 400);
}

async function downloadApk(info: UpdateInfo) {
  const ui = showProgressDialog();
  try {
    const url = await downloadUrl(info.downloadUrl || '', info.fileName);
    // Android 优先原生后台通道：切后台 / 锁屏继续下载，通知栏显示进度与安装入口；
    // 原生不可用时（旧包 / 服务启动失败）回退 WebView 下载。
    if (await tryNativeBackgroundDownload(info, url, ui)) return;
    lastDownloadReleaseSign = '';
    let bytes: Uint8Array;
    try {
      bytes = await fetchApkBytes(url, ui, info.size);
    } catch (e1) {
      if (!Capacitor.isNativePlatform()) throw e1;
      lastDownloadReleaseSign = '';
      bytes = await nativeFallbackBytes(url, ui);
    }
    ui.set(100, '正在校验安装包完整性…');
    await verifyDownload(bytes, info, 'apk');
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/vnd.android.package-archive' });
    const path = await writeApkToPrivate(blob);
    ui.done(true, () => { void installApk(path); }, undefined, '安装',
      '签名与完整性校验通过，点击下方按钮安装，安装后即为新版本');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e || '未知错误');
    // 强制更新不允许「取消」（否则可绕过强制窗），只有普通更新提供该按钮。
    ui.done(false, () => retryUpdate(info, downloadApk), msg,
      undefined, undefined, info.force ? undefined : cancelUpdate);
  }
}

/** Windows 桌面版：下载 → 严格校验 → 交给系统下载管理器（用户运行 Setup 覆盖安装）。 */
async function downloadDesktopExe(info: UpdateInfo) {
  const ui = showProgressDialog('正在下载桌面版更新');
  try {
    const url = await downloadUrl(info.downloadUrl || '', info.fileName);
    lastDownloadReleaseSign = '';
    const bytes = await fetchApkBytes(url, ui, info.size);
    ui.set(100, '正在校验安装包完整性…');
    await verifyDownload(bytes, info, 'exe');
    const blob = new Blob([bytes.buffer as ArrayBuffer],
      { type: 'application/vnd.microsoft.portable-executable' });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = `小轩音乐桌面版-Setup-${info.versionName || 'latest'}.exe`;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    ui.done(true, () => {}, undefined, '完成',
      '完整性校验通过，安装包已保存到下载目录，请运行 Setup 覆盖安装');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e || '未知错误');
    ui.done(false, () => retryUpdate(info, downloadDesktopExe), msg,
      undefined, undefined, info.force ? undefined : cancelUpdate);
  }
}

async function writeApkToPrivate(blob: Blob): Promise<string> {
  // 通过原生插件写入应用私有目录（FileProvider 可共享给系统安装器）
  const base64 = await new Promise<string>(resolve => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.readAsDataURL(blob);
  });
  if (!base64) throw new Error('安装包数据为空');
  const r = await (XuanNative as any).saveApk?.({ base64, name: 'xuan-update.apk' });
  if (!r?.path) throw new Error('写入安装包失败');
  return r.path as string;
}

async function installApk(path: string) {
  try { await XuanNative.installApk({ path }); } catch { /* 用户可稍后手动安装 */ }
}

/** Windows 桌面版由 Electron preload 注入 __xuanDesktop=true；网页端没有该标记。 */
const isDesktop = (): boolean =>
  typeof window !== 'undefined' &&
  (window as unknown as { __xuanDesktop?: boolean }).__xuanDesktop === true;

let updaterStarted = false;

/**
 * 启动时调用：安卓 App 检查 APK 通道；Windows 桌面版检查 exe 通道；纯网页端不检查。
 * 「第一时间」：不等待配置拉取（initXuanServer 的 fetchServerConfig/SSE），
 * 票据由 checkUpdate 内部按需自取，因此这里直接并行发起更新检查，
 * 让新版本弹窗在应用起来后立刻呈现，而不是被其它初始化串行阻塞。
 * 每次冷启动都会执行一遍；点取消只关本次弹窗，下次启动照样弹。
 */
export async function initAppUpdater() {
  if (updaterStarted) return;
  updaterStarted = true;
  const desktop = isDesktop();
  if (!Capacitor.isNativePlatform() && !desktop) return;
  // 桌面版读服务端 updateWindows 段（与安卓 APK 通道完全独立）
  const info = await checkUpdate(false, desktop ? 'windows' : 'android');
  const current = await resolveCurrentVersionCode();
  if (!info || !info.hasApk || info.versionCode <= current) return;
  if (desktop) {
    // exe 无法像 APK 那样静默安装：确认后先严格校验整包哈希/大小/PE 头，
    // 通过后才交给系统下载管理器，用户运行 Setup 覆盖安装即可（同 appId、数据保留）。
    showUpdateDialog(info, () => { void downloadDesktopExe(info); });
    return;
  }
  showUpdateDialog(info, () => { void downloadApk(info); });
}

/**
 * 手动「检查更新」：供设置页按钮调用。
 * - 有可用更新 → 弹出与启动一致的更新弹窗（服务端返回的即最新版，点确定一次性更到最新）；
 * - 已是最新 → 轻提示「已是最新版本」。
 * 安卓走 APK 通道、Windows 桌面走 exe 通道，纯网页端提示无需更新。
 */
export async function manualCheckUpdate(): Promise<void> {
  const desktop = isDesktop();
  if (!Capacitor.isNativePlatform() && !desktop) {
    toast('网页版无需更新');
    return;
  }
  const info = await checkUpdate(false, desktop ? 'windows' : 'android');
  const current = await resolveCurrentVersionCode();
  if (!info || !info.hasApk || info.versionCode <= current) {
    toast('已是最新版本');
    return;
  }
  showUpdateDialog(info, () => {
    if (desktop) {
      void downloadDesktopExe(info);
    } else {
      void downloadApk(info);
    }
  });
}

// ---------------------------------------------------------------- 状态栏媒体通知
export async function updateMediaNotification(o: MediaOptions) {
  if (!Capacitor.isNativePlatform()) return;
  try { await XuanNative.updateMedia(o as any); } catch { /* noop */ }
}
export async function hideMediaNotification() {
  if (!Capacitor.isNativePlatform()) return;
  try { await XuanNative.hideMedia(); } catch { /* noop */ }
}

/** 监听状态栏通知按钮（播放/暂停、上一首、下一首、收藏） */
export function onMediaAction(handler: (action: 'play' | 'pause' | 'prev' | 'next' | 'like') => void) {
  if (!Capacitor.isNativePlatform()) return () => {};
  const h = (XuanNative as any).addListener('mediaAction', (e: any) => handler(e?.action));
  return () => { void h.then((x: any) => x?.remove?.()); };
}
