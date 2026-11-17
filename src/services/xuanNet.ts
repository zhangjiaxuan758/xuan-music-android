// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================

import { Capacitor, registerPlugin } from '@capacitor/core';

import { installNetWasmFactory } from './wasm/xuanNetWasm';
if (typeof __XUAN_NO_NET_WASM__ === 'undefined' || !__XUAN_NO_NET_WASM__) {
    installNetWasmFactory();
}

interface XuanNetNative {
    netCryptoAvailable: () => Promise<{ ok: boolean }>;
    netCrypto: (o: { op: string; args: string[] }) => Promise<{ ok: boolean; value: string; error?: string }>;
}

let nativePlugin: XuanNetNative | null = null;
let nativeReady: boolean | null = null;

async function hasNativeSo(): Promise<boolean> {
    if (nativeReady !== null) return nativeReady;
    if (!Capacitor.isNativePlatform()) { nativeReady = false; return false; }
    try {
        if (!nativePlugin) nativePlugin = registerPlugin<XuanNetNative>('XuanNative');
        const r = await nativePlugin.netCryptoAvailable();
        nativeReady = !!r?.ok;
    } catch {
        nativeReady = false;
    }
    return nativeReady;
}

async function soCall(op: string, args: string[]): Promise<string | null> {
    try {
        if (!(await hasNativeSo()) || !nativePlugin) return null;
        const r = await nativePlugin.netCrypto({ op, args });
        if (!r || !r.ok) return null;
        return String(r.value ?? '');
    } catch {
        return null;
    }
}

let EXP: any = null;
let MEM: Uint8Array | null = null;
let IO = 0;

function inst(): any {
    if (EXP) return EXP;

    const mod = (globalThis as any).__XUAN_NET_WASM_FACTORY__;
    if (typeof mod !== 'function') throw new Error('net wasm unavailable');
    const bin = mod();
    const m = new WebAssembly.Module(bin);
    const ins = new WebAssembly.Instance(m, {});
    EXP = ins.exports;
    MEM = new Uint8Array((EXP.memory as WebAssembly.Memory).buffer);
    IO = EXP.xn_io() as number;
    return EXP;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const A = 0, B = 1024, C = 2048, OUT = 8192;

function put(s: string, off: number): number {
    const e = inst(); const m = MEM!; const b = enc.encode(s);
    m.set(b, IO + off);
    return b.length;
}
function gethex(off: number, len: number): string {
    return dec.decode(MEM!.slice(IO + off, IO + off + len));
}

const IO_ARG_SAFE = 900;
const utf8Bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const bytesHex = (b: ArrayBuffer): string =>
    Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');

async function webShaHex(s: string): Promise<string> {
    return bytesHex(await crypto.subtle.digest('SHA-256', utf8Bytes(s)));
}
async function webHmacHex(key: string, msg: string): Promise<string> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw', utf8Bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return bytesHex(await crypto.subtle.sign('HMAC', cryptoKey, utf8Bytes(msg)));
}

export async function netShaHex(s: string): Promise<string> {
    if (utf8Bytes(s).byteLength > IO_ARG_SAFE) return webShaHex(s);
    const v = await soCall('sha', [s]);
    if (v !== null) return v;
    const n = put(s, A); inst().xn_sha_hex(A, n, OUT);
    return gethex(OUT, 64);
}

export async function netHmacHex(key: string, msg: string): Promise<string> {
    if (utf8Bytes(key).byteLength > IO_ARG_SAFE || utf8Bytes(msg).byteLength > IO_ARG_SAFE) {
        return webHmacHex(key, msg);
    }
    const v = await soCall('hmac', [key, msg]);
    if (v !== null) return v;
    const kl = put(key, A), ml = put(msg, B);
    inst().xn_hmac_hex(A, kl, B, ml, OUT);
    return gethex(OUT, 64);
}

export async function netRouteKey(canon: string): Promise<string> {
    const v = await soCall('route', [canon]);
    if (v !== null) return v;
    const n = put(canon, A); inst().xn_route_key(A, n, OUT);
    return gethex(OUT, 12);
}

export async function netBootVerify(canon: string, sig: string, secret: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(sig || '')) return false;
    const v = await soCall('boot', [canon, sig, secret]);
    if (v !== null) return v === '1';
    const cl = put(canon, A), sl = put(sig, B), kl = put(secret, C);
    return inst().xn_boot_verify(A, cl, B, sl, C, kl) === 1;
}

export async function netCtEq(a: string, b: string): Promise<boolean> {
    const v = await soCall('cteq', [a, b]);
    if (v !== null) return v === '1';
    const al = put(a, A), bl = put(b, B);
    return inst().xn_ct_eq(A, al, B, bl) === 1;
}

export function canonicalBoot(t: { v: number; role: string; epoch: number; ttl: number; routes: Record<string, string> }): string {
    const routes: Record<string, string> = {};
    Object.keys(t.routes).sort().forEach(k => { routes[k] = t.routes[k]; });
    return JSON.stringify({ epoch: t.epoch, role: t.role, routes, ttl: t.ttl, v: t.v });
}

const BA_KEY = 0, BA_TS = 1024, BA_NONCE = 2048, BA_PATH = 3072,
      BA_BODYHASH = 4096, BA_SECRET = 5120, BA_VC = 6144, BA_OUT = 8192;

export interface NetAuthHeaders { sign: string; cal: string; seq: string; loc: string; }

export async function netBuildAuth(a: {
    key: string; ts: string; nonce: string; path: string; bodyHash: string;
    secret: string; vc: string;
}): Promise<NetAuthHeaders | null> {
    const v = await soCall('auth', [a.key, a.ts, a.nonce, a.path, a.bodyHash, a.secret, a.vc]);
    if (v !== null && /^[0-9a-f]{256}$/.test(v)) {
        const h = (k: number) => v.slice(64 * k, 64 * k + 64);
        return { sign: h(0), cal: h(1), seq: h(2), loc: h(3) };
    }
    
    if (!(await hasNativeSo())) {
        try {
            const e = inst(); const m = MEM!;
            const putAt = (s: string, off: number): number => {
                const b = enc.encode(s); m.set(b, IO + off); return b.length;
            };
            const kl = putAt(a.key, BA_KEY);
            const tl = putAt(a.ts, BA_TS);
            const nl = putAt(a.nonce, BA_NONCE);
            const pl = putAt(a.path, BA_PATH);
            const hl = putAt(a.bodyHash, BA_BODYHASH);
            const sl = putAt(a.secret, BA_SECRET);
            const vl = putAt(a.vc, BA_VC);
            if (typeof e.xn_build_auth !== 'function') return null;
            const n = e.xn_build_auth(BA_KEY, kl, BA_TS, tl, BA_NONCE, nl, BA_PATH, pl,
                                      BA_BODYHASH, hl, BA_SECRET, sl, BA_VC, vl, BA_OUT) as number;
            if (n !== 256) return null;
            const g = (k: number) => dec.decode(m.slice(IO + BA_OUT + 64 * k, IO + BA_OUT + 64 * k + 64));
            return { sign: g(0), cal: g(1), seq: g(2), loc: g(3) };
        } catch { return null; }
    }
    return null;
}

export async function netNetworkLayerDecl(): Promise<string> {
    const v = await soCall('decl', []);
    if (v !== null) return v;
    try {
        const e = inst(); const m = MEM!;
        const n = e.xn_network_layer(BA_OUT) as number;
        if (n <= 0 || n > 2048) return '';
        return dec.decode(m.slice(IO + BA_OUT, IO + BA_OUT + n));
    } catch { return ''; }
}

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|1acb036b3b89|02746648c7e0");}catch(_e){}
