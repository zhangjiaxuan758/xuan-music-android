// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
/**
 * 小轩音乐 · 应用身份证明（App Attestation）客户端
 * ------------------------------------------------------------------
 * 服务端不再信任任何静态密钥：客户端必须证明「自己正在运行发布账本里登记的
 * 那份正版包」，通过后才拿到一次性会话的专属签名密钥。
 *
 * 流程：
 *   1) 原生层读取自身已安装包的整包 SHA-256、Android 签名证书指纹与版本号
 *   2) /api/attest/hello  提交整包哈希，换取一次性随机挑战（随机偏移+长度切片）
 *   3) 原生层按挑战从自身包里读出对应字节
 *   4) /api/attest/prove  提交切片字节 + 证书指纹 + 证明值；服务端用自己保存的
 *      正版包独立读取并逐字节比对
 *   5) 通过 → 签发短期会话令牌与会话专属签名密钥，业务请求改用它签名
 *
 * 会话令牌与密钥只存在内存中（冷启动重新证明），不写入任何持久化存储。
 */
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { EP, SERVER_URL, SIGN_SECRET } from './secretBox';
import { routeUrl } from './routeMap';
import { netShaHex, netHmacHex } from './xuanNet';

const XuanNative = registerPlugin<{
  getAppIdentity: (o: { slices: string }) => Promise<AppIdentity>;
  getDeviceKey: () => Promise<{ pubKey: string }>;
  signDevice: (o: { msg: string }) => Promise<{ sig: string }>;
}>('XuanNative');

export interface AttestSlice { off: number; len: number }
export interface AppIdentity {
  apkFp: string;
  certFp: string;
  vc: number;
  slices: string[];
}
export interface AttestSession { token: string; key: string; exp: number; appCode?: string }

let token = '';
let sessionKey = '';
let tokenExp = 0;
let clientId = '';
let appCode = '';   // 服务端下发并校验的软件辨别码
let inFlight: Promise<boolean> | null = null;

const isNative = () => Capacitor.isNativePlatform();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 握手签名 / 会话密钥派生走 C++ 网络层核心；二进制切片摘要仍用宿主标准能力
// （切片可能达数百 KB，超过 C++ IO 区容量，且这是整包字节校验而非协议密码学）。
async function sha256Hex(s: string): Promise<string> {
  return netShaHex(s);
}

async function sha256Bytes(b: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
}

async function hmacSha256Hex(secret: string, msg: string): Promise<string> {
  return netHmacHex(secret, msg);
}

function nonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function getClientId(): string {
  if (clientId) return clientId;
  try {
    clientId = localStorage.getItem('xuan_attest_client') || '';
    if (!clientId) {
      clientId = hex(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
      localStorage.setItem('xuan_attest_client', clientId);
    }
  } catch {
    clientId = hex(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
  }
  return clientId;
}

/** 供统一连接层读取当前会话；无有效会话时返回 null。 */
export function attestSession(): AttestSession | null {
  if (!token || !sessionKey || Date.now() > tokenExp) return null;
  return { token, key: sessionKey, exp: tokenExp, appCode };
}

/** 401 / 纪元升级 / 换网后强制重新证明。 */
export function invalidateAttest(): void {
  token = ''; sessionKey = ''; tokenExp = 0; appCode = '';
}

/** 服务端随证明会话下发的软件辨别码；功能接口必须原样带回供服务端校验。 */
export function getAppCode(): string { return appCode; }

async function fetchTicket(): Promise<{ ticket: string; epoch: number }> {
  return fetchTicketWithProof();
}

/** 取自身正版包指纹（apkFp/certFp/vc）；安卓 Keystore / PC app.asar，网页端返回 null。 */
export async function appIdentityLite(): Promise<{ apkFp: string; certFp: string; vc: number } | null> {
  try {
    const id = await getIdentity([]);
    if (!/^[0-9a-f]{64}$/i.test(id.apkFp || '')) return null;
    return { apkFp: id.apkFp.toLowerCase(), certFp: String(id.certFp || '').toLowerCase(), vc: Number(id.vc || 0) };
  } catch {
    return null;
  }
}

type ElectronDevice = {
  devicePubKey?: () => Promise<{ pubKey: string }>;
  deviceSign?: (msg: string) => Promise<{ sig: string }>;
};
function electronDevice(): ElectronDevice {
  return (window as unknown as { electron?: ElectronDevice }).electron || {};
}

/** 设备密钥公钥：安卓 Keystore / PC 端 Windows DPAPI 保护的 EC 私钥。 */
export async function devicePubKey(): Promise<string> {
  if (isNative()) {
    try { const r = await XuanNative.getDeviceKey(); return r.pubKey || ''; } catch { return ''; }
  }
  try {
    const e = electronDevice();
    if (e.devicePubKey) return (await e.devicePubKey()).pubKey || '';
  } catch { /* noop */ }
  return '';
}

/** 用设备密钥对挑战签名：两端同标准，PC 脚本 / 逆向客户端无法伪造。 */
export async function deviceSign(msg: string): Promise<string> {
  if (isNative()) {
    try { const r = await XuanNative.signDevice({ msg }); return r.sig || ''; } catch { return ''; }
  }
  try {
    const e = electronDevice();
    if (e.deviceSign) return (await e.deviceSign(msg)).sig || '';
  } catch { /* noop */ }
  return '';
}

/**
 * 携带「正版应用」强绑定头的一次性票据请求：必须证明自己是官方发布账本里的正版包
 * （整包哈希 + 签名证书指纹 + 应用签名密钥签名），否则服务端返回 404 隐藏接口。
 * 非原生（网页/桌面）环境无原生身份，退化为普通请求（过渡期仍可用，过期后由服务端隐藏）。
 */
export async function fetchTicketWithProof(): Promise<{ ticket: string; epoch: number }> {
  const id = await appIdentityLite();
  const ts = Math.floor(Date.now() / 1000).toString();
  const n = nonce();
  const headers: Record<string, string> = { 'X-Xuan-Ts': ts, 'X-Xuan-Nonce': n };
  const url = await routeUrl(EP[42]);
  if (id) {
    const bodyHash = await sha256Hex('');
    const key = await sha256Hex(SIGN_SECRET);
    const sign = await hmacSha256Hex(key, `${ts}|${n}|${EP[42]}|${bodyHash}`);
    headers['X-Xuan-Sign'] = sign;
    headers['X-Xuan-Appfp'] = id.apkFp;
    headers['X-Xuan-Certfp'] = id.certFp;
    headers['X-Xuan-Vc'] = String(id.vc);
    headers['X-Xuan-Platform'] = isNative() ? 'android' : 'windows';
  }
  if (isNative()) {
    const r = await CapacitorHttp.get({ url, headers, responseType: 'json', connectTimeout: 12000, readTimeout: 12000 });
    return { ticket: String(r.data?.ticket || ''), epoch: Number(r.data?.epoch || 1) };
  }
  const r = await fetch(url, { headers, credentials: 'omit', cache: 'no-store' });
  const d = await r.json().catch(() => null);
  return { ticket: String(d?.ticket || ''), epoch: Number(d?.epoch || 1) };
}

async function post(path: string, body: string, ticket: string): Promise<{ status: number; data: any }> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const n = nonce();
  const bodyHash = await sha256Hex(body);
  const key = await sha256Hex(SIGN_SECRET + '|' + ticket);
  const sign = await hmacSha256Hex(key, `${ts}|${n}|${path}|${bodyHash}`);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Xuan-Ts': ts,
    'X-Xuan-Nonce': n,
    'X-Xuan-Sign': sign,
    'X-Xuan-Ticket': ticket,
  };
  const url = await routeUrl(path);
  if (isNative()) {
    const r = await CapacitorHttp.request({
      method: 'POST', url, headers, data: body, responseType: 'json',
      connectTimeout: 20000, readTimeout: 20000,
    });
    return { status: r.status, data: r.data };
  }
  const r = await fetch(url, { method: 'POST', headers, body, credentials: 'omit', cache: 'no-store' });
  return { status: r.status, data: await r.json().catch(() => null) };
}

async function getIdentity(slices: AttestSlice[]): Promise<AppIdentity> {
  if (isNative()) {
    return await XuanNative.getAppIdentity({ slices: JSON.stringify(slices) });
  }
  const bridge = (window as unknown as {
    electron?: { appIdentity?: (s: AttestSlice[]) => Promise<AppIdentity> };
  }).electron;
  if (bridge?.appIdentity) return await bridge.appIdentity(slices);
  throw new Error('no app identity provider');
}

async function handshake(): Promise<boolean> {
  try {
    const platform = isNative() ? 'android' : 'windows';
    const client = getClientId();
    const { ticket, epoch } = await fetchTicket();
    if (!ticket) return false;

    // 先取整包哈希与证书指纹（不读切片）
    const base = await getIdentity([]);
    if (!/^[0-9a-f]{64}$/i.test(base.apkFp || '')) return false;
    const apkFp = base.apkFp.toLowerCase();
    const certFp = String(base.certFp || '').toLowerCase();
    const vc = Number(base.vc || 0);
    // 设备密钥公钥（安卓 Keystore，硬件支撑；用于把证明会话绑定到真实安装设备）
    const devPub = await devicePubKey();

    const helloBody = JSON.stringify({ client, platform, vc, epoch, apkFp, devicePubKey: devPub });
    const hello = await post(EP[55], helloBody, ticket);
    // 设备上的 APK 整包哈希与发布账本不一致：软件不完整，弹出强制退出弹窗
    if (String(hello.data?.error || '') === 'integrity_failed') {
      try { window.dispatchEvent(new CustomEvent('xuan:integrity-failed')); } catch { /* noop */ }
      return false;
    }
    if (hello.status !== 200 || !hello.data?.sid || !Array.isArray(hello.data?.slices)) {
      return false;
    }
    const slices: AttestSlice[] = hello.data.slices;
    const got = await getIdentity(slices);

    // 拼接所有切片字节，计算与服务端一致的 sliceHash
    const parts = (got.slices || []).map(unb64);
    if (parts.length !== slices.length) return false;
    const total = parts.reduce((a, p) => a + p.length, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    const sliceHash = await sha256Bytes(all);

    const proofKey = await sha256Hex(SIGN_SECRET + '|' + hello.data.seed);
    const msg = [
      hello.data.challenge, certFp, apkFp, sliceHash,
      client, platform, String(vc), String(epoch),
    ].join('|');
    const proof = await hmacSha256Hex(proofKey, msg);

    // 设备密钥签名：仅正版 App 在真实设备上能调用 Keystore 私钥签名，
    // PC 脚本 / 逆向客户端无法产生 → 服务端据此把证明会话绑定到真实安装设备。
    const devMsg = `${hello.data.challenge}|${apkFp}|${certFp}|${hello.data.sid}`;
    const devSig = await deviceSign(devMsg);

    const proveBody = JSON.stringify({
      sid: hello.data.sid, client, platform, vc, apkFp, certFp,
      slices: got.slices, proof, devicePubKey: devPub, deviceSig: devSig,
    });
    const prove = await post(EP[56], proveBody, ticket);
    if (prove.status !== 200 || !prove.data?.token || !prove.data?.sessionKey) return false;

    token = String(prove.data.token);
    sessionKey = String(prove.data.sessionKey);
    appCode = String(prove.data.appCode || '');
    tokenExp = Date.now() + (Number(prove.data.ttl) || 21600) * 1000 - 15000;
    return true;
  } catch {
    return false;
  }
}

/** 确保存在有效会话；并发调用共享同一次握手。 */
export async function ensureAttest(): Promise<boolean> {
  if (attestSession()) return true;
  if (inFlight) return inFlight;
  inFlight = handshake().finally(() => { inFlight = null; });
  return inFlight;
}

/** 仅供诊断：当前证明会话是否有效。 */
export function isAttested(): boolean {
  return attestSession() !== null;
}
