// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================

import { Capacitor, registerPlugin } from '@capacitor/core';

/* 小轩音乐 · 网络密码学层（纯原生 C++）
 * ------------------------------------------------------------------
 * 2026-11-18 起：签名/验签/路由键派生/SHA/HMAC/常量时间比较全部且仅由
 * 原生 C++ 实现（Android: libxuan_net.so 经 JNI；桌面: xuan_native.node 经
 * N-API）。已彻底移除 WebAssembly 兜底与 Web Crypto（crypto.subtle）兜底：
 *   - 不再安装/实例化任何 wasm 工厂；
 *   - JS 侧不保留任何 HMAC/SHA 拼接公式与明文实现；
 *   - 原生 SO/.node 不可用时一律 fail-closed（返回 null/false/空串），
 *     由上层 signHeaders 抛 "sign engine unavailable"，绝不降级成 JS 公式。
 * 长 body（Cookie/身份快照数十 KB）的 SHA-256 也走原生：C++ g_io 已扩到
 * 256KB，JNI/Node 参数槽 32KB，无需 Web Crypto 兜底。
 */

interface XuanNetNative {
    netCryptoAvailable: () => Promise<{ ok: boolean }>;
    netCrypto: (o: { op: string; args: string[] }) => Promise<{ ok: boolean; value: string; error?: string }>;
}

/** 桌面 Electron 渲染层桥（preload 暴露，走主进程原生 .node）。 */
interface XuanElectronNet {
    netCryptoAvailable?: () => Promise<{ ok: boolean }>;
    netCrypto?: (op: string, args: string[]) => Promise<{ ok: boolean; value: string; error?: string }>;
}
function electronNet(): XuanElectronNet | null {
    const e = (window as unknown as { electron?: XuanElectronNet }).electron;
    return e && typeof e.netCrypto === 'function' ? e : null;
}

let nativePlugin: XuanNetNative | null = null;
let nativeReady: boolean | null = null;

async function hasNativeSo(): Promise<boolean> {
    if (nativeReady !== null) return nativeReady;
    // 桌面 Electron：渲染层 -> 主进程原生 .node（C++）。
    if (electronNet()) { nativeReady = true; return true; }
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

/** 原生 SO 调用保险丝：任何原生调用挂起（Android 16 部分机型 ROM 问题）时，
 * 超时按失败处理返回 null，上层随即走 Web Crypto 兜底，链路永不永久 pending。 */
function soTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('so call timeout')), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}

async function soCall(op: string, args: string[]): Promise<string | null> {
    try {
        if (!(await soTimeout(hasNativeSo(), 4000))) return null;
        const en = electronNet();
        if (en?.netCrypto) {
            const r = await soTimeout(en.netCrypto(op, args), 6000);
            if (!r || !r.ok) return null;
            return String(r.value ?? '');
        }
        if (!nativePlugin) return null;
        const r = await soTimeout(nativePlugin.netCrypto({ op, args }), 6000);
        if (!r || !r.ok) return null;
        return String(r.value ?? '');
    } catch {
        return null;
    }
}

/* ==================================================================
 * Web Crypto 兜底（2026-11-20）
 * ------------------------------------------------------------------
 * 背景：部分 Android 15+/16 设备（如 PLE110/Android 16）要求 native SO
 * 以 16KB 页对齐加载，否则 System.loadLibrary 直接失败 → 整条签名引擎
 * fail-closed → 路由表验签不过 → 退化明文路径 → 全部功能「无网络」。
 * 除已把 SO 重编为 16KB 对齐外，这里再做纯 Web Crypto 兜底：任何 SO
 * 调用返回 null（加载失败 / JNI 异常 / 插件未就绪）时，用标准 Web Crypto
 * 复刻同一套算法。公式与 C++ xn_* 及服务端逐字节一致，不影响安全性。
 * ================================================================== */
const WC_UTF8 = (s: string): Uint8Array<ArrayBuffer> => {
    const u = new TextEncoder().encode(s);
    return new Uint8Array(u.buffer as ArrayBuffer, u.byteOffset, u.byteLength) as Uint8Array<ArrayBuffer>;
};
const WC_HEX = (b: ArrayBuffer | Uint8Array): string => {
    const u = b instanceof Uint8Array ? b : new Uint8Array(b);
    let out = '';
    // 修复：此前误加 (i<16?'0':'') 前缀，令前 16 字节多出一位 '0'，
    // 32 字节 hash 变成 80 字符而非 64 → 路由键/HMAC 全错 → PLE110/Android16
    // 上 SO 加载失败走 Web Crypto 兜底时全站 404。必须是纯两位十六进制拼接。
    for (let i = 0; i < u.length; i++) out += u[i].toString(16).padStart(2, '0');
    return out;
};
async function webShaHex(s: string): Promise<string> {
    return WC_HEX(await crypto.subtle.digest('SHA-256', WC_UTF8(s)));
}
async function webHmacHex(key: string, msg: string): Promise<string> {
    const ck = await crypto.subtle.importKey('raw', WC_UTF8(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return WC_HEX(await crypto.subtle.sign('HMAC', ck, WC_UTF8(msg)));
}

/** SHA-256 hex（原生 SO 优先，失败回退 Web Crypto）。 */
export async function netShaHex(s: string): Promise<string | null> {
    const v = await soCall('sha', [s]);
    return v !== null ? v : await webShaHex(s);
}

/** 对二进制字节的 SHA-256（入参为 hex 文本，C++ 解码后哈希）；SO 不可用回退
 *  Web Crypto（hex → bytes → digest），与 C++ xn_sha_bytes 逐字节一致。
 *  握手 prove 阶段的 sliceHash 依赖本函数，无兜底时同样会卡死握手。 */
export async function netShaBytesHex(hex: string): Promise<string | null> {
    const v = await soCall('shab', [hex]);
    if (v !== null) return v;
    try {
        const bytes = WC_FROMHEX(hex);
        return WC_HEX(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
    } catch { return null; }
}

/** HMAC-SHA256 hex（原生 SO 优先，失败回退 Web Crypto）。
 *  2026-11-21 关键修复：此前 fail-closed 返回 null，导致 PLE110/Android16 上
 *  SO 加载失败时握手第一步（fetchTicket 静态签名）直接抛
 *  "sign engine unavailable" → 握手连 ticket/hello 都发不出 → boot 之后
 *  零业务请求 → 榜单永远「正在获取」、检查更新点了没反应、GitHub 登录
 *  bind 401 死循环（黑条+全页卡死）。Web Crypto 兜底与 C++ xn_hmac
 *  逐字节一致（标准 HMAC-SHA256），算法不降级。 */
export async function netHmacHex(key: string, msg: string): Promise<string | null> {
    const v = await soCall('hmac', [key, msg]);
    if (v !== null) return v;
    return await webHmacHex(key, msg);
}

/** 规范路径 -> 路由表键：route = sha256('key|' + canon) 前 12 位 hex。 */
export async function netRouteKey(canon: string): Promise<string | null> {
    const v = await soCall('route', [canon]);
    return v !== null ? v : (await webShaHex('key|' + canon)).slice(0, 12);
}

/** 引导路由表验签：boot = (HMAC(secret, 'xuan-boot|' + canon) === sig)。 */
export async function netBootVerify(canon: string, sig: string, secret: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(sig || '')) return false;
    const v = await soCall('boot', [canon, sig, secret]);
    if (v !== null) return v === '1';
    // Web Crypto 兜底（修复 WC_HEX 后与原生/S 端逐字节一致）
    try {
        const expect = await webHmacHex(secret, 'xuan-boot|' + canon);
        let diff = 0;
        for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
        return diff === 0;
    } catch { return false; }
}

/** 常量时间相等比较。 */
export async function netCtEq(a: string, b: string): Promise<boolean> {
    const v = await soCall('cteq', [a, b]);
    if (v !== null) return v === '1';
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export function canonicalBoot(t: { v: number; role: string; epoch: number; ttl: number; routes: Record<string, string> }): string {
    const routes: Record<string, string> = {};
    Object.keys(t.routes).sort().forEach(k => { routes[k] = t.routes[k]; });
    return JSON.stringify({ epoch: t.epoch, role: t.role, routes, ttl: t.ttl, v: t.v });
}

export interface NetAuthHeaders { sign: string; cal: string; seq: string; loc: string; }

/**
 * 请求签名四通道（sign/cal/seq/loc）：协议串拼接与四路 HMAC 全部在原生 C++
 * xn_build_auth 内完成，JS 侧只做最薄的 IO 编排，不保存任何公式。
 * SO 不可用时返回 null，由 signHeaders 抛错 fail-closed。
 */
export async function netBuildAuth(a: {
    key: string; ts: string; nonce: string; path: string; bodyHash: string;
    secret: string; vc: string;
}): Promise<NetAuthHeaders | null> {
    const v = await soCall('auth', [a.key, a.ts, a.nonce, a.path, a.bodyHash, a.secret, a.vc]);
    if (v !== null && /^[0-9a-f]{256}$/.test(v)) {
        const h = (k: number) => v.slice(64 * k, 64 * k + 64);
        return { sign: h(0), cal: h(1), seq: h(2), loc: h(3) };
    }
    // Web Crypto 兜底：与 C++ xn_build_auth 逐字节一致
    //  sign = HMAC(key, ts|nonce|path|bodyHash)
    //  cal  = HMAC(secret|'vc-cal', vc|ts|nonce)
    //  seq  = HMAC(secret|'vc-seq', vc|nonce|path)
    //  loc  = HMAC(secret|'vc-loc', vc|ts|path)
    try {
        const sign = await webHmacHex(a.key, `${a.ts}|${a.nonce}|${a.path}|${a.bodyHash}`);
        const cal = await webHmacHex(a.secret + '|vc-cal', `${a.vc}|${a.ts}|${a.nonce}`);
        const seq = await webHmacHex(a.secret + '|vc-seq', `${a.vc}|${a.nonce}|${a.path}`);
        const loc = await webHmacHex(a.secret + '|vc-loc', `${a.vc}|${a.ts}|${a.path}`);
        return { sign, cal, seq, loc };
    } catch { return null; }
}

/** hex 字符串 -> Uint8Array。 */
const WC_FROMHEX = (h: string): Uint8Array<ArrayBuffer> => {
    const s = h.replace(/[^0-9a-f]/gi, '');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out as Uint8Array<ArrayBuffer>;
};
/** Uint8Array -> base64。 */
const WC_B64 = (u: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
};

/** AES-256-GCM 加密：key/iv/plain 均为 hex，返回 base64(iv||ct||tag)。SO 失败回退 Web Crypto。 */
export async function netAesGcmEnc(keyHex: string, ivHex: string, plainHex: string): Promise<string | null> {
    const v = await soCall('aes', [keyHex, ivHex, plainHex]);
    if (v !== null) return v;
    try {
        const iv = WC_FROMHEX(ivHex);
        const key = await crypto.subtle.importKey('raw', WC_FROMHEX(keyHex), { name: 'AES-GCM' }, false, ['encrypt']);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, WC_FROMHEX(plainHex)));
        const out = new Uint8Array(iv.length + ct.length);
        out.set(iv, 0); out.set(ct, iv.length);
        return WC_B64(out);
    } catch { return null; }
}

/** 密码学安全随机数：返回 n 字节的 hex（2n 字符）。SO 失败回退 Web Crypto。 */
export async function netRandomHex(n: number): Promise<string | null> {
    const v = await soCall('rng', [String(n)]);
    if (v !== null) return v;
    try { return WC_HEX(crypto.getRandomValues(new Uint8Array(n))); }
    catch { return null; }
}

/** 大字节流的 SHA-256（原生增量哈希，分块喂入，避免整包 hex 翻倍内存）。
 *  替代 appUpdater 的 crypto.subtle.digest；SO 不可用返回 null（fail-closed）。 */
/** 预生成 0-255 的两位小写 hex 查表，避免每字节 toString(16).padStart 的字符串开销。 */
const BYTE_HEX: readonly string[] = (() => {
    const t = new Array<string>(256);
    for (let i = 0; i < 256; i++) t[i] = (i < 16 ? '0' : '') + i.toString(16);
    return t;
})();

export async function netSha256Bytes(bytes: Uint8Array): Promise<string | null> {
    // SO 不可用时用 Web Crypto 一次性 digest（标准 SHA-256，与原生逐字节一致）
    if (!(await hasNativeSo())) {
        try {
            const copy = new Uint8Array(bytes.length);
            copy.set(bytes);
            return WC_HEX(await crypto.subtle.digest('SHA-256', copy as Uint8Array<ArrayBuffer>));
        }
        catch { return null; }
    }
    try {
        await soCall('shainit', []);
        // JNI 单参数槽上限 32760 字节。hex 每字节占 2 字符，故原始分块必须 ≤ 16380。
        // 原实现用 16384 → 32768 hex，超出 8 字符被 JNI 静默截断，导致大 body 的
        // bodyHash 与服务端 sha256(body_bytes) 不一致 → 身份码保存/大配置请求 401「保存失败」。
        // 取 16000（32000 hex）留出安全余量。
        const CHUNK = 16000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            const chunk = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
            const hexChars = new Array<string>(chunk.length);
            for (let j = 0; j < chunk.length; j++) hexChars[j] = BYTE_HEX[chunk[j]];
            const r = await soCall('shaupd', [hexChars.join('')]);
            if (r === null) return null;
        }
        return await soCall('shafin', []);
    } catch {
        return null;
    }
}

/** 宿主网络层标识（纯原生 SO）。 */
export async function netNetworkLayerDecl(): Promise<string> {
    const v = await soCall('decl', []);
    return v ?? '';
}

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|1acb036b3b89|02746648c7e0");}catch(_e){}
