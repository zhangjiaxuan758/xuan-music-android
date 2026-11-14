// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
/**
 * 小轩音乐 · 统一服务端连接层
 * ------------------------------------------------------------------
 * 客户端 / 网页端共用同一份实现：
 *   - 启动拉取一次性票据 → 拉全量配置 → 建立 SSE 长连接
 *   - 管理端保存配置后，服务端广播 config 事件，此处热应用（不刷新、不重启）
 *   - 网易云 eapi 全部走服务端代理，客户端不保存任何密钥
 *   - 所有请求带 HMAC 签名 + 时间戳 + nonce，防重放
 *
 * 域名：__XUAN_SERVER_BASE__  （网页端同源，客户端用 CapacitorHttp 绕过 WebView 跨域）
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { EP, SERVER_URL, SIGN_SECRET } from './secretBox';
import { ensureAttest, attestSession, invalidateAttest, fetchTicketWithProof, getAppCode } from './appAttest';
import { showServiceClosed } from './featureGates';
import { applyRemoteResources } from './remoteResources';
import { readGithubSession } from './githubSession';
import { routeUrl, refreshRoutes } from './routeMap';
import { netShaHex, netHmacHex } from './xuanNet';
import type { RemoteResourcesPayload } from './remoteResources';

export const XUAN_SERVER = SERVER_URL;

// 应用级签名密钥：仅用于握手、更新检查、管理端与公开下载等通道。
// 音乐/配置等业务接口的签名密钥由服务端在应用身份证明通过后逐会话下发，
// 静态密钥单独无法调用任何业务接口（防逆向脚本直连）。
const APP_SIGN_SECRET = SIGN_SECRET;

/** 强制走「会话密钥 + 应用证明令牌」的业务接口。
 *  EP[57] = 一次性下载票据换票接口，必须走证明会话，防止匿名脚本批量换票。
 *  EP[58] = 远程资源下发接口；别人访问一律 404，只有完整证明的正版软件可取。 */
const ATTEST_PATHS = new Set<string>([EP[43], EP[44], EP[57], EP[58]]);

export interface XuanTab { id: string; label: string; visible: boolean; order: number }
export interface XuanDevPick { id: number; name: string; artist: string }
export interface XuanConfig {
  version: number;
  serverTime?: number;
  app: { name: string; subtitle: string; showDevRecommend: boolean; showHotChart: boolean; showGufengChart: boolean; showCache: boolean };
  tabs: XuanTab[];
  developerPicks: XuanDevPick[];
  charts: Record<string, { playlistId: number; label: string }>;
  quality: { default: string; maxFree: string };
  effects: { enabled: boolean; bass: number; surround: number; limit: number };
  ui: {
    immersiveDoubleTap: boolean; buttonFadeDuration: number; lyricsFontSize: number;
    progressShowPrevNext: boolean; showStatusBarFavorite: boolean;
  };
  announcement: { enabled: boolean; title: string; content: string; id: number };
  texts: Record<string, string>;
  links: { official: string };
  /** 服务端按版本下发的功能门控（新功能不显示 / 关闭显示已关闭） */
  features?: Record<string, { allowed: boolean; closed: boolean; hidden: boolean; offText: string }>;
  update: { versionCode: number; versionName: string; apkFile: string; changelog: string; force: boolean };
  updateWindows?: { versionCode: number; versionName: string; exeFile: string; changelog: string; force: boolean };
}

const isNative = () => Capacitor.isNativePlatform();

let ticket = '';
let ticketExpire = 0;
let cfg: XuanConfig | null = null;
const listeners = new Set<(c: XuanConfig) => void>();
let started = false;
let sseAbort: AbortController | null = null;
let reconnectTimer: number | null = null;
let updateListener: ((u: UpdateInfo) => void) | null = null;

export interface UpdateInfo {
  versionCode: number; versionName: string; changelog: string;
  downloadUrl: string; force: boolean; hasApk: boolean;
  /** 服务端对发布包做完整签名/包名校验后登记的整包 SHA-256 与字节数，端上下载后逐字节复核 */
  sha256?: string; size?: number;
  /** 服务端下发的真实文件名：动态下载路径已不含文件名，换一次性票据时用它 */
  fileName?: string;
  /** 服务端对新包身份的发布签名（每次管理端上传都会重算），下载响应头须与之一致 */
  releaseSign?: string;
}

// ---------------------------------------------------------------- 基础 HTTP
// 请求签名 / 隐蔽版本号 / 会话密钥派生全部走 C++ 网络层核心（wasm），JS 侧不碰密码学。
async function hmacSha256Hex(secret: string, msg: string): Promise<string> {
  return netHmacHex(secret, msg);
}

async function sha256Hex(data: string): Promise<string> {
  return netShaHex(data);
}

function nonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function ensureTicket(): Promise<string> {
  if (ticket && Date.now() < ticketExpire - 5000) return ticket;
  const r = await fetchTicketWithProof();
  if (r.ticket) {
    ticket = r.ticket;
    ticketExpire = Date.now() + 55000; // 票据 60s 时效，留 5s 余量
    return ticket;
  }
  return '';
}

async function signHeaders(method: string, path: string, body: string, adminToken = '', bodyBytes?: Uint8Array, forceAttest = false): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const n = nonce();
  // 二进制上传（APK）时按真实字节计算摘要，与服务端校验严格一致
  const bodyHash = bodyBytes
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bodyBytes.buffer as ArrayBuffer))).map(b => b.toString(16).padStart(2, '0')).join('')
    : await sha256Hex(body);
  const t = await ensureTicket();
  // 业务接口：先完成应用身份证明，签名改用服务端下发的会话专属密钥
  let sess: ReturnType<typeof attestSession> = null;
  if (forceAttest || ATTEST_PATHS.has(path)) {
    await ensureAttest();
    sess = attestSession();
  }
  const key = sess ? sess.key : await sha256Hex(APP_SIGN_SECRET + '|' + t);
  const sign = await hmacSha256Hex(key, `${ts}|${n}|${path}|${bodyHash}`);
  const gh = readGithubSession();
  // 版本号多通道隐蔽校验：头里不出现任何版本号字样，服务端按候选范围反推并
  // 与证明会话里的权威版本交叉比对（三路独立派生，逆向脚本无法直接伪造）。
  const vc = Number(__XUAN_VERSION_CODE__ || 0);
  const cal = await hmacSha256Hex(`${APP_SIGN_SECRET}|vc-cal`, `${vc}|${ts}|${n}`);
  const seq = await hmacSha256Hex(`${APP_SIGN_SECRET}|vc-seq`, `${vc}|${n}|${path}`);
  const loc = await hmacSha256Hex(`${APP_SIGN_SECRET}|vc-loc`, `${vc}|${ts}|${path}`);
  return {
    'X-Xuan-Ts': ts,
    'X-Xuan-Nonce': n,
    'X-Xuan-Sign': sign,
    'X-Xuan-Ticket': t,
    'X-Xuan-Cal': cal,
    'X-Xuan-Seq': seq,
    'X-Xuan-Loc': loc,
    ...(gh ? { 'X-Xuan-Gh': gh } : {}),
    ...(sess ? { 'X-Xuan-Attest': sess.token } : {}),
    // 服务端下发并校验的软件辨别码：新版功能接口必须原样带回
    ...(getAppCode() ? { 'X-Xuan-App-Code': getAppCode() } : {}),
    ...(adminToken ? { 'X-Xuan-Admin-Token': adminToken } : {}),
  };
}

async function rawGet(path: string): Promise<{ ok: boolean; data: any; status: number }> {
  const url = await routeUrl(path);
  try {
    if (isNative()) {
      const r = await CapacitorHttp.get({ url, responseType: 'json', connectTimeout: 12000, readTimeout: 12000 });
      return { ok: r.status >= 200 && r.status < 300, data: r.data, status: r.status };
    }
    const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, data, status: r.status };
  } catch {
    return { ok: false, data: null, status: 0 };
  }
}

async function signedRequest<T = any>(method: 'GET' | 'POST', path: string, payload?: any, adminToken = ''): Promise<T | null> {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const url = await routeUrl(path);
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = await signHeaders(method, path, body, adminToken);
    try {
      let status: number; let data: any;
      if (isNative()) {
        const r = await CapacitorHttp.request({
          method, url, headers: { ...headers, 'Content-Type': 'application/json' },
          data: body || undefined, responseType: 'json', connectTimeout: 20000, readTimeout: 20000,
        });
        status = r.status; data = r.data;
      } else {
        const r = await fetch(url, {
          method, headers: { ...headers, 'Content-Type': 'application/json' },
          body: body || undefined, credentials: 'omit', cache: 'no-store',
        });
        status = r.status; data = await r.json().catch(() => null);
      }
      // 会话过期 / 服务端轮换纪元 / 网络段变化时重新证明一次再重试
      if (status === 401 && attempt === 0 && ATTEST_PATHS.has(path)) {
        invalidateAttest();
        continue;
      }
      return { ok: status >= 200 && status < 300, status, ...(data || {}) } as T;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 配置与实时同步
export const getServerConfig = (): XuanConfig | null => cfg;

export function onServerConfigChange(fn: (c: XuanConfig) => void): () => void {
  listeners.add(fn);
  if (cfg) fn(cfg);
  return () => { listeners.delete(fn); };
}

function applyConfig(next: XuanConfig) {
  if (cfg && next.version === cfg.version) return;
  cfg = next;
  try { localStorage.setItem('xuan_server_config', JSON.stringify(next)); } catch { /* noop */ }
  // 暴露给无依赖模块（audioEffects 等）读取远程开关
  try { (window as unknown as { __xuanServerConfig?: XuanConfig }).__xuanServerConfig = next; } catch { /* noop */ }
  listeners.forEach(fn => { try { fn(next); } catch { /* noop */ } });
  try { window.dispatchEvent(new CustomEvent('xuan:server-config', { detail: next })); } catch { /* noop */ }
}

export async function fetchServerConfig(): Promise<XuanConfig | null> {
  const r = await signedRequest<{ ok: boolean; version: number } & XuanConfig>('GET', EP[43]);
  if (r && r.ok && (r as any).tabs) { applyConfig(r as unknown as XuanConfig); return cfg; }
  return cfg;
}

/** 拉取服务端远程资源（页面 / 功能 / 更新弹窗）。
 *  必须走证明会话 + 会话密钥签名；失败或 404 一律静默回退内置默认，
 *  远程资源永不是功能可用性的前提。签名路径不含 query，故此处拉全量。 */
export async function fetchRemoteResources(): Promise<boolean> {
  const r = await signedRequest<RemoteResourcesPayload>('GET', EP[58]);
  return applyRemoteResources(r);
}

export function onServerUpdate(fn: (u: UpdateInfo) => void) { updateListener = fn; }

async function openSSE() {
  sseAbort?.abort();
  sseAbort = new AbortController();
  // SSE 同样必须通过应用身份证明：签名头用会话密钥签发并携带会话令牌
  const streamPath = EP[52].split('?')[0];
  const url = await routeUrl(streamPath);
  try {
    if (isNative()) {
      // CapacitorHttp 不支持流式，native 端用低间隔增量轮询兜底（同样不重启、热应用）
      startNativePolling();
      return;
    }
    const headers = await signHeaders('GET', streamPath, '', '', undefined, true);
    const resp = await fetch(url, { headers, signal: sseAbort.signal, credentials: 'omit', cache: 'no-store' });
    if (resp.status === 401) invalidateAttest();
    if (!resp.ok || !resp.body) throw new Error('sse failed');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        const ev = /^event:\s*(\S+)/m.exec(part)?.[1] || '';
        const dataLine = /^data:\s*(.+)$/m.exec(part)?.[1];
        if (!dataLine) continue;
        try {
          const payload = JSON.parse(dataLine);
          if (ev === 'config' && payload.config) applyConfig(payload.config);
          else if (ev === 'config' && payload.version) fetchServerConfig();
          // 服务端 update 事件只作通知，其载荷字段与 UpdateInfo 不一致；
          // 重新拉取权威的 checkUpdate，避免更新弹窗拿到 undefined 版本信息。
          else if (ev === 'update') void checkUpdate(true);
          else if (ev === 'resources') void fetchRemoteResources();
          else if (ev === 'hello' && payload.version && (!cfg || payload.version !== cfg.version)) fetchServerConfig();
        } catch { /* noop */ }
      }
    }
  } catch {
    // 断线重连
  } finally {
    if (!sseAbort?.signal.aborted) scheduleReconnect();
  }
}

let nativePollTimer: number | null = null;
function startNativePolling() {
  if (nativePollTimer) return;
  nativePollTimer = window.setInterval(async () => {
    await fetchServerConfig();
    await fetchRemoteResources();
    await checkUpdate(false);
  }, 4000);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    openSSE();
  }, 3000);
}

/** 应用启动时调用一次 */
export async function initXuanServer() {
  if (started) return;
  started = true;
  // 启动第一件事：向裸域名引导，拿到本 5 分钟窗口的动态接口路径表
  await refreshRoutes();
  try {
    const cached = localStorage.getItem('xuan_server_config');
    if (cached) { try { cfg = JSON.parse(cached); (window as unknown as { __xuanServerConfig?: XuanConfig }).__xuanServerConfig = cfg ?? undefined; } catch { /* noop */ } }
  } catch { /* noop */ }
  await fetchServerConfig();
  // 远程资源必须在证明会话就绪后拉取（fetchServerConfig 已完成握手）
  void fetchRemoteResources();
  openSSE();
  // 断网恢复后立刻重连
  window.addEventListener('online', () => { fetchServerConfig(); void fetchRemoteResources(); openSSE(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { fetchServerConfig(); void fetchRemoteResources(); }
  });
}

// ---------------------------------------------------------------- 网易云 eapi 代理
/**
 * 客户端不保存 eapiKey / eapiSalt，明文参数交给服务端加密转发。
 * 返回 { body, setCookie }，与旧版 officialRequest 完全兼容。
 */
export async function eapiRequest(apiPath: string, data: Record<string, unknown>, cookie: string): Promise<{ body: any; setCookie: string }> {
  const payload = JSON.stringify({ path: apiPath, data, cookie });
  const r = await signedRequest<{ ok: boolean; body: any; setCookie: string; code: number; message: string }>(
    'POST', EP[44], { path: apiPath, data, cookie });
  if (!r) return { body: { code: -1, message: '无法连接服务端' }, setCookie: '' };
  if (r.ok) return { body: (r as any).body ?? r, setCookie: (r as any).setCookie || '' };
  // 服务端远程关闭了某个功能：统一提示「服务端已关闭」，不当作普通网络错误
  const errText = String((r as any).error || (r as any).message || '');
  if (errText === '服务端已关闭' || ((r as any).status === 403 && errText.includes('服务端已关闭'))) {
    showServiceClosed('服务端已关闭');
    return { body: { code: -1, message: '服务端已关闭' }, setCookie: '' };
  }
  return { body: { code: -1, message: (r as any).message || '服务端请求失败' }, setCookie: '' };
}

// ---------------------------------------------------------------- 更新检查
export async function checkUpdate(notify = true, platform: 'android' | 'windows' = 'android'): Promise<UpdateInfo | null> {
  const path = platform === 'windows' ? EP[45] : EP[46];
  const r = await signedRequest<UpdateInfo & { ok: boolean }>('GET', path);
  if (!r || !r.ok) return null;
  const info: UpdateInfo = {
    versionCode: r.versionCode, versionName: r.versionName,
    changelog: r.changelog, downloadUrl: r.downloadUrl,
    force: r.force, hasApk: r.hasApk,
    sha256: r.sha256, size: r.size, releaseSign: (r as any).releaseSign,
    fileName: (r as any).fileName || '',
  };
  if (notify && updateListener) updateListener(info);
  return info;
}

/**
 * 换取「下载专用一次性票据」dlt。
 * 下载链接里绝不能再出现全功能证明会话令牌：URL 会进 nginx 日志、Referer、
 * 浏览器历史与分享链接，一旦外泄别人即可复用该会话调用功能接口（歌曲 / 扫码登录等）。
 * dlt 只能用于指定文件的一次下载，3 分钟过期、用完即焚，且与会话令牌格式互不兼容，
 * 永远无法用于 /api/eapi 等任何业务接口。
 */
async function downloadTicket(name: string): Promise<string> {
  try {
    const r = await signedRequest<{ dlt?: string }>('POST', EP[57], { name });
    return r?.dlt || '';
  } catch {
    return '';
  }
}

export async function downloadUrl(path: string, fileName = ''): Promise<string> {
  const t = await ensureTicket();
  // 下载必须来自已证明的正版客户端；新版改用一次性票据，链接里不再带会话令牌。
  await ensureAttest();
  const sess = attestSession();
  const sep = path.includes('?') ? '&' : '?';
  const name = (fileName || (path.split('?')[0].split('/').pop() || '')).trim();
  const resolved = await routeUrl(path);
  if (sess && name) {
    const dlt = await downloadTicket(name);
    if (dlt) return `${resolved}${sep}dlt=${encodeURIComponent(dlt)}`;
  }
  // 兼容兜底：换票失败（旧服务端 / 网络抖动）时仍保留原有更新能力，零误伤；
  // 服务端依旧要求有效证明会话，匿名票据下载一律 404。
  let url = `${resolved}${sep}ticket=${encodeURIComponent(t)}`;
  if (sess) url += `&attest=${encodeURIComponent(sess.token)}`;
  return url;
}

// ---------------------------------------------------------------- 管理端 API（管理端 App 复用本文件）
export async function adminLogin(password: string): Promise<string | null> {
  const r = await signedRequest<{ token: string }>('POST', EP[47], { password });
  return r?.token || null;
}
export async function adminGetConfig(token: string): Promise<XuanConfig | null> {
  const r = await signedRequest<XuanConfig & { ok: boolean }>('GET', EP[48], undefined, token);
  return r && (r as any).tabs ? r : null;
}
export async function adminSaveConfig(token: string, config: XuanConfig): Promise<boolean> {
  const r = await signedRequest<{ ok: boolean }>('POST', EP[48], config, token);
  return !!r?.ok;
}
export async function adminUploadApk(token: string, file: Blob, name: string, versionCode: number, versionName: string, changelog: string): Promise<boolean> {
  const ab = await file.arrayBuffer();
  const body = new Uint8Array(ab);
  const headers = await signHeaders('POST', EP[49], '', token, body);
  const url = await routeUrl(EP[49]);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
        'X-Xuan-Apk-Name': name,
        'X-Xuan-Version-Code': String(versionCode),
        'X-Xuan-Version-Name': versionName,
        'X-Xuan-Changelog': encodeURIComponent(changelog),
      },
      body,
    });
    return r.ok;
  } catch { return false; }
}

export async function adminChangePassword(token: string, password: string): Promise<boolean> {
  const r = await signedRequest<{ ok: boolean }>('POST', EP[50], { password }, token);
  return !!r?.ok;
}
