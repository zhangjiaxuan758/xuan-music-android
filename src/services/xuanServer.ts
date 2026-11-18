// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================


import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { EP, SERVER_URL, SIGN_SECRET } from './secretBox';
import { ensureAttest, attestSession, invalidateAttest, fetchTicketWithProof, getAppCode, deviceSignV2, nativeVc } from './appAttest';
import { applyRemoteResources } from './remoteResources';
import { readGithubSession } from './githubSession';
import { routeUrl, refreshRoutes } from './routeMap';
import { netShaHex, netBuildAuth, netNetworkLayerDecl } from './xuanNet';
import { secureGet, secureSet } from './secureCache';
import { sealCookie } from './cookieCrypto';
import type { RemoteResourcesPayload } from './remoteResources';

export const XUAN_SERVER = SERVER_URL;

const APP_SIGN_SECRET = SIGN_SECRET;

// 测试端编译开关：beta 端走 beta 更新检查通道（读服务端 betaUpdate 槽），
// 正式版走原 update 通道。两段式发布：上传先进 beta，点发布才进正式 update。
export const IS_BETA = (typeof __XUAN_BETA__ !== 'undefined' && __XUAN_BETA__);

// 需要证明会话签名的接口（服务端 require_attest=True，静态签名一律 401 拒绝）。
// identity 四接口必须与服务端一致，否则 issue/exists/save/redeem 全部走静态签名被拒，
// 导致授权码下发/校验永远失败（服务端 vault 无记录 -> 输入本机码报“不存在”）。
const ATTEST_PATHS = new Set<string>([
  EP[43], EP[44], EP[57], EP[58],
  '/api/identity/issue', '/api/identity/exists', '/api/identity/save', '/api/identity/redeem',
  // 测试端发布按钮：服务端 require_attest=True，静态签名一律 401。
  '/api/beta/publish',
]);

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
  
  sha256?: string; size?: number;
  
  fileName?: string;
  
  releaseSign?: string;
}

async function sha256Hex(data: string): Promise<string> {
  // 纯原生 SHA-256：SO/.node 不可用时 fail-closed，绝不退回 Web Crypto/JS 公式。
  const v = await netShaHex(data);
  if (v === null) throw new Error('sign engine unavailable');
  return v;
}

function nonce(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const rand = Array.from(buf, b => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
  return `${Date.now().toString(36)}-${rand}`;
}

async function ensureTicket(): Promise<string> {
  if (ticket && Date.now() < ticketExpire - 5000) return ticket;
  const r = await fetchTicketWithProof();
  if (r.ticket) {
    ticket = r.ticket;
    ticketExpire = Date.now() + 55000; 
    return ticket;
  }
  return '';
}

async function signHeaders(method: string, path: string, body: string, adminToken = '', bodyBytes?: Uint8Array, forceAttest = false): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const n = nonce();
  
  // bodyHash 统一走原生 C++ SHA-256（长 body 由 256KB g_io 承载），
  // 无任何 Web Crypto 兜底；bodyBytes 入参保留仅为兼容签名，不再使用。
  const bodyHash = await sha256Hex(body);
  const t = await ensureTicket();
  
  let sess: ReturnType<typeof attestSession> = null;
  if (forceAttest || ATTEST_PATHS.has(path)) {
    await ensureAttest();
    sess = attestSession();
  }
  const key = sess ? sess.key : await sha256Hex(APP_SIGN_SECRET + '|' + t);
  const gh = readGithubSession();

  const vc = await nativeVc() || Number(__XUAN_VERSION_CODE__ || 0);

  
  // 签名公式只在 C++ 网络层（SO / wasm 的 xn_build_auth）内实现，
  // JS 侧不再保存任何 HMAC 拼接公式；native 与 wasm 都不可用时 fail-closed，
  // 绝不退化成 JS 明文公式（避免协议核心暴露 / wasm 被替换后双轨绕过）。
  const auth = await netBuildAuth({
    key, ts, nonce: n, path, bodyHash,
    secret: APP_SIGN_SECRET, vc: String(vc),
  });
  if (!auth) throw new Error('sign engine unavailable');
  const { sign, cal, seq, loc } = auth;
  return {
    'X-Xuan-Ts': ts,
    'X-Xuan-Nonce': n,
    'X-Xuan-Sign': sign,
    'X-Xuan-Ticket': t,
    'X-Xuan-Cal': cal,
    'X-Xuan-Seq': seq,
    'X-Xuan-Loc': loc,
    ...(sess?.sigV2 ? { 'X-Xuan-DevSig': await deviceSignV2(ts, n, path, bodyHash) } : {}),
    ...(gh ? { 'X-Xuan-Gh': gh } : {}),
    ...(sess ? { 'X-Xuan-Attest': sess.token } : {}),
    
    ...(getAppCode() ? { 'X-Xuan-App-Code': getAppCode() } : {}),
    ...(adminToken ? { 'X-Xuan-Admin-Token': adminToken } : {}),
  };
}

function guardIntegrity(data: any, status: number): void {
  if (!data) return;
  const err = String((data as any)?.error ?? (data as any)?.message ?? '');
  if (status === 403 || err.includes('integrity_failed') || err.includes('完整性校验失败')) {
    if (err.includes('integrity_failed') || err.includes('完整性校验失败')) {
      try { window.dispatchEvent(new CustomEvent('xuan:integrity-failed')); } catch {  }
    }
  }
}

async function rawGet(path: string): Promise<{ ok: boolean; data: any; status: number }> {
  const url = await routeUrl(path);
  try {
    if (isNative()) {
      const r = await CapacitorHttp.get({ url, responseType: 'json', connectTimeout: 12000, readTimeout: 12000 });
      guardIntegrity(r.data, r.status);
      return { ok: r.status >= 200 && r.status < 300, data: r.data, status: r.status };
    }
    const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    const data = await r.json().catch(() => null);
    guardIntegrity(data, r.status);
    return { ok: r.ok, data, status: r.status };
  } catch {
    return { ok: false, data: null, status: 0 };
  }
}

export async function signedRequest<T = any>(method: 'GET' | 'POST', path: string, payload?: any, adminToken = ''): Promise<T | null> {
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
      
      guardIntegrity(data, status);
      
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

export const getServerConfig = (): XuanConfig | null => cfg;

export function onServerConfigChange(fn: (c: XuanConfig) => void): () => void {
  listeners.add(fn);
  if (cfg) fn(cfg);
  return () => { listeners.delete(fn); };
}

function applyConfig(next: XuanConfig) {
  if (cfg && next.version === cfg.version) return;
  cfg = next;
  try { secureSet('xuan_server_config', JSON.stringify(next)); } catch {  }
  
  try { (window as unknown as { __xuanServerConfig?: XuanConfig }).__xuanServerConfig = next; } catch {  }
  listeners.forEach(fn => { try { fn(next); } catch {  } });
  try { window.dispatchEvent(new CustomEvent('xuan:server-config', { detail: next })); } catch {  }
}

export async function fetchServerConfig(): Promise<XuanConfig | null> {
  const r = await signedRequest<{ ok: boolean; version: number } & XuanConfig>('GET', EP[43]);
  if (r && r.ok && (r as any).tabs) { applyConfig(r as unknown as XuanConfig); return cfg; }
  return cfg;
}

export async function fetchRemoteResources(): Promise<boolean> {
  const r = await signedRequest<RemoteResourcesPayload>('GET', EP[58]);
  return applyRemoteResources(r);
}

export function onServerUpdate(fn: (u: UpdateInfo) => void) { updateListener = fn; }

async function openSSE() {
  sseAbort?.abort();
  sseAbort = new AbortController();
  
  const streamPath = EP[52].split('?')[0];
  const url = await routeUrl(streamPath);
  try {
    if (isNative()) {
      
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

          // 两段式：测试端监听 'update-beta'（上传即弹），正式端监听 'update'（点发布后才弹）。
          else if (ev === 'update' && !IS_BETA) void checkUpdate(true);
          else if (ev === 'update-beta' && IS_BETA) void checkUpdate(true);
          else if (ev === 'resources') void fetchRemoteResources();
          else if (ev === 'hello' && payload.version && (!cfg || payload.version !== cfg.version)) fetchServerConfig();
        } catch {  }
      }
    }
  } catch {
    
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

export async function initXuanServer() {
  if (started) return;
  started = true;
  
  await refreshRoutes();
  try {
    const cached = secureGet('xuan_server_config');
    if (cached) { try { cfg = JSON.parse(cached); (window as unknown as { __xuanServerConfig?: XuanConfig }).__xuanServerConfig = cfg ?? undefined; } catch {  } }
  } catch {  }
  await fetchServerConfig();
  
  void fetchRemoteResources();
  openSSE();
  
  window.addEventListener('online', () => { fetchServerConfig(); void fetchRemoteResources(); openSSE(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { fetchServerConfig(); void fetchRemoteResources(); }
  });
}

export async function eapiRequest(apiPath: string, data: Record<string, unknown>, cookie: string): Promise<{ body: any; setCookie: string }> {

  
  
  await ensureAttest();
  const sessKey = attestSession()?.key || '';
  const cookieEnc = cookie ? await sealCookie(cookie, sessKey) : '';
  if (cookie && !cookieEnc) {
    
  }
  const r = await signedRequest<{ ok: boolean; body: any; setCookie: string; code: number; message: string }>(
    'POST', EP[44], cookieEnc ? { path: apiPath, data, cookieEnc } : { path: apiPath, data });
  if (!r) return { body: { code: -1, message: '无法连接服务端' }, setCookie: '' };
  if (r.ok) return { body: (r as any).body ?? r, setCookie: (r as any).setCookie || '' };

  
  const errText = String((r as any).error || (r as any).message || '');
  if (errText === '服务端已关闭' || ((r as any).status === 403 && errText.includes('服务端已关闭'))) {
    return { body: { code: -2, message: errText }, setCookie: '' };
  }

  if ((r as any).status === 403 && errText.includes('GitHub')) {
    return { body: { code: -2, message: errText }, setCookie: '' };
  }
  return { body: { code: -1, message: (r as any).message || '服务端请求失败' }, setCookie: '' };
}

export async function checkUpdate(notify = true, platform: 'android' | 'windows' = 'android'): Promise<UpdateInfo | null> {
  // 测试端只读 betaUpdate 槽（规范路径经 beta boot 表换成 30 位动态路径）；
  // 正式版读原 update 通道。路径由 routeUrl 按当前 role 的 boot 表解析。
  const path = IS_BETA ? '/api/beta/update/check' : (platform === 'windows' ? EP[45] : EP[46]);
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
  
  await ensureAttest();
  const sess = attestSession();
  const sep = path.includes('?') ? '&' : '?';
  const name = (fileName || (path.split('?')[0].split('/').pop() || '')).trim();
  const resolved = await routeUrl(path);

  try {
    const u = new URL(resolved);
    if (u.protocol !== 'https:' || !/(^|\.)music\.jrr\.lol$/i.test(u.hostname)) {
      throw new Error('非法的更新下载地址');
    }
  } catch { throw new Error('非法的更新下载地址'); }
  if (sess && name) {
    const dlt = await downloadTicket(name);
    if (dlt) return `${resolved}${sep}dlt=${encodeURIComponent(dlt)}`;
  }

  let url = `${resolved}${sep}ticket=${encodeURIComponent(t)}`;
  if (sess) url += `&attest=${encodeURIComponent(sess.token)}`;
  return url;
}

/** 获取帮助文档动态链接（路径每 10 秒变、内容随时间窗轮换、5 分钟有效） */
export async function fetchHelpLink(): Promise<string | null> {
  const url = `${XUAN_SERVER}/api/help/link`;
  try {
    if (isNative()) {
      const r = await CapacitorHttp.get({ url, responseType: 'json', connectTimeout: 10000, readTimeout: 10000 });
      const u = r.data?.url;
      return typeof u === 'string' ? (/^https?:\/\//.test(u) ? u : `${XUAN_SERVER}${u}`) : null;
    }
    const r = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    const d = await r.json().catch(() => null);
    const u = d?.url;
    return typeof u === 'string' ? (/^https?:\/\//.test(u) ? u : `${XUAN_SERVER}${u}`) : null;
  } catch { return null; }
}

/** 校验 6 位管理授权码；通过后服务端签发 5 分钟有效、10 秒变路径的管理端下载链接 */
export async function redeemAdminCode(code: string): Promise<{ url: string; ttl: number } | null> {
  const r = await signedRequest<{ url: string; ttl: number }>('POST', '/api/redeem', { code });
  return r && typeof (r as any).url === 'string' ? { url: (r as any).url, ttl: Number((r as any).ttl) || 300 } : null;
}

/**
 * 校验 6 位授权码换取「小轩音乐测试端」APK 下载链接。
 * 与管理端 redeemAdminCode 完全对称，只是走独立的 /api/redeem-beta 动态路径，
 * 服务端签发 /b/ 闸门链接（每 10 秒变、5 分钟有效）。口令同为 __XUAN_ADMIN_DEFAULT_PASSWORD__。
 */
export async function redeemBetaCode(code: string): Promise<{ url: string; ttl: number } | null> {
  const r = await signedRequest<{ url: string; ttl: number }>('POST', '/api/redeem-beta', { code });
  return r && typeof (r as any).url === 'string' ? { url: (r as any).url, ttl: Number((r as any).ttl) || 300 } : null;
}

/** 测试端「发布新版本」：把测试通道 betaUpdate 提升到正式 update，正式端随即收到弹窗。 */
export async function publishBetaVersion(): Promise<{ ok: boolean; versionCode?: number } | null> {
  const r = await signedRequest<{ ok: boolean; versionCode?: number }>('POST', '/api/beta/publish', {});
  return r && r.ok ? r : null;
}

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

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|bc85f18614d7|5ba12d6c2b3c");}catch(_e){}
