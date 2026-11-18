// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import React, { useEffect, useRef, useState } from 'react';
import { registerPlugin } from '@capacitor/core';

const Native = registerPlugin<{ exitApp: () => Promise<void> }>('XuanNative');

/**
 * 完整性校验失败提示。
 * 2026-11-18 修复：旧版本在这里用 history.pushState 无限回填 + keydown 拦截把用户
 * 彻底锁死（无法返回、无法划动），且登录握手偶发失败就弹全屏黑遮罩 —— 这正是
 * 「登录网易云后黑屏 / 登录后全部划不动点不动」的根因。
 * 新策略：
 *  1) 登录宽限期内（Custom Tab 返回、握手重建）的失败视为瞬时抖动，静默自愈不弹窗；
 *  2) 真要提示时，遮罩可点外部/按钮关闭，并给「重试校验」直接恢复，绝不再绝对锁死。
 */
const LOGIN_GRACE_MS = 20_000;

const IntegrityFailModal: React.FC = () => {
    const [visible, setVisible] = useState(false);
    const loginGraceUntil = useRef(0);

    useEffect(() => {
        const markLogin = () => { loginGraceUntil.current = Date.now() + LOGIN_GRACE_MS; };
        const onFail = () => {
            // 登录链路上的握手抖动：静默派发自愈事件，不弹黑屏。
            if (Date.now() < loginGraceUntil.current) {
                try { window.dispatchEvent(new CustomEvent('xuan:ui-unlock')); } catch {  }
                return;
            }
            setVisible(true);
        };
        const events = [
            'xuan:login-modal-open', 'xuan:login-modal-close',
            'xuan:netease-login-confirmed', 'xuan:github-connected',
            'xuan:provider-login-settled', 'xuan:ui-unlock',
        ];
        events.forEach(e => window.addEventListener(e, markLogin));
        window.addEventListener('xuan:integrity-failed', onFail);
        return () => {
            events.forEach(e => window.removeEventListener(e, markLogin));
            window.removeEventListener('xuan:integrity-failed', onFail);
        };
    }, []);

    const closeAndRetry = () => {
        setVisible(false);
        // 让网络层丢弃旧会话并重建证明，配合 uiUnlockGuard 心跳彻底恢复 UI。
        try { window.dispatchEvent(new CustomEvent('xuan:attest-reset')); } catch {  }
        try { window.dispatchEvent(new CustomEvent('xuan:ui-unlock')); } catch {  }
    };

    const exit = async () => {
        setVisible(false);
        try { await Native.exitApp(); } catch {  }
        try {
            const app = (window as unknown as {
                Capacitor?: { Plugins?: { App?: { exitApp?: () => Promise<void> } } };
            }).Capacitor?.Plugins?.App;
            await app?.exitApp?.();
        } catch {  }
        try { window.close(); } catch {  }
    };

    if (!visible) return null;

    return (
        <div
            className="fixed inset-0 flex items-center justify-center px-6"
            style={{ zIndex: 100000, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)' }}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="xuan-integrity-title"
            onClick={closeAndRetry}
        >
            <div
                className="w-full max-w-md rounded-3xl border border-white/10 bg-zinc-900 px-7 py-8 text-center shadow-[0_30px_80px_rgba(0,0,0,0.65)]"
                style={{ color: '#fafafa' }}
                onClick={e => e.stopPropagation()}
            >
                <div
                    className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl"
                    style={{ background: 'rgba(248,113,113,0.14)', color: '#f87171' }}
                >
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                </div>
                <h2 id="xuan-integrity-title" className="text-xl font-semibold leading-snug">
                    完整性校验失败
                </h2>
                <p className="mt-4 text-sm leading-relaxed" style={{ color: 'rgba(250,250,250,0.68)' }}>
                    软件完整性校验未通过。可重试校验；若持续失败，请不要修改软件内容。
                </p>
                <button
                    type="button"
                    onClick={closeAndRetry}
                    className="mt-8 w-full rounded-2xl py-3 text-sm font-semibold transition-opacity active:opacity-80"
                    style={{ background: 'rgba(59,130,246,.9)', color: '#fff' }}
                >
                    重试校验并返回
                </button>
                <button
                    type="button"
                    onClick={() => void exit()}
                    className="mt-3 w-full rounded-2xl py-2.5 text-sm font-medium transition-opacity active:opacity-80"
                    style={{ background: 'transparent', color: 'rgba(250,250,250,0.55)' }}
                >
                    退出软件
                </button>
            </div>
        </div>
    );
};

export default IntegrityFailModal;

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__/|8229688c787a|01a7ea82d01e");}catch(_e){}
