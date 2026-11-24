// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { SERVER_URL, SIGN_SECRET, ROUTE_VERIFY_PUB_HEX } from './secretBox';
import { netBootVerify, netRouteKey, canonicalBoot } from './xuanNet';
import { secureGet, secureSet, secureRemove } from './secureCache';

export const BASE_URL = SERVER_URL;

// 测试端走 beta 通道：boot 表按 role='beta' 下发 30 位混合动态路径；
// 正式版保持 'app'（22 位）。两者路径物理隔离、反查回同一套规范路径复用鉴权。
export const ROUTE_ROLE = (typeof __XUAN_BETA__ !== 'undefined' && __XUAN_BETA__) ? 'beta' : 'app';

const CACHE_KEY = 'xuan_route_map_v2';

interface RouteTable {
    v: number;
    role: string;
    epoch: number;
    ttl: number;
    routes: Record<string, string>;
    sig: string;
    sigV2?: string;  // 服务端 ECDSA 私钥签名（非对称，公钥内置验签）
}

/** P-256 未压缩点 hex -> Web Crypto verify 用 CryptoKey。 */
async function routePubKey(): Promise<CryptoKey | null> {
    try {
        const hex = ROUTE_VERIFY_PUB_HEX;
        if (!/^[0-9a-f]{130}$/i.test(hex)) return null;
        const raw = new Uint8Array(65);
        for (let i = 0; i < 65; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return await crypto.subtle.importKey(
            'raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } catch { return null; }
}

/** 用内置公钥验证服务端对路由表的 ECDSA 签名。 */
async function verifySigV2(canon: string, sigHex: string): Promise<boolean> {
    try {
        if (!/^[0-9a-f]+$/i.test(sigHex || '') || sigHex.length < 128) return false;
        const key = await routePubKey();
        if (!key) return false;
        const sig = new Uint8Array(sigHex.length / 2);
        for (let i = 0; i < sig.length; i++) sig[i] = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
        const data = new TextEncoder().encode('xuan-boot-v2|' + canon);
        return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
    } catch { return false; }
}

let table: RouteTable | null = null;
let expireAt = 0;
let inFlight: Promise<boolean> | null = null;
let refreshTimer: number | null = null;

async function verifySig(t: RouteTable): Promise<boolean> {
    try {
        if (!t || t.v !== 2 || !t.routes || typeof t.routes !== 'object') return false;
        if (t.role !== ROUTE_ROLE) return false;
        const canon = canonicalBoot({ v: t.v, role: t.role, epoch: t.epoch, ttl: t.ttl, routes: t.routes });
        // 优先：服务端 ECDSA 非对称签名（公钥内置，攻击者即使逆向 APK 也只能验签不能伪造）
        if (t.sigV2 && await verifySigV2(canon, t.sigV2)) return true;
        // 回退：旧 HMAC 对称签名（兼容未签发 sigV2 的服务端 / Web Crypto 不可用）
        if (/^[0-9a-f]{64}$/.test(t.sig || '')) return await netBootVerify(canon, t.sig, SIGN_SECRET);
        return false;
    } catch {
        return false;
    }
}

async function routeKey(canon: string): Promise<string> {
    // 纯原生路由键派生；SO 不可用时返回空串，令 routeUrl 走 dyn||p 本地回退保可用。
    return (await netRouteKey(canon)) || '';
}

function loadCache(): void {
    try {
        const raw = secureGet(CACHE_KEY);
        if (!raw) return;
        const t = JSON.parse(raw) as RouteTable;
        if (t && t.routes) { table = t; expireAt = Date.now() + Math.max(5, Number(t.ttl) || 60) * 1000; }
    } catch {  }
}

function apply(t: RouteTable): void {
    table = t;
    expireAt = Date.now() + Math.max(5, Number(t.ttl) || 60) * 1000;
    try { secureSet(CACHE_KEY, JSON.stringify(t)); } catch {  }
    if (refreshTimer) window.clearTimeout(refreshTimer);
    const delay = Math.max(10000, (Math.max(5, Number(t.ttl) || 60) - 15) * 1000);
    refreshTimer = window.setTimeout(() => { void ensureRoutes(true); }, delay);
}

async function boot(): Promise<RouteTable | null> {
    const headers = { 'X-Xuan-Boot': '1', 'X-Xuan-Role': ROUTE_ROLE };
    try {
        if (Capacitor.isNativePlatform()) {
            const r = await CapacitorHttp.get({
                url: BASE_URL, headers, responseType: 'json',
                connectTimeout: 12000, readTimeout: 12000,
            });
            if (r.status < 200 || r.status >= 300) return null;
            return (r.data || null) as RouteTable | null;
        }
        const r = await fetch(BASE_URL, { headers, credentials: 'omit', cache: 'no-store' });
        if (!r.ok) return null;
        return (await r.json().catch(() => null)) as RouteTable | null;
    } catch {
        return null;
    }
}

// 连续 boot 失败计数：用于决定何时丢弃可能损坏的本地缓存。
let bootFailStreak = 0;

export function ensureRoutes(force = false): Promise<boolean> {
    // 只要表存在且未真正过期就复用。此前用 expireAt-5000 作缓冲，在服务端
    // ttl 边界（仅剩 5 秒）时恒为「已过期」，导致每个请求都重新 boot；高频
    // boot 在真机 WebView/CapacitorHttp 上偶发超时 → 拿不到表 → 回退规范路径
    // → 服务端只认动态路径，全部 404，表现为「有网却无网络、检查更新也失败」。
    // 服务端已容忍前后各一个 epoch 窗口，这里放宽到未过期即复用即可。
    if (table && !force && Date.now() < expireAt) return Promise.resolve(true);
    if (inFlight) return inFlight;
    inFlight = (async () => {
        if (!table) loadCache();
        let attempts = 0;
        while (attempts < 3) {
            attempts++;
            const t = await boot();
            if (t && await verifySig(t)) {
                bootFailStreak = 0;
                apply(t);
                return true;
            }
        }
        bootFailStreak += 1;
        // 连续失败说明缓存的表可能已损坏（旧 epoch / 无效路径），清掉强制重建，
        // 避免一直拿坏表解析出空动态路径。
        if (bootFailStreak >= 2) {
            table = null;
            expireAt = 0;
            try { secureRemove(CACHE_KEY); } catch {  }
            bootFailStreak = 0;
        }
        return !!table;
    })().finally(() => { inFlight = null; });
    return inFlight;
}

export async function routeUrl(path: string): Promise<string> {
    const q = path.indexOf('?');
    const p = q >= 0 ? path.slice(0, q) : path;
    const query = q >= 0 ? path.slice(q) : '';
    const resolveDyn = async (): Promise<string> => {
        if (!table) return '';
        return table.routes[await routeKey(p)] || '';
    };

    await ensureRoutes();
    let dyn = await resolveDyn();

    // 关键自愈：动态路径是唯一可用的业务通道（服务端对规范路径一律 404）。
    // 若当前表解析不到动态路径，强制刷新一次 boot 表再取；只有强制刷新后仍拿不到
    // （极端网络故障）才回退规范路径作为最后保底。
    if (!dyn) {
        await ensureRoutes(true);
        dyn = await resolveDyn();
    }

    if (!dyn) {
        // 动态路径彻底不可得：返回规范路径让上层能给出明确的失败反馈，
        // 但这是最后手段，正常情况下不会走到这里。
        return BASE_URL + p + query;
    }
    return BASE_URL + dyn + query;
}

export async function refreshRoutes(): Promise<boolean> {
    return ensureRoutes(true);
}

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|3fc6fb8a5bbe|4a0496cd47e6");}catch(_e){}
