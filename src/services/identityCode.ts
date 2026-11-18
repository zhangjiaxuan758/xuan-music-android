// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import { signedRequest } from './xuanServer';
import { readProviderSessionValue, writeProviderSessionValue } from './onlineMusic/providerStorage';
import { readGithubSession, writeGithubSession } from './githubSession';

const ID_KEY = 'xuan_identity_code';

/**
 * 身份授权码：服务端权威下发并同步的身份凭据（跨设备/重装可用）。
 * 2026-11-18 架构改造：
 *  - 授权码由服务端用密码学安全随机源生成并下发（服务端本来就有记录），
 *    不再由客户端本地生成、更不依赖「复制」动作才上传；
 *  - 同一正版设备（证明会话 clientId 绑定）重复领取返回同一个码，本机码稳定；
 *  - 设置密码时把「已登录账号 + 全部本地配置」加密同步到服务端，供跨设备/重装恢复；
 *  - 输入本机自己的码也照常 exists -> redeem -> 全量下发账号与配置 -> 整体重载；
 *  - 码含账号信息，服务端 AES-256-GCM + PBKDF2 加密，接口全部要求证明会话签名 + 动态路由。
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

const ID_RE = /^[A-Za-z0-9!@#$%^&*._~-]{32}$/;

/**
 * 从服务端领取（或幂等复用）本机身份授权码。
 * 服务端按证明会话 clientId 绑定：同一正版设备始终拿到同一个码，
 * 下发即在服务端建立记录，因此「本机授权码」在服务端本来就存在。
 * 领到后写入本地缓存，供同步读取使用。失败时回退本地缓存，保证离线也能展示上次的码。
 */
export async function fetchOrCreateIdentity(): Promise<string> {
    try {
        const r = await signedRequest<{ identity?: string }>('POST', '/api/identity/issue', {});
        const code = r?.identity || '';
        if (ID_RE.test(code)) {
            try { localStorage.setItem(ID_KEY, code); } catch {  }
            return code;
        }
    } catch {  }
    // 网络异常/会话未就绪：回退本地缓存（可能为旧值），UI 可后续重试。
    return readIdentityCode();
}

/** 同步读取已缓存的本机授权码；没有缓存时返回空串（由 fetchOrCreateIdentity 负责异步领取）。 */
export function readIdentityCode(): string {
    try {
        const v = localStorage.getItem(ID_KEY) || '';
        if (ID_RE.test(v)) return v;
    } catch {  }
    return '';
}

/** 是否已有可用的服务端授权码缓存。 */
export function hasIdentityCode(): boolean {
    return ID_RE.test(readIdentityCode());
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
