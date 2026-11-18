// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { SERVER_URL, SIGN_SECRET } from './secretBox';
import { netBootVerify, netRouteKey, canonicalBoot } from './xuanNet';
import { secureGet, secureSet } from './secureCache';

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
}

let table: RouteTable | null = null;
let expireAt = 0;
let inFlight: Promise<boolean> | null = null;
let refreshTimer: number | null = null;

async function verifySig(t: RouteTable): Promise<boolean> {
    try {
        if (!t || t.v !== 2 || !t.routes || typeof t.routes !== 'object') return false;
        if (t.role !== ROUTE_ROLE) return false;
        if (!/^[0-9a-f]{64}$/.test(t.sig || '')) return false;
        const canon = canonicalBoot({ v: t.v, role: t.role, epoch: t.epoch, ttl: t.ttl, routes: t.routes });
        return await netBootVerify(canon, t.sig, SIGN_SECRET);
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

export function ensureRoutes(force = false): Promise<boolean> {
    if (table && !force && Date.now() < expireAt - 5000) return Promise.resolve(true);
    if (inFlight) return inFlight;
    inFlight = (async () => {
        if (!table) loadCache();
        let attempts = 0;
        while (attempts < 2) {
            attempts++;
            const t = await boot();
            if (t && await verifySig(t)) { apply(t); return true; }
        }
        return !!table;
    })().finally(() => { inFlight = null; });
    return inFlight;
}

export async function routeUrl(path: string): Promise<string> {
    await ensureRoutes();
    const q = path.indexOf('?');
    const p = q >= 0 ? path.slice(0, q) : path;
    const query = q >= 0 ? path.slice(q) : '';
    let dyn = '';
    if (table) dyn = table.routes[await routeKey(p)] || '';
    // 动态路径为主：boot 表命中即用随机路径；boot 表暂不可用（网络抖动/会话失效）
    // 时回退规范路径 p，保证业务可用。2026-11-18 修复：哨兵方案在真机 so/wasm
    // 兜底失效导致 boot 表加载失败时，会让所有业务接口 404（只有固定路径的检查更新
    // 能用），故恢复本地回退作为可用性保险。
    return BASE_URL + (dyn || p) + query;
}

export async function refreshRoutes(): Promise<boolean> {
    return ensureRoutes(true);
}

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|3fc6fb8a5bbe|4a0496cd47e6");}catch(_e){}
