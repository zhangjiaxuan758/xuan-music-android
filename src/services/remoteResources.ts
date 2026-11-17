// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================

import { secureGet, secureSet } from './secureCache';

export interface RemoteResourcesPayload {
  ok?: boolean;
  status?: number;
  version?: number;
  platform?: string;
  policyVc?: number;
  resources?: Record<string, unknown>;
  notModified?: boolean;
}

const CACHE_KEY = 'xuan_remote_resources_v1';

interface CacheShape {
  version: number;
  resources: Record<string, unknown>;
}

let cache: CacheShape = { version: 0, resources: {} };

try {
  const raw = secureGet(CACHE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as Partial<CacheShape>;
    if (parsed && typeof parsed === 'object') {
      cache = {
        version: Number(parsed.version) || 0,
        resources: parsed.resources && typeof parsed.resources === 'object' ? parsed.resources : {},
      };
    }
  }
} catch {  }

const listeners = new Set<() => void>();

function persist(): void {
  try { secureSet(CACHE_KEY, JSON.stringify(cache)); } catch {  }
}

export function applyRemoteResources(r: RemoteResourcesPayload | null): boolean {
  if (!r || !r.ok || typeof r.version !== 'number') return false;
  if (r.notModified) {
    cache.version = r.version;
    persist();
    return true;
  }
  const res = r.resources;
  if (!res || typeof res !== 'object') return false;

  const unchanged = cache.version === r.version
    && JSON.stringify(cache.resources) === JSON.stringify(res);
  cache.resources = res;
  cache.version = r.version;
  persist();
  if (!unchanged) {
    listeners.forEach(fn => { try { fn(); } catch {  } });
    try { window.dispatchEvent(new CustomEvent('xuan:remote-resources', { detail: cache })); } catch {  }
  }
  return true;
}

export function getRemoteResource<T = unknown>(name: string): T | null {
  const v = cache.resources[name];
  return v === undefined || v === null ? null : (v as T);
}

export function onRemoteResources(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const remoteResourcesVersion = (): number => cache.version;

export function ud(key: string, fallback: string): string {
  const d = getRemoteResource<Record<string, unknown>>('updateDialog');
  const v = d ? d[key] : undefined;
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

export interface UpdateDialogTheme {
  cardBg: string; cardFg: string;
  primaryBg: string; primaryFg: string;
  secondaryBg: string; secondaryFg: string;
  overlay: string; hintColor: string; verColor: string; descColor: string;
}

const DEFAULT_THEME: UpdateDialogTheme = {
  cardBg: '#232326', cardFg: '#f2f2f3',
  primaryBg: '#f2f2f3', primaryFg: '#1c1c1e',
  secondaryBg: 'rgba(255,255,255,.10)', secondaryFg: '#e8e8ea',
  overlay: 'rgba(0,0,0,.62)', hintColor: '#f0b45a',
  verColor: '#a1a1a6', descColor: '#d0d0d4',
};

export function udTheme(): UpdateDialogTheme {
  const d = getRemoteResource<Record<string, unknown>>('updateDialog');
  const t = d ? d['theme'] : undefined;
  const out: UpdateDialogTheme = { ...DEFAULT_THEME };
  if (!t || typeof t !== 'object') return out;
  const rec = t as Record<string, unknown>;
  (Object.keys(DEFAULT_THEME) as (keyof UpdateDialogTheme)[]).forEach(k => {
    const v = rec[k];
    if (typeof v === 'string' && v) out[k] = v;
  });
  return out;
}

export function udVer(name: string, code: number | string): string {
  return ud('verTpl', '新版本 {name}（{code}）')
    .replace('{name}', name).replace('{code}', String(code));
}

export function pageResource<T = Record<string, unknown>>(name: string): T | null {
  return getRemoteResource<T>('page.' + name);
}

export interface RemoteGate {
  allowed: boolean; closed: boolean; hidden: boolean; offText: string;
}

export function remoteFeatureGates(): Record<string, RemoteGate> | null {
  const g = getRemoteResource<Record<string, RemoteGate>>('featureGates');
  return g && typeof g === 'object' ? g : null;
}

export interface RemoteHelpSection { title: string; body: string; icon?: string }

const DEFAULT_HELP_SECTIONS: RemoteHelpSection[] = [
  { icon: 'music', title: '登录', body: '打开应用后在首页点「登录网易云账号」，用网易云 App 扫码即可。扫码后如提示环境异常，请确认网络正常后重试；登录态只保存在你自己的手机里。' },
  { icon: 'search', title: '搜索与播放', body: '搜索结果只来自网易云官方。点歌曲封面或整行空白处即可播放；点歌手名查看歌曲信息。搜索框内容在切换页面后仍会保留。' },
  { icon: 'heart', title: '点赞 / 收藏 / 歌单', body: '点赞、收藏、添加到歌单等操作需要先登录网易云账号；未登录时会提示你先登录。搜索和听歌不受登录限制。' },
  { icon: 'sliders', title: '音效与音质', body: '设置里可开启音效并选择 7 种固定预设，无需自定义调节；关闭音效时音频完全直通、不经过任何处理。音质默认使用官方最高档，官方按账号权限自动降级。' },
  { icon: 'link', title: '在线帮助文档', body: '完整版《遇到问题？》文档托管在小轩音乐官方站点，包含登录、播放、音效音质、更新等全部排查步骤。' },
  { icon: 'offline', title: '离线与缓存', body: '默认开启音乐缓存。无网络时会提示「无网络连接」；已缓存的会员歌曲仍按网易云官方口径提示试听或不可播放。设置里可清理缓存。' },
  { icon: 'book', title: '会员歌曲提示', body: '会员专享、付费数字专辑、无版权、地区限制等歌曲，均按网易云官方口径提示，不会误显示「已下架」。已登录且账号有会员时可播放完整版。' },
];

export function helpSections(): RemoteHelpSection[] {
  const v = getRemoteResource<{ sections?: RemoteHelpSection[]; footer?: string }>('helpDoc');
  if (v && Array.isArray(v.sections) && v.sections.length) {
    const list = v.sections.filter(s => s && typeof s.title === 'string' && typeof s.body === 'string');
    if (list.length) return list;
  }
  return DEFAULT_HELP_SECTIONS;
}

export function helpDocFooter(): string {
  const v = getRemoteResource<Record<string, unknown>>('helpDoc');
  return typeof v?.footer === 'string' && v.footer ? v.footer : '';
}

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|722088beb581|0d9af142c2ae");}catch(_e){}
