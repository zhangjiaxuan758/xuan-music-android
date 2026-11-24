// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import React, { useState, useEffect } from 'react';
import { Fingerprint, Copy, Check } from 'lucide-react';
import FloatingLabelInput from './FloatingLabelInput';
import PasswordGateDialog from './PasswordGateDialog';
import {
    readIdentityCode, fetchOrCreateIdentity, identityExists, identityRedeem, applyIdentitySnapshot, identitySave,
    syncConfigFromSelf, finalizeIdentityRecovery, resolveSelfSyncPassword,
    getBoundCode, markBound, unbindIdentity,
    IDENTITY_CODE_RE,
} from '../../../services/identityCode';
import { useGitHubAccountStore } from '../../../stores/useGitHubAccountStore';
import { useOnlineProviderAccountStore } from '../../../stores/useOnlineProviderAccountStore';
import { readSecureToken, writeSecureToken } from '../../../services/onlineMusic/providerStorage';

type Phase = 'idle' | 'ok' | 'fail' | 'missing';

const PW_SET_FLAG = 'xuan_identity_pw_set';
/** 密码缓存于原生安全存储：用于「再次用身份码更新账号信息」时重新加密保存快照。
 *  不写明文 localStorage；原生端走 Android Keystore，网页端退化为内存态。 */
const PW_CACHE_KEY = 'xuan_identity_pw';

const IdentityCodeSubview: React.FC = () => {
    const [code, setCode] = useState('');
    const [phase, setPhase] = useState<Phase>('idle');
    const [checking, setChecking] = useState(false);
    const [pwOpen, setPwOpen] = useState(false);
    const [pwError, setPwError] = useState('');
    const [redeemed, setRedeemed] = useState(false);
    // 身份授权码：服务端权威下发（同设备幂等），先读本地缓存即时展示，再异步向服务端领取/校准。
    const [localCode, setLocalCode] = useState(() => readIdentityCode());
    const [copied, setCopied] = useState(false);
    const [setupOpen, setSetupOpen] = useState(false);
    const [setupBusy, setSetupBusy] = useState(false);
    const [setupError, setSetupError] = useState('');
    const [syncOpen, setSyncOpen] = useState(false);
    const [syncError, setSyncError] = useState('');
    const [syncBusy, setSyncBusy] = useState(false);
    const [bound, setBound] = useState(() => Boolean(getBoundCode()));
    const setGithub = useGitHubAccountStore(state => state.setAccount);
    const updateNetease = useOnlineProviderAccountStore(state => state.updateAccount);
    const githubAccount = useGitHubAccountStore(state => state.account);
    const neteaseAccount = useOnlineProviderAccountStore(state => state.accounts.netease?.user);

    // 进入设置页即向服务端领取本机授权码：码由服务端生成并在服务端本就存在，
    // 同设备重复领取稳定返回同一个码；缓存命中则即时展示、服务端返回后再校准。
    useEffect(() => {
        let alive = true;
        void fetchOrCreateIdentity().then(code => { if (alive && code) setLocalCode(code); });
        return () => { alive = false; };
    }, []);

    const borderColor = phase === 'ok' ? 'rgba(34,197,94,.95)'
        : phase === 'fail' ? 'rgba(239,68,68,.95)'
        : phase === 'missing' ? 'rgba(239,68,68,.55)'
        : undefined;

    // 用给定密码完成恢复（服务端支持空壳码用空密码直接下发空快照）。
    const doRedeem = async (password: string) => {
        setChecking(true);
        setPwError('');
        try {
            const snap = await identityRedeem(code, password);
            if (!snap) {
                setPwError('校验失败');
                setPhase('fail');
                return;
            }
            applyIdentitySnapshot(snap, code);
            // 通过授权码恢复账号 = 已绑定该码，显示"取消绑定"按钮。
            markBound(code);
            setBound(true);
            try {
                if (snap.githubUser && typeof snap.githubUser.id === 'number') {
                    setGithub(snap.githubUser as any);
                }
                if (snap.neteaseUser && Object.keys(snap.neteaseUser).length) {
                    updateNetease('netease', { user: snap.neteaseUser as any, status: 'authenticated' });
                } else if (snap.neteaseCookie) {
                    // 快照未带 user 但有 cookie：也标记为已登录，让后续 refreshUserData
                    // 用恢复的 cookie 去服务端拉取真实账号。此前只判断 neteaseUser 非空，
                    // 导致「cookie 恢复了、界面却显示网易云未登录」。
                    updateNetease('netease', { status: 'authenticated' } as any);
                }
            } catch {  }
            setPhase('ok');
            setPwOpen(false);
            setRedeemed(true);
            // 恢复后立即上报设备台账（管理端「账号登录信息」来源）：
            // cookie/github 会话是异步写入安全存储的，等 secureSet 落盘后再上报，
            // 否则管理端设备列表的「网易云已登录/GitHub 已登录」会一直是空。
            // 仅依赖 reload 后再上报存在竞态（reload 可能早于写入完成）。
            window.setTimeout(() => {
                try {
                    void import('../../../services/forcedLogout').then(m => m.registerDevice());
                } catch {  }
                // 用恢复的 cookie 主动重拉网易云登录态：快照里的 neteaseUser 可能为空
                // （保存时若未加载完成），仅靠它 updateNetease 会导致「GitHub 登录了、网易云没登录」。
                // 这个事件让 useNeteaseLibrary 调 getLoginStatus 校验 cookie 并拉取真实账号。
                try { window.dispatchEvent(new CustomEvent('xuan:identity-recovered')); } catch {  }
            }, 600);
            // 配置写回 localStorage 后，让各 store/主题/音效重新 hydrate。
            // 关键：先把内存态的网易云 cookie / GitHub session 同步刷到原生安全存储
            // 并等待落盘，再 reload——否则新页面 secureGet 读到旧值，表现为
            // 「身份码恢复后 GitHub 登录了、网易云却没登录」。
            window.setTimeout(() => {
                void import('../../../services/onlineMusic/providerStorage')
                    .then(m => m.flushSecureCredentials())
                    .catch(() => {})
                    .finally(() => {
                        try { window.dispatchEvent(new CustomEvent('xuan:ui-unlock')); } catch {  }
                        try { window.location.reload(); } catch {  }
                    });
            }, 900);
        } catch {
            setPwError('校验失败');
            setPhase('fail');
        } finally {
            setChecking(false);
        }
    };

    const verify = async () => {
        setPwError('');
        if (!IDENTITY_CODE_RE.test(code)) {
            setPhase('missing');
            return;
        }
        setChecking(true);
        try {
            // 身份授权码是服务端同步的：即使输入的是本机自己的码，也照常向服务端查询。
            const info = await identityExists(code);
            if (!info.exists) {
                setPhase('missing');
                return;
            }
            setChecking(false);
            // 未设过密码的空壳码：直接校验通过（下发空账号快照 + 配置），不弹密码弹窗。
            if (!info.hasPassword) {
                await doRedeem('');
                return;
            }
            // 设过密码：才弹密码框校验。
            setPwOpen(true);
        } catch {
            setPhase('fail');
        } finally {
            setChecking(false);
        }
    };

    const onPwConfirm = async (password: string) => {
        await doRedeem(password);
    };

    // —— 身份授权码：复制（未登录也能复制，保存空账号快照）——
    const performCopy = async () => {
        try { await navigator.clipboard.writeText(localCode); } catch {  }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
    };

    const handleCopy = () => {
        // 授权码由服务端下发、服务端本就有记录。
        // 已设密码：先用「当前最新账号 + 配置」重新加密保存快照到服务端，再复制——
        // 这样另一端 redeem 时拿到的是此刻的账号状态，而不是首次设密码时的旧快照。
        // 这解决了「另一端已登录网易云/GitHub，却无法用身份码更新到授权码」的问题。
        if (pwSet()) {
            const cachedPw = readSecureToken(PW_CACHE_KEY) || '';
            if (cachedPw) {
                void identitySave(
                    localCode,
                    cachedPw,
                    (neteaseAccount as unknown as Record<string, unknown>) || {},
                    (githubAccount as unknown as Record<string, unknown>) || {},
                ).catch(() => {}).finally(() => performCopy());
                return;
            }
            // 老版本只存了 PW_SET_FLAG、没有缓存密码：弹密码框重新设置一次即可恢复更新能力。
            setSetupError('');
            setSetupOpen(true);
            return;
        }
        setSetupError('');
        setSetupOpen(true);
    };

    const pwSet = () => {
        try { return localStorage.getItem(PW_SET_FLAG) === '1'; } catch { return false; }
    };

    const onSetupConfirm = async (password: string) => {
        setSetupBusy(true);
        setSetupError('');
        try {
            const ok = await identitySave(
                localCode,
                password,
                (neteaseAccount as unknown as Record<string, unknown>) || {},
                (githubAccount as unknown as Record<string, unknown>) || {},
            );
            if (!ok) { setSetupError('保存失败，请重试'); return; }
            // 缓存密码到安全存储：后续「复制身份码」时用它把最新账号重新同步到服务端。
            try { writeSecureToken(PW_CACHE_KEY, password); } catch {  }
            try { localStorage.setItem(PW_SET_FLAG, '1'); } catch {  }
            setSetupOpen(false);
            await performCopy();
        } catch {
            setSetupError('保存失败，请重试');
        } finally {
            setSetupBusy(false);
        }
    };

    const onSetupSkip = () => {
        // 可选：不设密码仅同步不到账号信息，但授权码本身已在服务端、可直接复制。
        setSetupOpen(false);
        setSetupError('');
        void performCopy();
    };

    // —— 同步配置：用本机自己的码，把服务端最新快照（账号+全部本地设置）拉回本机 ——
    // 按钮常驻身份码展示区、一直可点；密码自动从安全存储读取，空壳码免密，
    // 仅当本机无密码缓存但该码在服务端设过密码时才弹框。
    const runSync = async (password: string) => {
        setSyncBusy(true);
        setSyncError('');
        try {
            const snap = await syncConfigFromSelf(password);
            if (!snap) {
                setSyncError('同步失败，请检查网络或密码');
                return;
            }
            // 账号资料落到 store（reload 前即时反映），随后统一收尾。
            try {
                if (snap.githubUser && typeof (snap.githubUser as any).id === 'number') {
                    setGithub(snap.githubUser as any);
                }
                if (snap.neteaseUser && Object.keys(snap.neteaseUser).length) {
                    updateNetease('netease', { user: snap.neteaseUser as any, status: 'authenticated' });
                } else if (snap.neteaseCookie) {
                    updateNetease('netease', { status: 'authenticated' } as any);
                }
            } catch {  }
            setSyncOpen(false);
            finalizeIdentityRecovery();
        } catch {
            setSyncError('同步失败，请检查网络或密码');
        } finally {
            setSyncBusy(false);
        }
    };

    const handleSyncConfig = () => {
        void resolveSelfSyncPassword().then(({ password, needPassword }) => {
            if (needPassword) {
                setSyncError('');
                setSyncOpen(true);
                return;
            }
            return runSync(password);
        }).catch(() => {
            setSyncError('同步失败，请检查网络');
            setSyncOpen(true);
        });
    };

    // —— 取消绑定：账号全部退出，配置保持当前状态，解除绑定关系 ——
    const handleUnbind = () => {
        if (!window.confirm('取消绑定后本机账号将全部退出（配置保持不变），确定继续？')) return;
        void unbindIdentity().finally(() => setBound(false));
    };

    const feedback = phase === 'ok' ? { text: '校验成功，正在恢复账号与配置…', color: 'rgba(34,197,94,.95)' }
        : phase === 'fail' ? { text: '校验失败', color: 'rgba(239,68,68,.95)' }
        : phase === 'missing' ? { text: '身份授权码不存在或尚未在服务端保存', color: 'var(--text-secondary)' }
        : null;

    return (
        <div className="space-y-5">
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                输入身份授权码 + 密码，跨设备/重装后恢复已登录账号与全部配置（免扫码）
            </div>

            <FloatingLabelInput
                value={code}
                onChange={(v) => { setCode(v); setPhase('idle'); setRedeemed(false); }}
                label="身份授权码（xuan_ 开头）"
                borderColor={borderColor}
                maxLength={64}
            />
            {feedback && (
                <div className="text-sm font-medium -mt-2" style={{ color: feedback.color }}>{feedback.text}</div>
            )}

            <button
                type="button"
                onClick={() => void verify()}
                disabled={checking || code.length === 0}
                className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-opacity active:opacity-80 disabled:opacity-40"
                style={{ background: 'rgba(59,130,246,.85)' }}
            >
                {checking ? '校验中…' : '校验并恢复账号'}
            </button>

            {redeemed && (
                <div className="flex items-center gap-2 text-xs" style={{ color: 'rgba(34,197,94,.95)' }}>
                    <Check size={14} /> 账号信息已下发，可返回主页使用
                </div>
            )}

            {/* 身份授权码：与播放器端同一个东西，固定不可重新生成，带复制按钮 */}
            <div className="rounded-xl p-3 space-y-2" style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)' }}>
                <div className="flex items-center gap-2 text-xs opacity-70" style={{ color: 'var(--text-secondary)' }}>
                    <Fingerprint size={14} /> 身份授权码
                </div>
                <div className="text-[11px] font-mono break-all select-all" style={{ color: 'var(--text-primary)' }}>
                    {localCode}
                </div>
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={handleCopy}
                        className="flex-1 flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-opacity active:opacity-70"
                        style={{ borderColor: 'var(--accent-color, currentColor)', color: 'var(--accent-color, currentColor)' }}
                    >
                        {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? '已复制' : '复制身份授权码'}
                    </button>
                    <button
                        type="button"
                        onClick={handleSyncConfig}
                        disabled={syncBusy}
                        className="flex-1 flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-opacity active:opacity-70 disabled:opacity-50"
                        style={{ borderColor: 'var(--accent-color, currentColor)', color: 'var(--accent-color, currentColor)' }}
                        title="用本机授权码同步账号与全部本地设置"
                    >
                        {syncBusy ? '同步中…' : '同步配置'}
                    </button>
                </div>
                {bound && (
                    <button
                        type="button"
                        onClick={handleUnbind}
                        className="w-full flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-opacity active:opacity-70"
                        style={{ borderColor: 'var(--accent-color, currentColor)', color: 'var(--accent-color, currentColor)' }}
                        title="解除绑定并退出全部账号（配置保持不变）"
                    >
                        取消绑定
                    </button>
                )}
            </div>

            {/* 恢复账号：输入密码校验 */}
            <PasswordGateDialog
                open={pwOpen}
                mode="verify"
                busy={checking}
                error={pwError}
                onClose={() => { setPwOpen(false); setPwError(''); }}
                onConfirm={onPwConfirm}
            />
            {/* 首次复制：设置密码（未登录也可，保存空账号快照） */}
            <PasswordGateDialog
                open={setupOpen}
                mode="setup"
                busy={setupBusy}
                error={setupError}
                onClose={() => { setSetupOpen(false); setSetupError(''); }}
                onSkip={onSetupSkip}
                onConfirm={onSetupConfirm}
            />
            {/* 同步配置：本机无密码缓存但该码设过密码时，输入密码校验 */}
            <PasswordGateDialog
                open={syncOpen}
                mode="verify"
                busy={syncBusy}
                error={syncError}
                onClose={() => { setSyncOpen(false); setSyncError(''); }}
                onConfirm={(pw) => runSync(pw)}
            />
        </div>
    );
};

export default IdentityCodeSubview;

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|07d4355c1648|6dc712e032fd");}catch(_e){}
