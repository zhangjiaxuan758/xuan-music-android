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

async function soCall(op: string, args: string[]): Promise<string | null> {
    try {
        if (!(await hasNativeSo())) return null;
        const en = electronNet();
        if (en?.netCrypto) {
            const r = await en.netCrypto(op, args);
            if (!r || !r.ok) return null;
            return String(r.value ?? '');
        }
        if (!nativePlugin) return null;
        const r = await nativePlugin.netCrypto({ op, args });
        if (!r || !r.ok) return null;
        return String(r.value ?? '');
    } catch {
        return null;
    }
}

/** SHA-256 hex（纯原生 SO）；SO 不可用时返回 null（fail-closed）。 */
export async function netShaHex(s: string): Promise<string | null> {
    return await soCall('sha', [s]);
}

/** 对二进制字节的 SHA-256（入参为 hex 文本，C++ 解码后哈希）；SO 不可用返回 null。 */
export async function netShaBytesHex(hex: string): Promise<string | null> {
    return await soCall('shab', [hex]);
}

/** HMAC-SHA256 hex（纯原生 SO）；SO 不可用时返回 null（fail-closed）。 */
export async function netHmacHex(key: string, msg: string): Promise<string | null> {
    return await soCall('hmac', [key, msg]);
}

/** 规范路径 -> 路由表键（纯原生 SO，取前 12 位 hex）。 */
export async function netRouteKey(canon: string): Promise<string | null> {
    return await soCall('route', [canon]);
}

/** 引导路由表验签（纯原生 SO 常量时间比较）；SO 不可用时 fail-closed 返回 false。 */
export async function netBootVerify(canon: string, sig: string, secret: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(sig || '')) return false;
    const v = await soCall('boot', [canon, sig, secret]);
    return v === '1';
}

/** 常量时间相等比较（纯原生 SO）；SO 不可用时 fail-closed 返回 false。 */
export async function netCtEq(a: string, b: string): Promise<boolean> {
    const v = await soCall('cteq', [a, b]);
    return v === '1';
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
    return null;
}

/** AES-256-GCM 加密（纯原生 SO）：key/iv/plain 均为 hex，返回 base64(iv||ct||tag)。
 *  与服务端 cryptography.AESGCM 字节兼容。SO 不可用返回 null（fail-closed）。 */
export async function netAesGcmEnc(keyHex: string, ivHex: string, plainHex: string): Promise<string | null> {
    return await soCall('aes', [keyHex, ivHex, plainHex]);
}

/** 密码学安全随机数（纯原生 SO）：返回 n 字节的 hex（2n 字符）。
 *  替代 crypto.getRandomValues，SO 不可用时返回 null（fail-closed）。 */
export async function netRandomHex(n: number): Promise<string | null> {
    return await soCall('rng', [String(n)]);
}

/** 大字节流的 SHA-256（原生增量哈希，分块喂入，避免整包 hex 翻倍内存）。
 *  替代 appUpdater 的 crypto.subtle.digest；SO 不可用返回 null（fail-closed）。 */
export async function netSha256Bytes(bytes: Uint8Array): Promise<string | null> {
    try {
        if (!(await hasNativeSo())) return null;
        await soCall('shainit', []);
        const CHUNK = 16384; // 16KB 原始 -> 32KB hex，匹配 JNI/Node 参数槽上限
        for (let i = 0; i < bytes.length; i += CHUNK) {
            const chunk = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
            let hex = '';
            for (let j = 0; j < chunk.length; j++) hex += chunk[j].toString(16).padStart(2, '0');
            const r = await soCall('shaupd', [hex]);
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
