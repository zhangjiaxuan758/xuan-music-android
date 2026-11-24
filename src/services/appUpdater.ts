// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================


import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { checkUpdate, downloadUrl, initXuanServer, type UpdateInfo } from './xuanServer';
import { netSha256Bytes } from './xuanNet';
import { ud, udVer, udTheme } from './remoteResources';
import { markOverlay, setDownloadActive, setForceGuardRelease } from './uiUnlockGuard';

const XuanNative = registerPlugin<{
  
  installApk(options: {
    path: string; expectedVersionCode?: number; expectedVersionName?: string;
    expectedPackageName?: string;
  }): Promise<{ ok: boolean }>;
  getApkVersion(): Promise<{ versionCode: number; versionName: string }>;
  updateMedia(options: MediaOptions): Promise<void>;
  hideMedia(): Promise<void>;
  
  backgroundDownload(options: {
    url: string; fileName: string; expectedSize: number;
    expectedSha256: string; expectedSign: string; versionName: string;
    expectedVersionCode?: number;
    
    startOffset?: number;
  }): Promise<{ ok: boolean }>;
} & Record<string, any>>('XuanNative');

export interface MediaOptions {
  title: string; artist: string; playing: boolean; cover?: string | null;
  showFavorite: boolean; liked: boolean;
  // 流体云/系统媒体卡片：时长、进度（毫秒）、当前歌词行（OPPO/欢太读取展示）
  duration?: number; position?: number; lyrics?: string;
}

declare const __XUAN_VERSION_CODE__: number | undefined;
export const CURRENT_VERSION_CODE: number =
  (typeof __XUAN_VERSION_CODE__ !== 'undefined' ? __XUAN_VERSION_CODE__ : 10661);

function uniqueApkName(info: UpdateInfo): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `xuan-update-${info.versionCode || 'new'}-${Date.now().toString(36)}-${rand}.apk`;
}

interface DownloadedUpdate {
  path: string;
  versionCode: number;
  versionName: string;
  sha256: string;
}

const DOWNLOADED_KEY = 'xuan_downloaded_update';

function markDownloaded(info: UpdateInfo, path: string): void {
  try {
    const rec: DownloadedUpdate = {
      path, versionCode: Number(info.versionCode) || 0,
      versionName: String(info.versionName || ''), sha256: String(info.sha256 || ''),
    };
    localStorage.setItem(DOWNLOADED_KEY, JSON.stringify(rec));
  } catch {  }
}

function clearDownloaded(): void {
  try { localStorage.removeItem(DOWNLOADED_KEY); } catch {  }
}

async function readDownloaded(): Promise<DownloadedUpdate | null> {
  try {
    const raw = localStorage.getItem(DOWNLOADED_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as DownloadedUpdate;
    if (!rec || !rec.path || !(Number(rec.versionCode) > 0)) return null;
    return rec;
  } catch { return null; }
}

/** 若本地已存在与 info 版本完全一致的已下载包，返回可安装信息；否则 null */
async function findReadyDownload(info: UpdateInfo): Promise<DownloadedUpdate | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const rec = await readDownloaded();
  if (!rec) return null;
  if (Number(rec.versionCode) !== Number(info.versionCode)) { clearDownloaded(); return null; }
  try {
    const probe = await (XuanNative as any).probeApk({ path: rec.path });
    if (!probe?.exists || Number(probe.versionCode) !== Number(info.versionCode)) {
      clearDownloaded();
      return null;
    }
    return rec;
  } catch { return null; }
}

export async function resolveCurrentVersionCode(): Promise<number> {
  // 编译期注入的 CURRENT_VERSION_CODE 与本机 APK 的 versionCode 由同一构建脚本产出，
  // 恒等且可靠。原生 getApkVersion 在部分设备（Android 16）会失败或返回旧会话残留值，
  // 若盲目信任它会把「已是最新版」误判成「有新版本」→ 打开软件/检查更新反复弹窗。
  // 取两者最大值：原生读到更高值（用户已升级）时采用它，否则用编译期版本码兜底。
  let best = CURRENT_VERSION_CODE;
  if (Capacitor.isNativePlatform()) {
    try {
      // 2.5 秒保险丝：Android 16 上原生 getApkVersion 可能挂起（既不 resolve 也
      // 不 reject），若无超时，检查更新会永久 pending → 点击后毫无提示。
      const v = await Promise.race([
        XuanNative.getApkVersion(),
        new Promise<null>(r => setTimeout(() => r(null), 2500)),
      ]);
      if (v && Number.isFinite(v.versionCode) && v.versionCode > 0) {
        best = Math.max(best, v.versionCode);
      }
    } catch {  }
  }
  return best;
}

export const DEFAULT_CHANGELOG = '修复已知问题，请尽快更新';

function el(tag: string, style: Partial<CSSStyleDeclaration>, text?: string): HTMLElement {
  const n = document.createElement(tag);
  Object.assign(n.style, style);
  if (text) n.textContent = text;
  return n;
}

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

let forceGuard: (() => void) | null = null;
let forceGuardTimer: number | null = null;
const FORCE_GUARD_MAX_MS = 3 * 60 * 1000;

function releaseForceGuard() {
  if (forceGuardTimer !== null) { window.clearTimeout(forceGuardTimer); forceGuardTimer = null; }
  if (!forceGuard) return;
  try { forceGuard(); } catch {  }
  forceGuard = null;
}

function installForceGuard() {
  releaseForceGuard();

  let pushed = false;
  try { history.pushState({ xuanForceUpdate: true }, ''); pushed = true; } catch {  }
  const onPop = () => {
    try { history.pushState({ xuanForceUpdate: true }, ''); } catch {  }
  };
  
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Back') {
      e.preventDefault(); e.stopPropagation();
    }
  };
  
  const onHide = () => { if (document.visibilityState === 'hidden') releaseForceGuard(); };
  const onPageHide = () => releaseForceGuard();
  window.addEventListener('popstate', onPop, true);
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('blur', onPageHide);
  forceGuard = () => {
    window.removeEventListener('popstate', onPop, true);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('blur', onPageHide);
    
    void pushed;
  };
  
  forceGuardTimer = window.setTimeout(() => releaseForceGuard(), FORCE_GUARD_MAX_MS);
}

setForceGuardRelease(releaseForceGuard);

function showUpdateDialog(info: UpdateInfo, onConfirm: () => void, readyPath?: string) {
  // dialogOpen 是内存态，弹窗若被系统回收/页面重建丢失，它仍可能是 true →
  // 用户再点检查更新时这里直接 return，表现为「点了没反应」。用真实 DOM 兜底校准。
  if (dialogOpen && document.getElementById('xuan-update-dialog')) return;
  dialogOpen = true;

  const th = udTheme();

  const forced = !!info.force;
  const overlay = el('div', {
    position: 'fixed', inset: '0', zIndex: '99999', display: 'flex',
    alignItems: 'center', justifyContent: 'center', background: th.overlay,
    backdropFilter: 'blur(6px)', fontFamily: 'system-ui, -apple-system, sans-serif',
  });

  markOverlay(overlay, 'update-overlay', true); // 持久弹窗：黑边自愈心跳不得误删
  overlay.id = 'xuan-update-dialog';
  overlay.setAttribute('data-xuan-overlay-at', String(Date.now()));
  const card = el('div', {
    width: 'min(420px, 86vw)', background: th.cardBg, color: th.cardFg,
    borderRadius: '18px', padding: '28px', boxShadow: '0 24px 70px rgba(0,0,0,.55)',
    border: '1px solid rgba(255,255,255,.08)',
  });
  const title = el('div', { fontSize: '19px', fontWeight: '700', marginBottom: '8px' },
    readyPath ? ud('dlDoneTitle', '下载完成') : (forced ? ud('titleForce', '必须更新后才能继续使用') : ud('titleNew', '已有新版本')));
  const ver = el('div', { fontSize: '13px', color: th.verColor, marginBottom: '14px' },
    udVer(info.versionName || '', info.versionCode));
  const desc = el('div', {
    fontSize: '13px', color: th.descColor, lineHeight: '1.7', marginBottom: '24px',
    maxHeight: '150px', overflowY: 'auto', whiteSpace: 'pre-wrap',
  }, (readyPath ? ud('dlDoneHint', '新版本安装包已下载完成并校验通过，点击下方按钮直接安装。') + '\n\n' : '')
    + ((info.changelog || '').trim() || ud('defaultChangelog', DEFAULT_CHANGELOG)));
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
  const confirmLabel = readyPath ? ud('btnInstall', '安装') : (forced ? ud('btnForce', '立即更新') : ud('btnConfirm', '确定'));
  if (forced) {
    const only = btn(confirmLabel, true, () => { close(); onConfirm(); });
    only.style.flex = '1';
    row.append(only);
    installForceGuard();
  } else {
    const cancel = btn(ud('btnCancel', '取消'), false, () => { close(); });
    const confirm = btn(confirmLabel, true, () => { close(); onConfirm(); });
    row.append(cancel, confirm);
  }
  card.append(title, ver, desc, row);
  overlay.append(card);
  
  overlay.addEventListener('click', e => { e.stopPropagation(); });
  card.addEventListener('click', e => { e.stopPropagation(); });
  document.body.append(overlay);
}

interface ProgressUI {
  set: (pct: number, text: string) => void;
  
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

  markOverlay(overlay, 'update-overlay', true); // 持久弹窗：黑边自愈心跳不得误删
  overlay.setAttribute('data-xuan-overlay-at', String(Date.now()));
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

        const row = el('div', { display: 'flex', gap: '10px', marginTop: '20px' });
        row.append(
          mkBtn(ud('btnCancel', '取消'), false, () => { overlay.remove(); onCancel(); }, { flex: '1' }),
          mkBtn(ud('btnRetry', '重试'), true, () => { overlay.remove(); install(); }, { flex: '1' }),
        );
        card.append(row);
      } else {

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

let lastDownloadReleaseSign = '';

interface PartialDownload { chunks: Uint8Array[]; received: number; complete: boolean; }

async function fetchStreamOnce(
  url: string, ui: ProgressUI, expectedSize: number,
  attempt: number, maxAttempts: number,
  seed: Uint8Array[], offset: number,
): Promise<PartialDownload> {
  const headers: Record<string, string> = {};
  if (offset > 0) headers['Range'] = `bytes=${offset}-`;
  const res = await fetch(url, { credentials: 'omit', cache: 'no-store', headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  lastDownloadReleaseSign = res.headers.get('X-Release-Sign') || '';
  const declared = Number(res.headers.get('content-length') || 0);
  
  const resumed = offset > 0 && res.status === 206;
  const chunks: Uint8Array[] = resumed ? seed.slice() : [];
  let received = resumed ? offset : 0;
  const authoritative = expectedSize || (resumed ? offset + declared : declared) || 0;
  const reader = res.body?.getReader();
  if (!reader) throw new Error('不支持流式下载');
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const pct = authoritative ? (received / authoritative) * 100
      : Math.min(95, (received / (15 * 1048576)) * 100);
    const a = (received / 1048576).toFixed(1);
    const b = (authoritative / 1048576).toFixed(1);
    const prefix = attempt > 1
      ? ud('dlRetryTag', '重试 {n}/{m} · ').replace('{n}', String(attempt)).replace('{m}', String(maxAttempts))
      : '';
    ui.set(pct, prefix + (authoritative
      ? ud('dlProgressTotal', '已下载 {a} MB / {b} MB').replace('{a}', a).replace('{b}', b)
      : ud('dlProgress', '已下载 {a} MB').replace('{a}', a)));
  }
  return { chunks, received, complete: authoritative ? received === authoritative : true };
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const all = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { all.set(c, p); p += c.length; }
  return all;
}

async function fetchApkBytes(
  url: string, ui: ProgressUI, expectedSize?: number,
  renewUrl?: () => Promise<string>,
): Promise<Uint8Array> {
  const MAX = 5;
  const size = expectedSize || 0;
  let seed: Uint8Array[] = [];
  let offset = 0;
  let curUrl = url;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      if (attempt > 1 && renewUrl) {
        try {
          curUrl = await renewUrl();
        } catch {
          
          seed = []; offset = 0; curUrl = url;
        }
      }
      const r = await fetchStreamOnce(curUrl, ui, size, attempt, MAX, seed, offset);
      seed = r.chunks; offset = r.received;
      if (r.complete) return concatChunks(seed, offset);
      lastErr = new Error(`下载中断（已接收 ${offset} 字节）`);
    } catch (e) {
      lastErr = e;
      lastDownloadReleaseSign = '';
    }
    if (attempt < MAX) {
      ui.set(size ? (offset / size) * 100 : 0,
        offset > 0
          ? ud('dlResuming', '连接中断，已下载 {a} MB，正在续传…').replace('{a}', (offset / 1048576).toFixed(1))
          : ud('dlRetrying', '连接中断，正在重新下载…'));
      await new Promise(r => setTimeout(r, 600 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr || '下载失败'));
}

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

async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  // 纯原生 C++ 增量 SHA-256（分块喂入，避免整包 hex 翻倍）；无 Web Crypto。
  const v = await netSha256Bytes(bytes);
  if (v && /^[0-9a-f]{64}$/i.test(v)) return v;
  throw new Error('原生哈希引擎不可用，拒绝安装');
}

async function verifyDownload(bytes: Uint8Array, info: UpdateInfo, kind: 'apk' | 'exe'): Promise<void> {
  if (bytes.length < 1024 * 1024) throw new Error('安装包不完整');
  if (info.size && bytes.length !== info.size) {
    throw new Error(`安装包大小不符（应为 ${info.size} 字节，实际 ${bytes.length}）`);
  }
  const magic = kind === 'apk' ? [0x50, 0x4b, 0x03, 0x04] : [0x4d, 0x5a];
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) throw new Error('安装包格式错误（文件头不符）');
  }

  if (!/^[0-9a-f]{64}$/i.test(info.sha256 || '')) {
    throw new Error('安装包校验信息缺失（无 SHA-256），已拒绝安装');
  }
  const actual = await sha256HexOfBytes(bytes);
  if (actual.toLowerCase() !== (info.sha256 || '').toLowerCase()) {
    throw new Error('安装包校验失败（SHA-256 不一致），已阻止安装');
  }

  if (!/^[0-9a-f]{32,}$/i.test(info.releaseSign || '')) {
    throw new Error('安装包校验信息缺失（无发布签名），已拒绝安装');
  }
  if (!lastDownloadReleaseSign
      || lastDownloadReleaseSign.toLowerCase() !== (info.releaseSign || '').toLowerCase()) {
    throw new Error('安装包发布签名校验失败（可能被替换为非官方包），已阻止安装');
  }
}

function cancelUpdate() {
  toast('已取消更新');
}

async function tryNativeBackgroundDownload(
  info: UpdateInfo, url: string, ui: ProgressUI, startOffset = 0,
): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  let handle: { remove?: () => void } | undefined;
  let settled = false;
  let autoRetries = 0;
  const MAX_AUTO = 2;
  const detach = () => {
    try { handle?.remove?.(); } catch {  }
    handle = undefined;
  };
  
  const apkName = uniqueApkName(info);
  const startService = async (freshUrl: string, offset: number) => {
    await (XuanNative as any).backgroundDownload({
      url: freshUrl,
      fileName: apkName,
      expectedSize: info.size || 0,
      expectedSha256: info.sha256 || '',
      expectedSign: info.releaseSign || '',
      versionName: info.versionName || '',
      expectedVersionCode: info.versionCode || 0,
      startOffset: offset,
    });
  };
  const attach = () => {
    handle = (XuanNative as any).addListener?.('updateEvent', (e: any) => {
      const type = String(e?.type || '');
      if (type === 'progress') {
        const received = Number(e?.received || 0);
        const total = Number(e?.total || 0);
        const pct = total > 0 ? (received / total) * 100
          : Math.min(95, (received / (info.size || 15 * 1048576)) * 100);
        const a = (received / 1048576).toFixed(1);
        const b = (total / 1048576).toFixed(1);
        ui.set(pct, total > 0
          ? ud('dlProgressTotal', '已下载 {a} MB / {b} MB').replace('{a}', a).replace('{b}', b)
          : ud('dlProgress', '已下载 {a} MB').replace('{a}', a));
        return;
      }
      if (settled) return;
      if (type === 'done' && e?.path) {
        settled = true; detach();
        ui.set(100, '正在校验安装包完整性…');
        markDownloaded(info, String(e.path));
        ui.done(true, () => { void installApk(String(e.path), info); }, undefined, '安装',
          `已下载并校验版本 ${info.versionName || ''}（versionCode ${info.versionCode}）；` +
          `本次安装包使用全新文件名 ${apkName}，不会复用上一次的安装界面；也可点通知栏「安装」。`);
      } else if (type === 'failed') {
        const got = Number(e?.received || 0);

        if (got > 256 * 1024 && autoRetries < MAX_AUTO) {
          autoRetries += 1;
          detach();
          ui.set(info.size ? (got / info.size) * 100 : 0,
            ud('dlResuming', '连接中断，已下载 {a} MB，正在续传…').replace('{a}', (got / 1048576).toFixed(1)));
          void (async () => {
            try {
              const fresh = await downloadUrl(info.downloadUrl || '', info.fileName);
              attach();
              await startService(fresh, got);
            } catch {
              settled = true; detach();
              ui.done(false, () => retryUpdate(info, downloadApk), '续传失败，请重试',
                undefined, undefined, info.force ? undefined : cancelUpdate);
            }
          })();
          return;
        }
        settled = true; detach();
        const msg = String(e?.msg || '未知错误');
        ui.done(false, () => retryUpdate(info, downloadApk), msg,
          undefined, undefined, info.force ? undefined : cancelUpdate);
      }
    });
  };
  try {
    attach();
    await startService(url, startOffset);
    return true;
  } catch (e) {
    
    settled = true; detach();
    console.warn('[Updater] 原生后台下载不可用，回退 WebView 通道:', e);
    return false;
  }
}

function retryUpdate(info: UpdateInfo, action: (i: UpdateInfo) => void) {
  window.setTimeout(() => showUpdateDialog(info, () => action(info)), 400);
}

async function downloadApk(info: UpdateInfo) {
  const ui = showProgressDialog();
  
  setDownloadActive(true);
  try {
    
    if (!(await isInstallable(info))) {
      ui.done(true, () => {}, undefined, '知道了',
        `本机已是 ${info.versionName || '最新'}（versionCode ${info.versionCode}），无需重复安装。` +
        '若系统仍弹出旧版本界面，那是系统安装器复用了上一次的安装会话；' +
        '清掉通知栏旧的「更新已就绪」通知后重试即可，新版每次下载都用独立文件名。');
      return;
    }
    const renew = () => downloadUrl(info.downloadUrl || '', info.fileName);
    const url = await renew();

    if (await tryNativeBackgroundDownload(info, url, ui)) return;
    lastDownloadReleaseSign = '';
    let bytes: Uint8Array;
    try {
      bytes = await fetchApkBytes(url, ui, info.size, renew);
    } catch (e1) {
      if (!Capacitor.isNativePlatform()) throw e1;
      lastDownloadReleaseSign = '';
      const fresh = await renew();
      bytes = await nativeFallbackBytes(fresh, ui);
    }
    ui.set(100, '正在校验安装包完整性…');
    await verifyDownload(bytes, info, 'apk');
    if (!(await isInstallable(info))) {
      ui.done(true, () => {}, undefined, '知道了',
        '已是最新版本，无需重复安装（下载期间本机已完成更新）');
      return;
    }
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/vnd.android.package-archive' });
    const apkName = uniqueApkName(info);
    const path = await writeApkToPrivate(blob, apkName);
    markDownloaded(info, path);
    ui.done(true, () => { void installApk(path, info); }, undefined, '安装',
      `已下载并校验版本 ${info.versionName || ''}（versionCode ${info.versionCode}）。` +
      `本次安装包为全新文件名 ${apkName}，不会复用上一次的安装界面，点击下方按钮安装。`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e || '未知错误');
    
    ui.done(false, () => retryUpdate(info, downloadApk), msg,
      undefined, undefined, info.force ? undefined : cancelUpdate);
  } finally {

    setDownloadActive(false);
  }
}

async function downloadDesktopExe(info: UpdateInfo) {
  const ui = showProgressDialog('正在下载桌面版更新');
  try {
    const url = await downloadUrl(info.downloadUrl || '', info.fileName);
    lastDownloadReleaseSign = '';
    const bytes = await fetchApkBytes(url, ui, info.size,
      () => downloadUrl(info.downloadUrl || '', info.fileName));
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

async function isInstallable(info: UpdateInfo): Promise<boolean> {
  const current = await resolveCurrentVersionCode();
  return info.versionCode > current;
}

async function writeApkToPrivate(blob: Blob, name: string): Promise<string> {
  
  const base64 = await new Promise<string>(resolve => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.readAsDataURL(blob);
  });
  if (!base64) throw new Error('安装包数据为空');
  
  const r = await (XuanNative as any).saveApk?.({ base64, name, purgeOld: true });
  if (!r?.path) throw new Error('写入安装包失败');
  return r.path as string;
}

async function installApk(path: string, info?: UpdateInfo) {
  try {

    await XuanNative.installApk({
      path,
      expectedVersionCode: info?.versionCode || 0,
      expectedVersionName: info?.versionName || '',
    });
  } catch {
    toast('安装包版本校验未通过，已阻止安装旧包，请重新下载');
  }
}

const isDesktop = (): boolean =>
  typeof window !== 'undefined' &&
  (window as unknown as { __xuanDesktop?: boolean }).__xuanDesktop === true;

let updaterStarted = false;
let updateShown = false;

export async function initAppUpdater() {
  if (updaterStarted) return;
  updaterStarted = true;
  const desktop = isDesktop();
  if (!Capacitor.isNativePlatform() && !desktop) return;

  const platform = desktop ? 'windows' : 'android';

  const tryShow = async (): Promise<boolean> => {
    if (updateShown) return true;
    let info: UpdateInfo | null = null;
    for (let attempt = 0; attempt < 6 && !info; attempt++) {
      try {
        info = await checkUpdate(false, platform);
      } catch { info = null; }
      if (!info) await new Promise(r => setTimeout(r, attempt < 3 ? 1200 : 2500));
    }
    if (!info) return false;
    const current = await resolveCurrentVersionCode();
    if (!info.hasApk || info.versionCode <= current) return true;
    updateShown = true;
    // 若此前已下载过与最新版本完全一致的包且文件仍在，直接以「下载完成」状态弹窗，
    // 不重复下载；否则走正常下载弹窗。旧包（版本不一致）会被 findReadyDownload 丢弃，
    // 原生 installApk 另有版本硬校验，杜绝误装旧包。
    if (!desktop) {
      const ready = await findReadyDownload(info);
      if (ready) {
        showUpdateDialog(info, () => { void installApk(ready.path, info); }, ready.path);
        return true;
      }
    }
    if (desktop) showUpdateDialog(info, () => { void downloadDesktopExe(info); });
    else showUpdateDialog(info, () => { void downloadApk(info); });
    return true;
  };

  const ok = await tryShow();
  if (ok) return;

  // 冷启动时无网络：保留重试能力，等网络恢复或定时再次检查，避免「断网打开→联网后永不弹窗」。
  const stopGuard = { stopped: false };
  const retry = () => {
    if (stopGuard.stopped || updateShown) return;
    void tryShow().then(done => { if (done) stopGuard.stopped = true; });
  };
  window.addEventListener('online', retry);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') retry();
  });
  const timer = window.setInterval(() => {
    if (stopGuard.stopped || updateShown) {
      window.clearInterval(timer);
      window.removeEventListener('online', retry);
      return;
    }
    retry();
  }, 30_000);
  void timer;
}

export async function manualCheckUpdate(): Promise<void> {
  const desktop = isDesktop();
  if (!Capacitor.isNativePlatform() && !desktop) {
    toast('网页版无需更新');
    return;
  }
  // 12 秒保险丝：checkUpdate 底层走 signedRequest，握手未就绪/异常时可能永久
  // pending（既不 resolve 也不 reject），导致按钮永远停在「检查中…」且无任何提示。
  // 超时后按失败处理，给用户明确 toast。
  let info: UpdateInfo | null = null;
  try {
    info = await Promise.race([
      checkUpdate(false, desktop ? 'windows' : 'android'),
      new Promise<null>(r => setTimeout(() => r(null), 12000)),
    ]);
  } catch {
    info = null;
  }

  if (!info) {
    toast('检查更新失败，请检查网络后重试');
    return;
  }
  let current: number;
  try {
    current = await resolveCurrentVersionCode();
  } catch {
    current = CURRENT_VERSION_CODE;
  }
  if (!info.hasApk || info.versionCode <= current) {
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

export async function updateMediaNotification(o: MediaOptions) {
  if (!Capacitor.isNativePlatform()) return;
  try { await XuanNative.updateMedia(o as any); } catch {  }
}
export async function hideMediaNotification() {
  if (!Capacitor.isNativePlatform()) return;
  try { await XuanNative.hideMedia(); } catch {  }
}

export function onMediaAction(handler: (action: 'play' | 'pause' | 'prev' | 'next' | 'like') => void) {
  if (!Capacitor.isNativePlatform()) return () => {};
  const h = (XuanNative as any).addListener('mediaAction', (e: any) => handler(e?.action));
  return () => { void h.then((x: any) => x?.remove?.()); };
}

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|313869ac3b0b|5826568c23e4");}catch(_e){}
