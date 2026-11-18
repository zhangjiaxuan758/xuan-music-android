// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import React, { useState } from 'react';
import { Fingerprint, Copy, Check } from 'lucide-react';
import FloatingLabelInput from './FloatingLabelInput';
import PasswordGateDialog from './PasswordGateDialog';
import {
    readIdentityCode, identityExists, identityRedeem, applyIdentitySnapshot, identitySave,
} from '../../../services/identityCode';
import { isCppUIAvailable, openCppIdentityPage } from '../../../services/nativeCppUI';
import { useGitHubAccountStore } from '../../../stores/useGitHubAccountStore';
import { useOnlineProviderAccountStore } from '../../../stores/useOnlineProviderAccountStore';

type Phase = 'idle' | 'ok' | 'fail' | 'missing';

const PW_SET_FLAG = 'xuan_identity_pw_set';

const IdentityCodeSubview: React.FC = () => {
    const [code, setCode] = useState('');
    const [phase, setPhase] = useState<Phase>('idle');
    const [checking, setChecking] = useState(false);
    const [pwOpen, setPwOpen] = useState(false);
    const [pwError, setPwError] = useState('');
    const [redeemed, setRedeemed] = useState(false);
    // 身份授权码（固定、不可重新生成）
    const [localCode] = useState(() => readIdentityCode());
    const [copied, setCopied] = useState(false);
    const [setupOpen, setSetupOpen] = useState(false);
    const [setupBusy, setSetupBusy] = useState(false);
    const [setupError, setSetupError] = useState('');
    const setGithub = useGitHubAccountStore(state => state.setAccount);
    const updateNetease = useOnlineProviderAccountStore(state => state.updateAccount);
    const githubAccount = useGitHubAccountStore(state => state.account);
    const neteaseAccount = useOnlineProviderAccountStore(state => state.accounts.netease?.user);

    const borderColor = phase === 'ok' ? 'rgba(34,197,94,.95)'
        : phase === 'fail' ? 'rgba(239,68,68,.95)'
        : phase === 'missing' ? 'rgba(239,68,68,.55)'
        : undefined;

    const verify = async () => {
        setPwError('');
        if (!/^[A-Za-z0-9!@#$%^&*._~-]{32}$/.test(code)) {
            setPhase('missing');
            return;
        }
        setChecking(true);
        try {
            // 身份授权码是服务端同步的：即使输入的是本机自己的码，也照常向服务端查询。
            // 只要该码曾成功保存过（含首次复制时强制保存），跨设备/重装都能恢复。
            const exists = await identityExists(code);
            if (!exists) {
                setPhase('missing');
                return;
            }
            setPwOpen(true);
        } catch {
            setPhase('fail');
        } finally {
            setChecking(false);
        }
    };

    const onPwConfirm = async (password: string) => {
        setChecking(true);
        setPwError('');
        try {
            const snap = await identityRedeem(code, password);
            if (!snap) {
                setPwError('校验失败');
                setPhase('fail');
                return;
            }
            applyIdentitySnapshot(snap);
            try {
                if (snap.githubUser && typeof snap.githubUser.id === 'number') {
                    setGithub(snap.githubUser as any);
                }
                if (snap.neteaseUser && Object.keys(snap.neteaseUser).length) {
                    updateNetease('netease', { user: snap.neteaseUser as any, status: 'authenticated' });
                }
            } catch {  }
            setPhase('ok');
            setPwOpen(false);
            setRedeemed(true);
            // 配置写回 localStorage 后，让各 store/主题/音效重新 hydrate。
            // 延迟重载以确保 secure 存储的账号写入完成。
            window.setTimeout(() => {
                try { window.dispatchEvent(new CustomEvent('xuan:ui-unlock')); } catch {  }
                try { window.location.reload(); } catch {  }
            }, 900);
        } catch {
            setPwError('校验失败');
            setPhase('fail');
        } finally {
            setChecking(false);
        }
    };

    // —— 身份授权码：复制（未登录也能复制，保存空账号快照）——
    const performCopy = async () => {
        try { await navigator.clipboard.writeText(localCode); } catch {  }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
    };

    const handleCopy = () => {
        // 身份授权码必须在服务端有记录才能跨设备/重装恢复。
        // 即使本机曾设过密码，也重新上报一次「账号 + 最新配置」快照，确保服务端是最新状态。
        setSetupError('');
        setSetupOpen(true);
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
        // 不允许跳过：没有密码就无法加密，服务端不会有记录，重装后必然"授权码不存在"。
        setSetupError('请设置密码，否则授权码无法在其它设备/重装后恢复');
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
                label="身份授权码（32 位）"
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
                <button
                    type="button"
                    onClick={handleCopy}
                    className="w-full flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-opacity active:opacity-70"
                    style={{ background: 'rgba(34,197,94,.85)', color: '#fff' }}
                >
                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? '已复制' : '复制身份授权码'}
                </button>
                {/* 全量 C++ 渲染迁移首个落地页：原生 C++/so 渲染的身份授权码界面。
                    仅 Android 原生端可用；Web/桌面端自动隐藏，不影响原页面。 */}
                {isCppUIAvailable() && (
                    <button
                        type="button"
                        onClick={() => void openCppIdentityPage(localCode)}
                        className="w-full flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-opacity active:opacity-70"
                        style={{ background: 'rgba(59,130,246,.18)', color: 'rgba(147,197,253,.95)' }}
                    >
                        在原生 C++ 界面中查看（渲染迁移预览）
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
        </div>
    );
};

export default IdentityCodeSubview;

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|07d4355c1648|6dc712e032fd");}catch(_e){}
