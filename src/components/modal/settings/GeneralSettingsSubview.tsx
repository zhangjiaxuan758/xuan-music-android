// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import React, { useState } from 'react';
import { Languages, LayoutList, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { Theme } from '../../../types';
import type { AppLanguagePreference } from '../../../i18n/config';
import { useSettingsUiStore } from '../../../stores/useSettingsUiStore';
import { CustomSelect } from '../../shared/CustomSelect';
import PinnedCommandSettings from './PinnedCommandSettings';
import { supportsLocalMusicImport } from '../../../platform/runtime';
import { manualCheckUpdate } from '../../../services/appUpdater';
import { IS_BETA, publishBetaVersion } from '../../../services/xuanServer';
import FrameRateSection from './FrameRateSection';

type GeneralSettingsSubviewProps = {
    isDaylight: boolean;
    settingsCardClass: string;
    theme?: Theme;
};

const GeneralSettingsSubview: React.FC<GeneralSettingsSubviewProps> = ({
    isDaylight,
    settingsCardClass,
    theme,
}) => {
    const { t, i18n } = useTranslation();
    const [checking, setChecking] = useState(false);
    const [publishing, setPublishing] = useState(false);
    const [publishMsg, setPublishMsg] = useState('');
    const onCheckUpdate = async () => {
      setChecking(true);
      try { await manualCheckUpdate(); } finally { setChecking(false); }
    };
    const onPublishBeta = async () => {
      if (publishing) return;
      setPublishing(true);
      setPublishMsg('');
      try {
        const r = await publishBetaVersion();
        setPublishMsg(r ? '发布成功，正式版将收到更新弹窗' : '发布失败，请稍后重试');
      } catch {
        setPublishMsg('发布失败，请稍后重试');
      } finally {
        setPublishing(false);
      }
    };
    const {
        appLanguagePreference,
        onAppLanguagePreferenceChange,
        showHomeTabPlaylist,
        showHomeTabRadio,
        showHomeTabAlbums,
        showHomeTabLocal,
        showHomeTabDevRecommend,
        showHomeTabHotChart,
        showHomeTabGufengChart,
        showHomeTabCache,
        handleToggleHomeTabPlaylist,
        handleToggleHomeTabRadio,
        handleToggleHomeTabAlbums,
        handleToggleHomeTabLocal,
        handleToggleHomeTabDevRecommend,
        handleToggleHomeTabHotChart,
        handleToggleHomeTabGufengChart,
        handleToggleHomeTabCache,
    } = useSettingsUiStore(useShallow(state => ({
        appLanguagePreference: state.appLanguagePreference,
        onAppLanguagePreferenceChange: state.handleSetAppLanguagePreference,
        showHomeTabPlaylist: state.showHomeTabPlaylist,
        showHomeTabRadio: state.showHomeTabRadio,
        showHomeTabAlbums: state.showHomeTabAlbums,
        showHomeTabLocal: state.showHomeTabLocal,
        showHomeTabDevRecommend: state.showHomeTabDevRecommend,
        handleToggleHomeTabPlaylist: state.handleToggleHomeTabPlaylist,
        handleToggleHomeTabRadio: state.handleToggleHomeTabRadio,
        handleToggleHomeTabAlbums: state.handleToggleHomeTabAlbums,
        handleToggleHomeTabLocal: state.handleToggleHomeTabLocal,
        handleToggleHomeTabDevRecommend: state.handleToggleHomeTabDevRecommend,
        showHomeTabHotChart: state.showHomeTabHotChart,
        showHomeTabGufengChart: state.showHomeTabGufengChart,
        showHomeTabCache: state.showHomeTabCache,
        handleToggleHomeTabHotChart: state.handleToggleHomeTabHotChart,
        handleToggleHomeTabGufengChart: state.handleToggleHomeTabGufengChart,
        handleToggleHomeTabCache: state.handleToggleHomeTabCache,
    })));

    
    const getResolvedLanguageLabel = (): string => {
        const lang = i18n.resolvedLanguage;
        if (lang === 'zh-TW' || lang?.startsWith('zh-TW')) return '繁體中文';
        if (lang?.startsWith('zh')) return '简体中文';
        if (lang === 'in' || lang?.startsWith('id')) return 'Bahasa Indonesia';
        return 'English';
    };

    const currentResolvedLanguage = getResolvedLanguageLabel();

    const languageOptions: Array<{ value: AppLanguagePreference; label: string; }> = [
        { value: 'system', label: t('options.appLanguageSystem') },
        { value: 'zh-CN', label: '简体中文' },
        { value: 'zh-TW', label: '繁體中文' },
        { value: 'en', label: 'English' },
        { value: 'in', label: 'Bahasa Indonesia' },
    ];

    const languageHint = appLanguagePreference === 'system'
        ? (t('options.appLanguageSystemHint')).replace('{{language}}', currentResolvedLanguage)
        : null;

    const toggleOffBackgroundClass = isDaylight ? 'bg-zinc-200' : 'bg-[#2A2D35]';

    return (
        <div className="space-y-5">
            <section>
                <h3 className="text-sm font-bold uppercase tracking-wider opacity-50 mb-4 flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                    <Languages size={14} /> {t('options.languageSettings')}
                </h3>
                <div className={`p-4 rounded-xl border space-y-4 ${settingsCardClass}`}>
                    <div className="space-y-1">
                        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {t('options.appLanguage')}
                        </div>
                        <div className="text-[11px] opacity-50 max-w-[420px]" style={{ color: 'var(--text-secondary)' }}>
                            {t('options.appLanguageDesc')}
                        </div>
                    </div>
                    <CustomSelect
                        value={appLanguagePreference}
                        onChange={(value) => {
                            void onAppLanguagePreferenceChange(value as AppLanguagePreference);
                        }}
                        options={languageOptions}
                        isDaylight={isDaylight}
                        theme={theme}
                    />
                    {languageHint && (
                        <div className="text-[11px] opacity-50" style={{ color: 'var(--text-secondary)' }}>
                            {languageHint}
                        </div>
                    )}
                </div>
            </section>

            <section>
                <h3 className="text-sm font-bold uppercase tracking-wider opacity-50 mb-4 flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                    <LayoutList size={14} /> {t('options.homeTabsVisibility')}
                </h3>
                <div className={`rounded-xl border ${settingsCardClass} overflow-hidden`}>
                    <div className="flex items-center justify-between p-4 border-b border-black/5 dark:border-white/5">
                        <div className="space-y-1">
                            <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                {t('options.showHomeTabPlaylist')}
                            </div>
                        </div>
                        <button
                            onClick={() => handleToggleHomeTabPlaylist(!showHomeTabPlaylist)}
                            className={`w-12 h-6 rounded-full p-1 transition-colors shrink-0 ${!showHomeTabPlaylist ? toggleOffBackgroundClass : ''}`}
                            style={{ backgroundColor: showHomeTabPlaylist ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                        >
                            <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${showHomeTabPlaylist ? 'translate-x-6' : 'translate-x-0'}`} />
                        </button>
                    </div>

                    <div className="flex items-center justify-between p-4 border-b border-black/5 dark:border-white/5">
                        <div className="space-y-1">
                            <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                {t('options.showHomeTabRadio')}
                            </div>
                        </div>
                        <button
                            onClick={() => handleToggleHomeTabRadio(!showHomeTabRadio)}
                            className={`w-12 h-6 rounded-full p-1 transition-colors shrink-0 ${!showHomeTabRadio ? toggleOffBackgroundClass : ''}`}
                            style={{ backgroundColor: showHomeTabRadio ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                        >
                            <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${showHomeTabRadio ? 'translate-x-6' : 'translate-x-0'}`} />
                        </button>
                    </div>

                    <div className="flex items-center justify-between p-4 border-b border-black/5 dark:border-white/5">
                        <div className="space-y-1">
                            <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                显示缓存（只控制选项显隐，不关闭缓存功能）
                            </div>
                        </div>
                        <button
                            onClick={() => handleToggleHomeTabCache(!showHomeTabCache)}
                            className={`w-12 h-6 rounded-full p-1 transition-colors shrink-0 ${!showHomeTabCache ? toggleOffBackgroundClass : ''}`}
                            style={{ backgroundColor: showHomeTabCache ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                        >
                            <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${showHomeTabCache ? 'translate-x-6' : 'translate-x-0'}`} />
                        </button>
                    </div>

                    {([
                        { label: '显示热歌榜', value: showHomeTabHotChart, toggle: handleToggleHomeTabHotChart },
                        { label: '显示古风榜', value: showHomeTabGufengChart, toggle: handleToggleHomeTabGufengChart },
                    ] as const).map(item => (
                        <div key={item.label} className="flex items-center justify-between p-4 border-b border-black/5 dark:border-white/5">
                            <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{item.label}</div>
                            <button onClick={() => item.toggle(!item.value)}
                                className={`w-12 h-6 rounded-full p-1 transition-colors shrink-0 ${!item.value ? toggleOffBackgroundClass : ''}`}
                                style={{ backgroundColor: item.value ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}>
                                <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${item.value ? 'translate-x-6' : 'translate-x-0'}`} />
                            </button>
                        </div>
                    ))}

                    {supportsLocalMusicImport() && (
                        <div className="flex items-center justify-between p-4">
                            <div className="space-y-1">
                                <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                    {t('options.showHomeTabLocal')}
                                </div>
                            </div>
                            <button
                                onClick={() => handleToggleHomeTabLocal(!showHomeTabLocal)}
                                className={`w-12 h-6 rounded-full p-1 transition-colors shrink-0 ${!showHomeTabLocal ? toggleOffBackgroundClass : ''}`}
                                style={{ backgroundColor: showHomeTabLocal ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                            >
                                <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${showHomeTabLocal ? 'translate-x-6' : 'translate-x-0'}`} />
                            </button>
                        </div>
                    )}

                    <div className="flex items-center justify-between p-4">
                        <div className="space-y-1">
                            <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                {t('options.showHomeTabDevRecommend', '显示开发者推荐')}
                            </div>
                        </div>
                        <button
                            onClick={() => handleToggleHomeTabDevRecommend(!showHomeTabDevRecommend)}
                            className={`w-12 h-6 rounded-full p-1 transition-colors shrink-0 ${!showHomeTabDevRecommend ? toggleOffBackgroundClass : ''}`}
                            style={{ backgroundColor: showHomeTabDevRecommend ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                        >
                            <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${showHomeTabDevRecommend ? 'translate-x-6' : 'translate-x-0'}`} />
                        </button>
                    </div>
                </div>
            </section>

            <section>
                <h3 className="text-sm font-bold uppercase tracking-wider opacity-50 mb-4 flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                    <RefreshCw size={14} /> {t('options.checkUpdate', '检查更新')}
                </h3>
                <div className={`p-4 rounded-xl border space-y-3 ${settingsCardClass}`}>
                    <div className="flex items-center justify-between gap-4">
                        <div className="space-y-1">
                            <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('options.checkUpdateNow', '检查是否有新版本')}</div>
                            <div className="text-[11px] opacity-50 max-w-[420px]" style={{ color: 'var(--text-secondary)' }}>
                                {t('options.checkUpdateDesc', '有可用更新会弹出更新窗口；已是最新则提示已是最新版本。')}
                            </div>
                        </div>
                        <button
                            type="button"
                            disabled={checking}
                            onClick={onCheckUpdate}
                            className="shrink-0 rounded-full px-4 py-2 text-xs font-semibold transition-colors border disabled:opacity-50"
                            style={{ borderColor: 'var(--accent-color, currentColor)', color: 'var(--accent-color, currentColor)' }}
                        >
                            {checking ? t('options.checking', '检查中…') : t('options.checkUpdate', '检查更新')}
                        </button>
                    </div>
                </div>
            </section>

            {IS_BETA && (
                <section>
                    <h3 className="text-sm font-bold uppercase tracking-wider opacity-50 mb-4 flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                        <RefreshCw size={14} /> 发布新版本
                    </h3>
                    <div className={`p-4 rounded-xl border space-y-3 ${settingsCardClass}`}>
                        <div className="flex items-center justify-between gap-4">
                            <div className="space-y-1">
                                <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>推送到正式版</div>
                                <div className="text-[11px] opacity-50 max-w-[420px]" style={{ color: 'var(--text-secondary)' }}>
                                    测试全部通过后点击，将当前测试版本发布到正式客户端，正式版随即收到更新弹窗。
                                </div>
                            </div>
                            <button
                                type="button"
                                disabled={publishing}
                                onClick={onPublishBeta}
                                className="shrink-0 rounded-full px-4 py-2 text-xs font-semibold text-white transition-opacity disabled:opacity-50"
                                style={{ background: 'rgba(34,197,94,.85)' }}
                            >
                                {publishing ? '发布中…' : '发布新版本'}
                            </button>
                        </div>
                        {publishMsg && (
                            <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{publishMsg}</div>
                        )}
                    </div>
                </section>
            )}

            <FrameRateSection settingsCardClass={settingsCardClass} isDaylight={isDaylight} />

            <PinnedCommandSettings
                isDaylight={isDaylight}
                settingsCardClass={settingsCardClass}
                theme={theme}
            />
        </div>
    );
};

export default GeneralSettingsSubview;

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|67fdebd67e89|b2ba2be01764");}catch(_e){}
