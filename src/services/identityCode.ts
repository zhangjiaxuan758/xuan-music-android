// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import { signedRequest } from './xuanServer';
import { readProviderSessionValue, writeProviderSessionValue } from './onlineMusic/providerStorage';
import { readGithubSession, writeGithubSession } from './githubSession';

const ID_KEY = 'xuan_identity_code';
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*._~-';

/**
 * 身份授权码：服务端同步的身份凭据（跨设备/重装可用）。
 * 2026-11-18 修正：
 *  - 文案统一为「身份授权码」，它并不只限本机；
 *  - 复制时强制把「已登录账号 + 全部本地配置」加密存到服务端（不允许跳过导致"授权码不存在"）；
 *  - 恢复时下载同一份快照，写回账号与全部配置并自愈重载。
 */

/** 设备专属/一次性键：不纳入跨设备同步，避免把旧设备的临时态带到新设备。 */
const CONFIG_EXCLUDE = new Set<string>([
    'xuan_identity_code',          // 身份码本身：新设备有自己的本机码
    'xuan_attest_client',          // 设备证明 clientId
    'xuan_downloaded_update',      // 本地下载记录
    'xuan_github_pending_at',
    'xuan_github_pending_state',
    'xuan_pending_login',
    'xuan_route_map_v2',           // 动态路由表：60s 轮换，服务端下发
    'xuan_remote_resources_v1',    // 远程资源清单：服务端下发
    'xuan_sync_status_v1',         // 运行时状态
    'xuan_cache_size',             // 缓存体积统计
    'xuan_cached_media_songs',     // 本地缓存歌曲元数据（设备相关）
]);

export function generateIdentityCode(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < 32; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    return out;
}

export function readIdentityCode(): string {
    try {
        const v = localStorage.getItem(ID_KEY) || '';
        if (/^[A-Za-z0-9!@#$%^&*._~-]{32}$/.test(v)) return v;
    } catch {  }
    const fresh = generateIdentityCode();
    try { localStorage.setItem(ID_KEY, fresh); } catch {  }
    return fresh;
}

export function rotateIdentityCode(): string {
    const fresh = generateIdentityCode();
    try { localStorage.setItem(ID_KEY, fresh); } catch {  }
    return fresh;
}

export async function identityExists(identity: string): Promise<boolean> {
    const r = await signedRequest<{ exists?: boolean }>('POST', '/api/identity/exists', { identity });
    return Boolean(r?.exists);
}

export interface IdentityAccountSnapshot {
    neteaseCookie: string;
    githubToken: string;
    neteaseUser: Record<string, unknown>;
    githubUser: Record<string, unknown>;
    /** 全部本地配置（xuan_* 键 -> 原始字符串），跨设备同步。 */
    config?: Record<string, string>;
}

/** 收集本机全部需要同步的配置（localStorage 中的 xuan_* 键）。 */
export function collectConfigSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith('xuan_') || CONFIG_EXCLUDE.has(key)) continue;
            const val = localStorage.getItem(key);
            if (val == null) continue;
            // 跳过超大值（如主题注册表可能很大），避免 body 过大导致签名/传输失败。
            if (val.length > 200000) continue;
            out[key] = val;
        }
    } catch {  }
    return out;
}

export async function identitySave(
    identity: string,
    password: string,
    neteaseUser: Record<string, unknown>,
    githubUser: Record<string, unknown>,
): Promise<boolean> {
    const neteaseCookie = readProviderSessionValue('netease', 'cookie', ['netease_cookie']) || '';
    const githubToken = readGithubSession() || '';
    // 允许未登录任何账号时也能保存（空账号快照）：复制的身份码在恢复时校验通过、下发空账号。
    // 但「全部配置」始终随快照上传，即使当前未登录也能同步主题/音效/开关等设置。
    const config = collectConfigSnapshot();
    const r = await signedRequest<{ ok?: boolean }>('POST', '/api/identity/save', {
        identity, password, neteaseCookie, githubToken, neteaseUser, githubUser, config,
    });
    return Boolean(r?.ok);
}

export async function identityRedeem(identity: string, password: string): Promise<IdentityAccountSnapshot | null> {
    const r = await signedRequest<IdentityAccountSnapshot>('POST', '/api/identity/redeem', { identity, password });
    if (!r || typeof r !== 'object') return null;
    return r;
}

/** 恢复账号 + 全部配置；账号写入各自 store/secure 存储，配置写回 localStorage 后触发自愈重载。 */
export function applyIdentitySnapshot(snap: IdentityAccountSnapshot): void {
    if (snap.neteaseCookie) writeProviderSessionValue('netease', 'cookie', snap.neteaseCookie);
    if (snap.githubToken) writeGithubSession(snap.githubToken);
    if (snap.config && typeof snap.config === 'object') {
        try {
            for (const [key, val] of Object.entries(snap.config)) {
                if (key.startsWith('xuan_') && !CONFIG_EXCLUDE.has(key) && typeof val === 'string') {
                    localStorage.setItem(key, val);
                }
            }
        } catch {  }
    }
}

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|c2bc3f8f8b30|a6c289defcd2");}catch(_e){}
