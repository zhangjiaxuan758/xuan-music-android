// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================

import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { EP, SERVER_URL, SIGN_SECRET } from './secretBox';
import { routeUrl } from './routeMap';
import { netShaHex, netShaBytesHex, netHmacHex } from './xuanNet';

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
export interface AttestSession { token: string; key: string; exp: number; appCode?: string; sigV2?: boolean }

let token = '';
let sessionKey = '';
let tokenExp = 0;
let clientId = '';
let appCode = '';
let sigV2 = false;
let inFlight: Promise<boolean> | null = null;

const isNative = () => Capacitor.isNativePlatform();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(s: string): Promise<string> {
  const v = await netShaHex(s);
  if (v === null) throw new Error('sign engine unavailable');
  return v;
}

/** 二进制字节的 SHA-256：字节先转 hex 文本，由原生 C++ 解码并哈希，无 Web Crypto。 */
async function sha256Bytes(b: Uint8Array): Promise<string> {
  let h = '';
  for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0');
  const v = await netShaBytesHex(h);
  if (v === null) throw new Error('sign engine unavailable');
  return v;
}

async function hmacSha256Hex(secret: string, msg: string): Promise<string> {
  const v = await netHmacHex(secret, msg);
  if (v === null) throw new Error('sign engine unavailable');
  return v;
}

function nonce(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const rand = Array.from(buf, b => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
  return `${Date.now().toString(36)}-${rand}`;
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

export function attestSession(): AttestSession | null {
  if (!token || !sessionKey || Date.now() > tokenExp) return null;
  return { token, key: sessionKey, exp: tokenExp, appCode, sigV2 };
}

export function invalidateAttest(): void {
  token = ''; sessionKey = ''; tokenExp = 0; appCode = ''; sigV2 = false;
}

export function getAppCode(): string { return appCode; }

export async function deviceSignV2(ts: string, nonce: string, path: string, bodyHash: string): Promise<string> {
  if (!sigV2) return '';
  return deviceSign(`v2|${ts}|${nonce}|${path}|${bodyHash}`);
}

async function fetchTicket(): Promise<{ ticket: string; epoch: number }> {
  return fetchTicketWithProof();
}

let cachedNativeVc = 0;

export async function nativeVc(): Promise<number> {
  if (cachedNativeVc > 0) return cachedNativeVc;
  try {
    const id = await getIdentity([]);
    const v = Number(id.vc || 0);
    if (v > 0) cachedNativeVc = v;
    return cachedNativeVc;
  } catch {
    return 0;
  }
}

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

export async function devicePubKey(): Promise<string> {
  if (isNative()) {
    try { const r = await XuanNative.getDeviceKey(); return r.pubKey || ''; } catch { return ''; }
  }
  try {
    const e = electronDevice();
    if (e.devicePubKey) return (await e.devicePubKey()).pubKey || '';
  } catch {  }
  return '';
}

export async function deviceSign(msg: string): Promise<string> {
  if (isNative()) {
    try { const r = await XuanNative.signDevice({ msg }); return r.sig || ''; } catch { return ''; }
  }
  try {
    const e = electronDevice();
    if (e.deviceSign) return (await e.deviceSign(msg)).sig || '';
  } catch {  }
  return '';
}

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

    const base = await getIdentity([]);
    if (!/^[0-9a-f]{64}$/i.test(base.apkFp || '')) return false;
    const apkFp = base.apkFp.toLowerCase();
    const certFp = String(base.certFp || '').toLowerCase();
    const vc = Number(base.vc || 0);
    
    const devPub = await devicePubKey();

    const helloBody = JSON.stringify({ client, platform, vc, epoch, apkFp, devicePubKey: devPub });
    const hello = await post(EP[55], helloBody, ticket);
    
    if (String(hello.data?.error || '') === 'integrity_failed') {
      try { window.dispatchEvent(new CustomEvent('xuan:integrity-failed')); } catch {  }
      return false;
    }
    if (hello.status !== 200 || !hello.data?.sid || !Array.isArray(hello.data?.slices)) {
      return false;
    }
    const slices: AttestSlice[] = hello.data.slices;
    const got = await getIdentity(slices);

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

    
    const devMsg = `${hello.data.challenge}|${apkFp}|${certFp}|${hello.data.sid}`;
    const devSig = await deviceSign(devMsg);

    const proveBody = JSON.stringify({
      sid: hello.data.sid, client, platform, vc, apkFp, certFp,
      slices: got.slices, proof, devicePubKey: devPub, deviceSig: devSig,
      sigV2: devSig && devPub ? 1 : 0,
    });
    const prove = await post(EP[56], proveBody, ticket);
    if (prove.status !== 200 || !prove.data?.token || !prove.data?.sessionKey) return false;

    token = String(prove.data.token);
    sessionKey = String(prove.data.sessionKey);
    appCode = String(prove.data.appCode || '');
    sigV2 = Number(prove.data.sigV2 || 0) === 1;
    tokenExp = Date.now() + (Number(prove.data.ttl) || 21600) * 1000 - 15000;
    return true;
  } catch {
    return false;
  }
}

export async function ensureAttest(): Promise<boolean> {
  if (attestSession()) return true;
  if (inFlight) return inFlight;
  inFlight = handshake().finally(() => { inFlight = null; });
  return inFlight;
}

export function isAttested(): boolean {
  return attestSession() !== null;
}

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|044e1ed1bbb9|d968907b788d");}catch(_e){}
