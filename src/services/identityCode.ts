// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import { signedRequest } from './xuanServer';
import { readProviderSessionValue, readSecureToken, removeProviderSessionValue, writeProviderSessionValue } from './onlineMusic/providerStorage';
import { readGithubSession, writeGithubSession } from './githubSession';

/** 身份码密码在本机安全存储中的键（与设置页/播放器卡片保持一致）。 */
export const IDENTITY_PW_CACHE_KEY = 'xuan_identity_pw';

/** 绑定标记：记录本机当前通过哪个授权码恢复了账号（redeem 成功时写入）。
 *  有值=已绑定（显示"取消绑定"）；空=未绑定（不显示）。配置同步不覆盖此键。 */
const BOUND_CODE_KEY = 'xuan_identity_bound_code';


const ID_KEY = 'xuan_identity_code';
/* DSH 沙箱绑定：当前生效的授权码。 redemption 成功后写入，DSH 前端壳据此加载
 * 该授权码绑定的服务端沙箱。因为是授权码本身，跨设备/重装天然一致——
 * 在任意设备输入授权码 X 并 redeem 成功，本机 DSH 沙箱强制切到 X 绑定的目录。 */
const DSH_SANDBOX_KEY = 'xuan_dsh_sandbox_id';
/* 本地稳定兜底码：服务端未就绪/握手未建立时，先生成一个本机稳定的 32 位码并落盘，
 * 保证设置页「码值」永远可见（修复身份码空白）；握手恢复后 fetchOrCreateIdentity
 * 会用服务端权威下发的码校准覆盖。字符集与 ID_RE / 服务端 ID_ALPHABET 一致。 */
const ID_LOCAL_FALLBACK_KEY = 'xuan_identity_local_fallback';
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*._~-';

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
    'xuan_identity_bound_code',    // 绑定状态：本机是否绑定授权码，不随快照覆盖
    'xuan_dsh_sandbox_id',         // DSH 沙箱绑定码：由本次 redeem 的授权码权威决定，不随快照覆盖
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

/* 授权码格式：
 * - 新格式（2026-11-23）：xuan_ 前缀 + 40~60 位易读随机串（字母数字，去混淆字符）；
 * - 旧格式（兼容）：32 位，字母表 ID_ALPHABET。
 * 服务端按同一条正则校验，两种格式的码都能 redeem。 */
export const IDENTITY_CODE_RE = /^(?:xuan_[A-Za-z0-9]{40,60}|[A-Za-z0-9!@#$%^&*._~-]{32})$/;
const ID_RE = IDENTITY_CODE_RE;

/**
 * 从服务端领取（或幂等复用）本机身份授权码。
 * 服务端按证明会话 clientId 绑定：同一正版设备始终拿到同一个码，
 * 下发即在服务端建立记录，因此「本机授权码」在服务端本来就存在。
 * 领到后写入本地缓存，供同步读取使用。失败时回退本地缓存，保证离线也能展示上次的码。
 */
/** 生成本机稳定的 32 位兜底码（仅本机持久化，握手恢复后会被服务端权威码覆盖）。 */
function localFallbackCode(): string {
    try {
        const existing = localStorage.getItem(ID_LOCAL_FALLBACK_KEY) || '';
        if (ID_RE.test(existing)) return existing;
    } catch {  }
    let code = '';
    const rnd = (typeof crypto !== 'undefined' && crypto.getRandomValues)
        ? crypto.getRandomValues(new Uint8Array(32)) : null;
    if (rnd) {
        for (let i = 0; i < 32; i++) code += ID_ALPHABET[rnd[i] % ID_ALPHABET.length];
    } else {
        for (let i = 0; i < 32; i++) code += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
    try { localStorage.setItem(ID_LOCAL_FALLBACK_KEY, code); } catch {  }
    return code;
}

export async function fetchOrCreateIdentity(): Promise<string> {
    try {
        const r = await signedRequest<{ identity?: string }>('POST', '/api/identity/issue', {});
        const code = r?.identity || '';
        if (ID_RE.test(code)) {
            try { localStorage.setItem(ID_KEY, code); } catch {  }
            return code;
        }
    } catch {  }
    // 网络异常/会话未就绪：回退本地缓存，仍为空则用本地稳定兜底码，确保码值恒定可见。
    return readIdentityCode() || localFallbackCode();
}

/** 同步读取已缓存的本机授权码；无缓存时用本地稳定兜底码，保证 UI 永不空白。 */
export function readIdentityCode(): string {
    try {
        const v = localStorage.getItem(ID_KEY) || '';
        if (ID_RE.test(v)) return v;
    } catch {  }
    return localFallbackCode();
}

/** 是否已有可用的服务端授权码缓存。 */
export function hasIdentityCode(): boolean {
    return ID_RE.test(readIdentityCode());
}

export interface IdentityExistsResult {
    exists: boolean;
    /** 该码是否设置过密码；false（空壳码/未设密码）时可直接 redeem，无需密码弹窗。 */
    hasPassword: boolean;
}

export async function identityExists(identity: string): Promise<IdentityExistsResult> {
    const r = await signedRequest<{ exists?: boolean; hasPassword?: boolean }>(
        'POST', '/api/identity/exists', { identity });
    return {
        exists: Boolean(r?.exists),
        // 兼容旧服务端：字段缺失时按「有密码」保守处理（仍弹密码框）。
        hasPassword: r?.hasPassword !== false,
    };
}

export interface IdentityAccountSnapshot {
    neteaseCookie: string;
    githubToken: string;
    neteaseUser: Record<string, unknown>;
    githubUser: Record<string, unknown>;
    /** 全部本地配置（xuan_* 键 -> 原始字符串），跨设备同步。 */
    config?: Record<string, string>;
}

/**
 * bodyHash 现已由原生增量哈希（netSha256Bytes，16KB 分块）覆盖完整字节，
 * 不再受 JNI 单参数槽 32760 字节上限影响 —— 完整配置可正常同步。
 * 这里仅保留一个宽松的兜底上限，避免极端超大 body 造成传输/内存问题。
 */
const CONFIG_SNAPSHOT_MAX_BYTES = 500000;

/** 按 UTF-8 字节数计量（与 JNI GetStringUTFChars / 服务端 sha256(body_bytes) 一致口径）。 */
function utf8Bytes(s: string): number {
    try { return new TextEncoder().encode(s).length; } catch { return s.length; }
}

/**
 * 收集本机全部需要同步的配置（localStorage 中的 xuan_* 键），
 * 并严格限制总 UTF-8 字节数，避免 body 超限触发签名引擎截断导致保存失败。
 */
export function collectConfigSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    let total = 0;
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith('xuan_') || CONFIG_EXCLUDE.has(key)) continue;
            const val = localStorage.getItem(key);
            if (val == null) continue;
            const bytes = utf8Bytes(val) + utf8Bytes(key) + 8; // 8 = JSON 键值分隔符等开销
            // 单项或累计超限则跳过；宁可少同步几项，也不能让 body 超限导致整体保存失败。
            if (total + bytes > CONFIG_SNAPSHOT_MAX_BYTES) continue;
            out[key] = val;
            total += bytes;
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
    const r = await signedRequest<IdentityAccountSnapshot & { ok?: boolean }>('POST', '/api/identity/redeem', { identity, password });
    // signedRequest 把非 2xx（如密码错误的 403）也包装成对象返回并带 ok:false；
    // 必须显式检查 ok，否则错误对象会被当成「成功快照」下发，导致任意密码都提示校验成功却什么都没恢复。
    if (!r || typeof r !== 'object' || r.ok === false) return null;
    return r;
}

/** 恢复账号 + 全部配置；账号写入各自 store/secure 存储，配置写回 localStorage 后触发自愈重载。 */
export function applyIdentitySnapshot(snap: IdentityAccountSnapshot, redeemedIdentity?: string): void {
    if (snap.neteaseCookie) writeProviderSessionValue('netease', 'cookie', snap.neteaseCookie);
    if (snap.githubToken) writeGithubSession(snap.githubToken);
    // 跨端恢复：把快照里的网易云账号资料落成本机 user_profile 缓存。
    // 此前只写 cookie（取链能用、会员歌能播），但本机 user_profile 缓存为空，
    // reload 后 loadUserData 读不到 user → 判定"未登录"、音质门控按非会员处理。
    // 这里 fire-and-forget 写入（redeem 后有 900ms 窗口才 reload，足够落盘）。
    if (snap.neteaseUser && typeof snap.neteaseUser === 'object') {
        const raw = snap.neteaseUser as any;
        const uid = raw.id ?? raw.userId;
        if (uid !== undefined && uid !== null && uid !== 0) {
            void import('./onlineMusic/providerStorage').then(({ getProviderCacheKey }) =>
                import('./db').then(({ saveToCache }) =>
                    saveToCache(getProviderCacheKey('netease', 'user_profile'), snap.neteaseUser)
                )
            ).catch(() => {});
        }
    }
    if (snap.config && typeof snap.config === 'object') {
        try {
            for (const [key, val] of Object.entries(snap.config)) {
                if (key.startsWith('xuan_') && !CONFIG_EXCLUDE.has(key) && typeof val === 'string') {
                    localStorage.setItem(key, val);
                }
            }
        } catch {  }
    }
    // 授权码 redeem 成功 → 本机 DSH 沙箱强制绑定到该授权码。
    // 快照里的 config 不覆盖 DSH_SANDBOX_KEY（它在 CONFIG_EXCLUDE 之外会被随快照同步，
    // 但这里以本次输入的授权码为权威，确保跨设备"输入哪个码就用哪个码的沙箱"）。
    if (redeemedIdentity && ID_RE.test(redeemedIdentity)) {
        try { localStorage.setItem(DSH_SANDBOX_KEY, redeemedIdentity); } catch {  }
    }
}

/** 读取当前 DSH 沙箱绑定码：优先 redeem 绑定的授权码，无则用本机授权码。 */
export function readDshSandboxId(): string {
    try {
        const bound = localStorage.getItem(DSH_SANDBOX_KEY) || '';
        if (ID_RE.test(bound)) return bound;
    } catch {  }
    return readIdentityCode();
}

/**
 * 用「本机自己的授权码」从服务端拉取完整快照（账号 + 全部本地配置）并应用到本机。
 * 供身份码展示区的「同步配置」按钮调用：按钮一直可点，始终同步本机码对应的那份快照
 * （另一端用同一个码改了账号/配置后，这边点一下即可把最新状态拉回来）。
 * @param password 本机授权码的密码；空壳码（从未设密码）传空字符串。
 * @returns 成功返回已应用的快照，失败（网络/密码错误/码非法）返回 null。
 */
export async function syncConfigFromSelf(password: string): Promise<IdentityAccountSnapshot | null> {
    const code = readIdentityCode();
    if (!ID_RE.test(code)) return null;
    const snap = await identityRedeem(code, password);
    if (!snap) return null;
    applyIdentitySnapshot(snap, code);
    return snap;
}

/** 读取本机缓存的身份码密码（安全存储），供「同步配置」自动免密同步。 */
export function readIdentityPassword(): string {
    try { return readSecureToken(IDENTITY_PW_CACHE_KEY) || ''; } catch { return ''; }
}

/**
 * 解析「同步配置」所需密码：
 *  - 本机已有安全存储密码 → 直接用它（本机码，密码即本机设的）；
 *  - 无密码缓存 → 查服务端该码是否设过密码；空壳码用空密码直接同步；
 *  - 设过密码但本机无缓存（如恢复场景）→ 返回 needPassword:true，调用方弹密码框。
 */
export async function resolveSelfSyncPassword(): Promise<{ password: string; needPassword: boolean }> {
    const cached = readIdentityPassword();
    if (cached) return { password: cached, needPassword: false };
    try {
        const info = await identityExists(readIdentityCode());
        if (!info.hasPassword) return { password: '', needPassword: false };
    } catch {  }
    return { password: '', needPassword: true };
}

/**
 * 身份码恢复/同步成功后的统一收尾：
 *  1) 上报设备台账（管理端「账号登录信息」来源）；
 *  2) 通知网易云用恢复的 cookie 重拉登录态；
 *  3) 把内存态凭据 flush 到原生安全存储后整体 reload，让所有 store/主题/音效重新 hydrate。
 * 与设置页 doRedeem 的收尾保持一致，供「同步配置」按钮复用。
 */
export function finalizeIdentityRecovery(): void {
    window.setTimeout(() => {
        try { void import('./forcedLogout').then(m => m.registerDevice()); } catch {  }
        try { window.dispatchEvent(new CustomEvent('xuan:identity-recovered')); } catch {  }
    }, 600);
    window.setTimeout(() => {
        void import('./onlineMusic/providerStorage')
            .then(m => m.flushSecureCredentials())
            .catch(() => {})
            .finally(() => {
                try { window.dispatchEvent(new CustomEvent('xuan:ui-unlock')); } catch {  }
                try { window.location.reload(); } catch {  }
            });
    }, 900);
}

/** 读取当前绑定状态：返回绑定的授权码；未绑定返回空串。 */
export function getBoundCode(): string {
    try { return localStorage.getItem(BOUND_CODE_KEY) || ''; } catch { return ''; }
}

/** 标记本机已通过给定授权码绑定（redeem 成功时调用）。 */
export function markBound(code: string): void {
    try { localStorage.setItem(BOUND_CODE_KEY, code); } catch {  }
}

/**
 * 取消绑定：解除本机与授权码的关联，账号全部退出，但**不改动任何本地配置**。
 * 语义（用户确认）：
 *  - 只是账号全部退出（网易云 + GitHub 登出），配置保持当前状态（不回滚、不退回原样）；
 *  - 清除绑定标记 → 界面不再显示"取消绑定"按钮；
 *  - 保留本机授权码本身（那是服务端下发的设备身份，不是绑定关系）。
 * 底层清理存储后整体 reload，让 store/UI 回到未登录态。
 */
export async function unbindIdentity(): Promise<void> {
    // 1) 清除绑定标记
    try { localStorage.removeItem(BOUND_CODE_KEY); } catch {  }
    // 2) 网易云退出：清 cookie + 用户缓存域（store 由 reload 重新 hydrate 为匿名）
    try { removeProviderSessionValue('netease', 'cookie', ['netease_cookie']); } catch {  }
    try {
        const { removeCacheEntries, removeCacheEntriesByPrefix } = await import('./db');
        const { getProviderCacheKey } = await import('./onlineMusic/providerStorage');
        const keys = Object.values({
            profile: getProviderCacheKey('netease', 'user_profile'),
            playlists: getProviderCacheKey('netease', 'user_playlists'),
            likedSongs: getProviderCacheKey('netease', 'user_liked_songs'),
            cloudPlaylist: getProviderCacheKey('netease', 'user_cloud_playlist'),
        });
        await removeCacheEntries(keys);
        // provider 账号快照缓存（前缀清理）
        await removeCacheEntriesByPrefix(['provider:netease', 'netease:user_']);
    } catch {  }
    // 3) GitHub 退出：清会话 token + 账号资料缓存（store 由 reload 重新 hydrate）
    try { writeGithubSession(''); } catch {  }
    try { localStorage.removeItem('xuan_github_account'); } catch {  }
    try { localStorage.removeItem('xuan_github_pending_state'); } catch {  }
    // 4) 通知原生/各 store 登出事件（跨端退出上报由 forcedLogout 监听 user-logout 处理）
    try { window.dispatchEvent(new CustomEvent('xuan:user-logout')); } catch {  }
    // 5) flush 凭据后 reload
    try {
        await import('./onlineMusic/providerStorage').then(m => m.flushSecureCredentials());
    } catch {  }
    try { window.location.reload(); } catch {  }
}

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|c2bc3f8f8b30|a6c289defcd2");}catch(_e){}
