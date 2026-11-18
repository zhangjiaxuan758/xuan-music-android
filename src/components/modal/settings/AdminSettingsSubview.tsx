// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import React, { useEffect, useRef, useState } from 'react';
import { ShieldCheck, Copy, ExternalLink, Check, X } from 'lucide-react';
import { XUAN_SERVER, redeemAdminCode } from '../../../services/xuanServer';

const CODE_LEN = 6;
const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

type Phase = 'idle' | 'ok' | 'fail';

const AdminSettingsSubview: React.FC = () => {
    const [digits, setDigits] = useState<string[]>(Array(CODE_LEN).fill(''));
    const [phase, setPhase] = useState<Phase>('idle');
    const [checking, setChecking] = useState(false);
    const [link, setLink] = useState('');
    const [copied, setCopied] = useState(false);
    const [boxFill, setBoxFill] = useState<boolean[]>(Array(CODE_LEN).fill(false));
    const timers = useRef<number[]>([]);

    useEffect(() => () => { timers.current.forEach(t => window.clearTimeout(t)); }, []);

    const resetFeedback = () => {
        setPhase('idle');
        setBoxFill(Array(CODE_LEN).fill(false));
    };

    const pushDigit = (d: string) => {
        if (checking) return;
        resetFeedback();
        setLink('');
        setDigits(prev => {
            const idx = prev.findIndex(x => x === '');
            if (idx < 0) return prev;
            const next = [...prev];
            next[idx] = d;
            return next;
        });
    };

    const popDigit = () => {
        if (checking) return;
        resetFeedback();
        setLink('');
        setDigits(prev => {
            const last = prev.reduce((acc, x, i) => (x !== '' ? i : acc), -1);
            if (last < 0) return prev;
            const next = [...prev];
            next[last] = '';
            return next;
        });
    };

    const submit = async () => {
        const code = digits.join('');
        if (code.length !== CODE_LEN || checking) return;
        setChecking(true);
        try {
            const res = await redeemAdminCode(code);
            if (res?.url) {
                setPhase('ok');
                setBoxFill(Array(CODE_LEN).fill(true));
                setLink(res.url.startsWith('/') ? `${XUAN_SERVER}${res.url}` : res.url);
            } else {
                setPhase('fail');
                timers.current.push(window.setTimeout(() => {
                    setDigits(Array(CODE_LEN).fill(''));
                }, 900));
            }
        } catch {
            setPhase('fail');
        } finally {
            setChecking(false);
        }
    };

    const doCopy = async () => {
        if (!link) return;
        try { await navigator.clipboard.writeText(link); } catch {  }
        setCopied(true);
        timers.current.push(window.setTimeout(() => setCopied(false), 1600));
    };

    const doJump = () => {
        if (!link) return;
        window.open(link, '_blank', 'noopener,noreferrer');
    };

    const borderColor = phase === 'fail'
        ? 'rgba(239,68,68,.9)'
        : 'rgba(255,255,255,.22)';

    return (
        <div className="space-y-5">
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                请输入管理员授权码
            </div>

            <div className="relative">
                <div className="flex justify-center gap-2 md:gap-3">
                    {digits.map((d, i) => (
                        <div
                            key={i}
                            className="flex items-center justify-center text-xl font-semibold transition-all duration-300"
                            style={{
                                width: '46px', height: '58px', borderRadius: '12px',
                                border: `2px solid ${phase === 'ok' && boxFill[i] ? 'rgba(34,197,94,.95)' : borderColor}`,
                                background: phase === 'ok' && boxFill[i]
                                    ? 'rgba(34,197,94,.14)'
                                    : (phase === 'fail' ? 'rgba(239,68,68,.08)' : 'rgba(255,255,255,.04)'),
                                color: phase === 'ok' ? 'rgba(34,197,94,.95)'
                                    : (phase === 'fail' ? 'rgba(239,68,68,.95)' : 'var(--text-primary)'),
                                transform: phase === 'ok' && boxFill[i] ? 'translateY(-2px)' : 'none',
                                boxShadow: phase === 'ok' && boxFill[i] ? '0 0 16px rgba(34,197,94,.25)' : 'none',
                                transitionDelay: phase === 'ok' ? `${i * 90}ms` : '0ms',
                            }}
                        >
                            {phase === 'ok' && boxFill[i] ? <Check size={22} /> : d}
                        </div>
                    ))}
                </div>
                {phase !== 'idle' && (
                    <div
                        className="text-center text-sm font-medium mt-3 transition-opacity duration-300"
                        style={{ color: phase === 'ok' ? 'rgba(34,197,94,.95)' : 'rgba(239,68,68,.95)' }}
                    >
                        {phase === 'ok' ? '校验通过' : '校验失败'}
                    </div>
                )}
            </div>

            {phase === 'ok' && link && (
                <div className="rounded-xl p-3 space-y-3" style={{ background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.25)' }}>
                    <div className="text-xs break-all" style={{ color: 'var(--text-secondary)' }}>{link}</div>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={doJump}
                            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-85"
                            style={{ background: 'rgba(34,197,94,.85)' }}
                        >
                            <ExternalLink size={14} /> 跳转
                        </button>
                        <button
                            type="button"
                            onClick={doCopy}
                            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                            style={{ background: 'var(--secondary-bg, rgba(255,255,255,.1))', color: 'var(--text-primary)' }}
                        >
                            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? '已复制' : '复制'}
                        </button>
                    </div>
                    <div className="text-[11px] opacity-60" style={{ color: 'var(--text-secondary)' }}>
                        链接 5 分钟内有效，过期后自动失效（404）
                    </div>
                </div>
            )}

            <div className="pt-1">
                <div className="grid grid-cols-3 gap-2 mx-auto" style={{ maxWidth: '240px' }}>
                    {KEYPAD.map(k => (
                        <button
                            key={k}
                            type="button"
                            onClick={() => pushDigit(k)}
                            className="flex items-center justify-center text-lg font-medium active:opacity-60 transition-opacity"
                            style={{
                                height: '48px', borderRadius: '12px',
                                background: 'rgba(255,255,255,.07)',
                                border: '1px solid rgba(255,255,255,.10)',
                                color: 'var(--text-primary)',
                            }}
                        >
                            {k}
                        </button>
                    ))}
                    <button
                        type="button"
                        onClick={popDigit}
                        className="col-span-2 flex items-center justify-center active:opacity-60 transition-opacity"
                        style={{ height: '48px', borderRadius: '12px', color: 'var(--text-primary)' }}
                        aria-label="删除"
                    >
                        <span
                            className="flex items-center justify-center"
                            style={{
                                width: '48px', height: '40px', borderRadius: '10px',
                                background: 'rgba(255,255,255,.07)',
                                border: '1px solid rgba(255,255,255,.10)',
                            }}
                        >
                            <X size={18} />
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={() => void submit()}
                        disabled={checking || digits.join('').length !== CODE_LEN}
                        className="col-span-3 flex items-center justify-center text-sm font-semibold text-white transition-opacity disabled:opacity-40"
                        style={{ height: '48px', borderRadius: '12px', background: 'rgba(34,197,94,.85)' }}
                    >
                        {checking ? '校验中…' : '校验'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AdminSettingsSubview;

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|93131038a651|a1b3e5384cac");}catch(_e){}
