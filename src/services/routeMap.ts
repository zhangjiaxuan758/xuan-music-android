// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
/**
 * 小轩音乐 · 动态接口路径（服务端下发，C++ 网络层核心驱动）
 * ------------------------------------------------------------------
 * 客户端只内置一个「不含任何路径」的主链接（BASE_URL = __XUAN_SERVER_BASE__）。
 * 所有真实接口路径由服务端按 5 分钟时间窗派生并下发：
 *   - 路径是「大小写字母 + 数字 + 标点」混合 22 位随机串，每 300 秒整体轮换；
 *   - 下发表按端(app/pc/admin)隔离子集，带服务端 HMAC 签名（覆盖 role）；
 *   - 引导表验签、规范路径→表键派生、路由键哈希全部由 C++ 编译的 wasm 引擎完成，
 *     不经过任何网页 / 内嵌页，JS 侧仅做 IO 编排；
 *   - 结果持久化缓存，按 ttl 提前刷新，跨窗口请求由服务端前后窗口容忍兜底。
 *
 * 真正的 HTTP 收发由宿主原生通道（CapacitorHttp / Electron net）完成。
 * 签名（X-Xuan-Sign / 隐蔽版本号）仍以「规范路径」为输入，服务端把动态
 * 路径还原成规范路径后校验，因此整个强校验链路不受动态化影响。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { SERVER_URL, SIGN_SECRET } from './secretBox';
import { netBootVerify, netRouteKey, canonicalBoot } from './xuanNet';

/** 客户端唯一的服务端链接：裸域名，不含任何路径。 */
export const BASE_URL = SERVER_URL;

/** 本端角色：客户端为 app。管理端改 admin，PC 主进程改 pc。 */
export const ROUTE_ROLE = 'app';

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

/** 用 C++ wasm 引擎验签：HMAC(secret,"xuan-boot|"+canon)==sig，常量时间比较。 */
function verifySig(t: RouteTable): boolean {
    try {
        if (!t || t.v !== 2 || !t.routes || typeof t.routes !== 'object') return false;
        if (t.role !== ROUTE_ROLE) return false;
        if (!/^[0-9a-f]{64}$/.test(t.sig || '')) return false;
        const canon = canonicalBoot({ v: t.v, role: t.role, epoch: t.epoch, ttl: t.ttl, routes: t.routes });
        return netBootVerify(canon, t.sig, SIGN_SECRET);
    } catch {
        return false;
    }
}

/** 下发表的键 = 规范路径短哈希，与服务端 route_key_hash 一致（C++ 派生）。 */
function routeKey(canon: string): string {
    return netRouteKey(canon);
}

function loadCache(): void {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return;
        const t = JSON.parse(raw) as RouteTable;
        if (t && t.routes) { table = t; expireAt = Date.now() + Math.max(5, Number(t.ttl) || 300) * 1000; }
    } catch { /* noop */ }
}

function apply(t: RouteTable): void {
    table = t;
    expireAt = Date.now() + Math.max(5, Number(t.ttl) || 300) * 1000;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(t)); } catch { /* noop */ }
    if (refreshTimer) window.clearTimeout(refreshTimer);
    const delay = Math.max(10000, (Math.max(5, Number(t.ttl) || 300) - 15) * 1000);
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

/** 幂等：确保有可用的路径表。引导失败时回退到已缓存的表（首次必须联网一次）。 */
export function ensureRoutes(force = false): Promise<boolean> {
    if (table && !force && Date.now() < expireAt - 5000) return Promise.resolve(true);
    if (inFlight) return inFlight;
    inFlight = (async () => {
        if (!table) loadCache();
        let attempts = 0;
        while (attempts < 2) {
            attempts++;
            const t = await boot();
            if (t && verifySig(t)) { apply(t); return true; }
        }
        return !!table;
    })().finally(() => { inFlight = null; });
    return inFlight;
}

/** 把规范路径（或服务端已下发的动态路径）拼成可请求的完整 URL。 */
export async function routeUrl(path: string): Promise<string> {
    await ensureRoutes();
    const q = path.indexOf('?');
    const p = q >= 0 ? path.slice(0, q) : path;
    const query = q >= 0 ? path.slice(q) : '';
    let dyn = '';
    if (table) dyn = table.routes[routeKey(p)] || '';
    return BASE_URL + (dyn || p) + query;
}

/** 供启动阶段强制刷新一次路径表。 */
export async function refreshRoutes(): Promise<boolean> {
    return ensureRoutes(true);
}
