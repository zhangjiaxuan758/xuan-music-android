// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import { NeteaseUser, NeteasePlaylist, NoCopyrightRecommendation, SongPrivilege, SongResult } from "../types";
import { readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue } from './onlineMusic/providerStorage';
import QRCode from 'qrcode';
import { CapacitorHttp } from '@capacitor/core';

type UnavailableSongReplacement = {
  replacementSong: SongResult;
  replacementSongId: number;
  typeDesc?: string;
};

let songCopyrightRecommendationApiSupported: boolean | null = null;

// 小轩音乐直连网易云官方服务器（music.163.com），不经任何第三方公共实例。
// 采用网易云官方客户端同款 eapi 协议：AES-128-ECB 加密请求体，服务端解密后
// 转发到对应 /api 业务接口。二维码由官方域名生成、播放链接由官方直返，
// 因此不存在第三方实例机房 IP 被风控的问题。
const OFFICIAL_HOST = 'https://music.163.com';
// 敏感信息（eapiKey / eapiSalt / 开放平台密钥）全部保存在服务端 __XUAN_SERVER_HOST__，
// 客户端不再持有任何密钥：所有官方请求由服务端加密转发。
import { eapiRequest } from './xuanServer';
import { EP } from './secretBox';

const DEVICE_COOKIE = 'os=android; osver=13; appver=8.10.30; versioncode=270; channel=netease; deviceId=xuanmusic-android; resolution=1920x1080;';
const DEVICE_HEADER: Record<string, string> = {
  os: 'android',
  osver: '13',
  appver: '8.10.30',
  versioncode: '270',
  channel: 'netease',
  deviceId: 'xuanmusic-android',
  resolution: '1920x1080',
  mobilename: '',
};
// 桌面版由 Electron preload 注入 __xuanDesktop=true；安卓端没有该标记。
const isDesktopRuntime = (): boolean =>
  typeof window !== 'undefined' && (window as unknown as { __xuanDesktop?: boolean }).__xuanDesktop === true;
const qrLoginType = (): number => (isDesktopRuntime() ? 3 : 1);

const LOGIN_COOKIE_KEYS = ['MUSIC_U', 'MUSIC_A', 'MUSIC_R_T', 'MUSIC_R_TT', 'MUSIC_A_T', 'MUSIC_A_REFRESH', '__csrf', 'NMTID', 'MUSIC_A_SK'];

const readLoginCookie = (): string =>
  readProviderSessionValue('netease', 'cookie', ['netease_cookie']) || '';

const getCookieValue = (cookie: string, name: string): string => {
  if (!cookie) return '';
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return '';
};

// 从 CapacitorHttp 原生响应头里解析 Set-Cookie，拼成可用于后续请求的 cookie 串。
// Android 原生层可能把多个 Set-Cookie 合并成一个字符串（逗号或换行分隔）。
const parseSetCookie = (headers: Record<string, string> | undefined): string => {
  if (!headers) return '';
  let raw = '';
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'set-cookie') {
      const value = headers[key];
      if (typeof value === 'string') raw += (raw ? '\n' : '') + value;
    }
  }
  if (!raw) return '';
  const segments = raw.split(/[\n,] *(?=[A-Za-z_][A-Za-z0-9_-]*=)/);
  const pairs: string[] = [];
  const ignored = new Set(['expires', 'path', 'domain', 'max-age', 'samesite', 'secure', 'httponly', 'priority']);
  for (const segment of segments) {
    const first = segment.split(';')[0].trim();
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!value || ignored.has(name.toLowerCase())) continue;
    if (!pairs.some(p => p.startsWith(name + '='))) pairs.push(`${name}=${value}`);
  }
  return pairs.join('; ');
};

const mergeCookie = (existing: string, incoming: string): string => {
  const map = new Map<string, string>();
  for (const source of [existing, incoming]) {
    if (!source) continue;
    for (const part of source.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (name && value) map.set(name, value);
    }
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
};

// eapi 加密已迁移至服务端：客户端不持有任何 eAPI 密钥。
// 这样源码可完全脱敏，网页端无跨域问题，管理端可实时轮换密钥而客户端无需升级。
type EapiResult = { body: any; setCookie: string };

// 统一走 CapacitorHttp 原生 HTTP 层：绕过 WebView 跨域、可显式携带 Cookie、
// 并能读到原生返回的 Set-Cookie（登录态持久化所需）。
const officialRequest = async (apiPath: string, requestData: Record<string, unknown>): Promise<EapiResult> => {
  // 官方对同 IP 高频请求会返回 -462 等瞬态错误，静默重试。
  const isTransientCode = (code: unknown): boolean => {
    const value = Number(code);
    return value === -462 || value === -460 || value === -1
      || value === 400 || value === 502 || value === 503 || value === 504;
  };
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  // 所有官方 eapi 请求统一走服务端代理：
  //   - 客户端不接触 eapiKey / eapiSalt，源码可完全脱敏；
  //   - 网页端同源调用，无跨域问题；
  //   - 管理端可实时更换服务端密钥，客户端无需升级。
  const cookie = readLoginCookie();
  let result = await eapiRequest(apiPath, requestData, cookie);
  for (let attempt = 0; attempt < 2 && isTransientCode(result.body?.code); attempt++) {
    await wait(700 * (attempt + 1));
    result = await eapiRequest(apiPath, requestData, cookie);
  }
  return { body: result.body, setCookie: result.setCookie };
};
const isElectronRuntime = () => false;

type Query = URLSearchParams;
type EndpointSpec = {
  path: string | ((q: Query) => string);
  data?: (q: Query) => Record<string, unknown>;
  local?: (q: Query) => Promise<any>;
  wrap?: (body: any, q: Query, setCookie: string) => any;
};

const num = (q: Query, key: string, fallback: number): number => {
  const raw = q.get(key);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
const str = (q: Query, key: string, fallback = ''): string => q.get(key) ?? fallback;
const idsAsJson = (raw: string): string =>
  '[' + raw.split(',').map(id => Number(id.trim())).filter(Number.isFinite).join(',') + ']';
const detailIdsAsJson = (raw: string): string =>
  '[' + raw.split(',').map(id => Number(id.trim())).filter(Number.isFinite).map(id => `{"id":${id}}`).join(',') + ']';

// REST endpoint（NeteaseCloudMusicApi 风格）→ 官方 /api 路径 + data 构造。
// 官方响应大多与上层期望同构，直接透传；少数登录接口需包装。
const ENDPOINT_MAP: Record<string, EndpointSpec> = {
  '/login/qr/key': {
    path: EP[4],
    // 官方 /login/qrcode/unikey 设备档位：type=1 网页版、type=3 PC 桌面客户端。
    // type=2 是第三方/穿戴设备档，缺 deviceId/appName 会让确认页显示「登录null」。
    // 桌面版（preload 注入 __xuanDesktop）走 3，网易云 App 确认页显示「登录PC端」。
    data: () => ({ type: qrLoginType() }),
    wrap: (body) => ({ code: 200, data: { unikey: String(body?.unikey || '') } }),
  },
  '/login/qr/create': {
    path: '',
    local: async (q) => {
      const key = str(q, 'key');
      const url = `${OFFICIAL_HOST}/login?codekey=${encodeURIComponent(key)}`;
      const qrimg = await QRCode.toDataURL(url, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
      return { code: 200, data: { qrurl: url, qrimg } };
    },
  },
  '/login/qr/check': {
    path: EP[5],
    data: (q) => ({ key: str(q, 'key'), type: qrLoginType() }),
    wrap: (body, _q, setCookie) => {
      const result: any = { ...body };
      if (setCookie) result.cookie = mergeCookie(readLoginCookie(), setCookie);
      return result;
    },
  },
  '/login/status': {
    path: EP[6],
    data: () => ({}),
    wrap: (body, _q, setCookie) => ({
      code: Number(body?.code ?? 200),
      data: { ...body },
      ...(setCookie ? { cookie: mergeCookie(readLoginCookie(), setCookie) } : {}),
    }),
  },
  '/user/account': { path: EP[7], data: () => ({}) },
  '/logout': {
    path: EP[8],
    data: () => ({}),
    wrap: (body) => { removeProviderSessionValue('netease', 'cookie', ['netease_cookie']); return body; },
  },
  '/like': {
    path: EP[9],
    data: (q) => ({ alg: 'itembased', trackId: str(q, 'id'), like: str(q, 'like') === 'true' || str(q, 'like') === '1', time: 3 }),
  },
  '/likelist': { path: EP[10], data: (q) => ({ uid: num(q, 'uid', 0) }) },
  '/playlist/tracks/add': {
    path: EP[11],
    data: (q) => ({ pid: str(q, 'pid'), ids: idsAsJson(str(q, 'ids', '[]')), op: 'add' }),
  },
  '/user/playlist': {
    path: EP[12],
    data: (q) => ({ uid: num(q, 'uid', 0), limit: num(q, 'limit', 30), offset: num(q, 'offset', 0), includeVideo: true }),
  },
  '/playlist/detail': {
    path: EP[13],
    data: (q) => ({ id: num(q, 'id', 0), n: 100000, s: 8 }),
  },
  '/playlist/track/all': {
    path: EP[13],
    data: (q) => ({ id: num(q, 'id', 0), n: 100000, s: 8 }),
    wrap: async (body, q) => {
      const trackIds: number[] = body?.playlist?.trackIds?.map((t: any) => Number(t?.id ?? t)) || [];
      const limit = num(q, 'limit', 0);
      const offset = num(q, 'offset', 0);
      const sliced = limit > 0 ? trackIds.slice(offset, offset + limit) : trackIds;
      if (sliced.length) {
        try {
          const detail = await officialRequest(EP[14], { c: '[' + sliced.map(id => `{"id":${id}}`).join(',') + ']' });
          return {
            code: 200,
            songs: detail.body?.songs || [],
            privileges: detail.body?.privileges || body?.privileges || [],
          };
        } catch { /* 落到下面的兜底 */ }
      }
      return { code: 200, songs: body?.playlist?.tracks || [], privileges: body?.privileges || [] };
    },
  },
  '/playlist/tracks': {
    path: EP[15],
    data: (q) => ({ op: str(q, 'op'), pid: num(q, 'pid', 0), trackIds: idsAsJson(str(q, 'tracks')), imme: true }),
  },
  '/album': { path: (q) => `${EP[40]}${num(q, 'id', 0)}`, data: () => ({}) },
  '/song/detail': {
    path: EP[14],
    data: (q) => ({ c: detailIdsAsJson(str(q, 'ids')) }),
  },
  '/album/sublist': {
    path: EP[16],
    data: (q) => ({ limit: num(q, 'limit', 25), offset: num(q, 'offset', 0), total: true }),
  },
  '/artist/detail': { path: EP[17], data: (q) => ({ id: num(q, 'id', 0) }) },
  '/artist/album': {
    path: (q) => `${EP[41]}${num(q, 'id', 0)}`,
    data: (q) => ({ limit: num(q, 'limit', 30), offset: num(q, 'offset', 0), total: true }),
  },
  '/artist/top/song': { path: EP[18], data: (q) => ({ id: num(q, 'id', 0) }) },
  '/artist/songs': {
    path: EP[19],
    data: (q) => ({ id: num(q, 'id', 0), order: str(q, 'order', 'hot'), offset: num(q, 'offset', 0), limit: num(q, 'limit', 50), private_cloud: 'true', work_type: 1 }),
  },
  '/song/url/v1': {
    path: EP[20],
    data: (q) => ({ ids: idsAsJson(str(q, 'id')), level: str(q, 'level', 'exhigh'), encodeType: 'flac' }),
  },
  '/lyric/new': {
    path: EP[21],
    data: (q) => ({ id: num(q, 'id', 0), cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 }),
  },
  '/song/chorus': { path: EP[22], data: (q) => ({ id: num(q, 'id', 0) }) },
  '/cloud/lyric/get': { path: EP[23], data: (q) => ({ uid: num(q, 'uid', 0), sid: num(q, 'sid', 0) }) },
  '/user/cloud': {
    path: EP[24],
    data: (q) => ({ limit: num(q, 'limit', 200), offset: num(q, 'offset', 0) }),
  },
  '/user/cloud/detail': {
    path: EP[25],
    data: (q) => ({ songIds: idsAsJson(str(q, 'id')) }),
  },
  '/cloudsearch': {
    path: EP[26],
    data: (q) => ({ s: str(q, 'keywords'), type: 1, limit: num(q, 'limit', 30), offset: num(q, 'offset', 0), total: true }),
  },
  '/personal_fm': { path: EP[27], data: () => ({}) },
  '/recommend/songs': { path: EP[28], data: () => ({}) },
  '/recommend/songs/dislike': {
    path: EP[29],
    data: (q) => ({ resId: num(q, 'id', 0), resType: 4, sceneType: 0 }),
  },
  '/history/recommend/songs': { path: EP[30], data: () => ({}) },
  '/history/recommend/songs/detail': {
    path: EP[31],
    data: (q) => ({ date: str(q, 'date') }),
  },
  '/personalized': {
    path: EP[32],
    data: (q) => ({ limit: num(q, 'limit', 35), total: true, n: 1000 }),
  },
  '/fm_trash': {
    path: EP[33],
    data: (q) => ({ songId: num(q, 'id', 0), alg: 'RT', time: 3 }),
  },
  '/playlist/subscribe': {
    path: (q) => str(q, 't') === '1' ? EP[34] : EP[35],
    data: (q) => ({ id: num(q, 'id', 0) }),
  },
  '/album/sub': {
    path: (q) => str(q, 't') === '1' ? EP[36] : EP[37],
    data: (q) => ({ id: num(q, 'id', 0) }),
  },
  '/playlist/detail/dynamic': {
    path: EP[38],
    data: (q) => ({ id: num(q, 'id', 0), n: 100000, s: 8 }),
  },
  '/album/detail/dynamic': { path: EP[39], data: (q) => ({ id: num(q, 'id', 0) }) },
  // 官方无对应简单接口：显式返回不支持，让上层替换逻辑走详情兜底，不误标「已下架」。
  '/song/copyright/rcmd': { path: '', local: async () => ({ code: 404, message: 'unsupported' }) },
  // 旧逻辑用于公共实例注册匿名 cookie，官方直连不需要。
  '/register/anonimous': { path: '', local: async () => ({ code: 200, cookie: '' }) },
};

const fetchWithCreds = async (endpoint: string, _options: RequestInit = {}): Promise<any> => {
  const qIndex = endpoint.indexOf('?');
  const pathname = qIndex < 0 ? endpoint : endpoint.slice(0, qIndex);
  const query = new URLSearchParams(qIndex < 0 ? '' : endpoint.slice(qIndex + 1));
  const spec = ENDPOINT_MAP[pathname];

  if (!spec) {
    console.warn('[Netease] 未映射的 endpoint，返回空结果', pathname);
    return { code: 200 };
  }

  if (spec.local) return spec.local(query);

  const apiPath = typeof spec.path === 'function' ? spec.path(query) : spec.path;
  const requestData = spec.data ? spec.data(query) : {};
  const { body, setCookie } = await officialRequest(apiPath, requestData);

  // 扫码确认（803）时把官方下发的登录 Cookie 落盘，供后续请求注入 MUSIC_U。
  if (pathname === '/login/qr/check' && Number(body?.code) === 803 && setCookie) {
    writeProviderSessionValue('netease', 'cookie', mergeCookie(readLoginCookie(), setCookie));
  }

  if (spec.wrap) return spec.wrap(body, query, setCookie);
  return body;
};

const toHttps = (url?: unknown) => {
  if (typeof url !== 'string' || !url) return '';
  return url.replace(/^http:/, 'https:');
};

const normalizeArtistName = (value: any): string => {
  if (typeof value === 'string') return value;
  if (value && typeof value.name === 'string') return value.name;
  return '';
};

const normalizeArtists = (source: any): { id: number; name: string }[] => {
  if (!source) return [];
  if (Array.isArray(source)) {
    return source
      .map((artist: any, index: number) => ({
        id: Number(artist?.id ?? index),
        name: normalizeArtistName(artist),
      }))
      .filter((artist) => artist.name);
  }

  if (typeof source === 'string') {
    return source
      .split(/[\/,]/)
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name, index) => ({ id: index, name }));
  }

  return [];
};

const getCloudCoverFallback = (raw: any) =>
  raw?.simpleSong?.al?.picUrl ||
  raw?.simpleSong?.album?.coverUrl ||
  raw?.simpleSong?.album?.picUrl ||
  raw?.al?.picUrl ||
  raw?.album?.coverUrl ||
  raw?.album?.picUrl ||
  raw?.cover;

const normalizeSongPrivilege = (raw: any): SongPrivilege | undefined => {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  return {
    id: typeof raw.id === 'number' ? raw.id : undefined,
    fee: typeof raw.fee === 'number' ? raw.fee : undefined,
    payed: typeof raw.payed === 'number' ? raw.payed : undefined,
    st: typeof raw.st === 'number' ? raw.st : undefined,
    pl: typeof raw.pl === 'number' ? raw.pl : undefined,
    dl: typeof raw.dl === 'number' ? raw.dl : undefined,
    flag: typeof raw.flag === 'number' ? raw.flag : undefined,
    cs: typeof raw.cs === 'boolean' ? raw.cs : undefined,
  };
};

const normalizeNoCopyrightRecommendation = (raw: any): NoCopyrightRecommendation | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  return {
    type: typeof raw.type === 'number' ? raw.type : undefined,
    typeDesc: typeof raw.typeDesc === 'string' ? raw.typeDesc : undefined,
    songId: typeof raw.songId === 'string' || typeof raw.songId === 'number' ? raw.songId : undefined,
    thirdPartySong: raw.thirdPartySong ?? null,
    expInfo: raw.expInfo ?? null,
  };
};

const applyPrivilegeToSong = (song: SongResult, privilege?: SongPrivilege): SongResult => {
  if (!privilege) {
    return song;
  }

  return {
    ...song,
    privilege,
  };
};

const mergeSongsWithPrivileges = (songs: any, privileges: any): SongResult[] => {
  const normalizedSongs = Array.isArray(songs)
    ? songs.map((song: any) => normalizeSongResult(song))
    : [];

  if (!Array.isArray(privileges) || privileges.length === 0 || normalizedSongs.length === 0) {
    return normalizedSongs;
  }

  const normalizedPrivileges = privileges.map((privilege: any) => normalizeSongPrivilege(privilege));
  const privilegeById = new Map<number, SongPrivilege>();

  normalizedPrivileges.forEach((privilege) => {
    if (typeof privilege?.id === 'number') {
      privilegeById.set(privilege.id, privilege);
    }
  });

  return normalizedSongs.map((song, index) => {
    const alignedPrivilege = normalizedPrivileges[index];
    const privilege = alignedPrivilege?.id === song.id
      ? alignedPrivilege
      : privilegeById.get(Number(song.id)) ?? alignedPrivilege;

    if (!privilege) {
      return song;
    }

    return {
      ...song,
      privilege,
    };
  });
};

const normalizeSongResult = (raw: any): SongResult => {
  const base = raw?.simpleSong || raw;
  const tValue = Number(base?.t ?? raw?.t ?? 0) as 0 | 1 | 2;
  const sourceType: SongResult['sourceType'] = tValue === 1 || tValue === 2 ? 'cloud' : 'netease';

  const artists = normalizeArtists(
    base?.ar ||
    base?.artists
  );

  const albumName =
    base?.al?.name ||
    base?.album?.name ||
    'Unknown Album';

  const albumId = Number(
    base?.al?.id ??
    base?.album?.id ??
    raw?.al?.id ??
    raw?.album?.id ??
    0
  );

  const picUrl = toHttps(getCloudCoverFallback(raw));
  const duration = Number(
    base?.durationMs ??
    base?.dt ??
    base?.duration ??
    raw?.duration ??
    raw?.songLength ??
    0
  );

  return {
    id: Number(base?.id ?? raw?.id ?? 0),
    name: base?.name || raw?.songName || raw?.fileName || 'Unknown Song',
    artists,
    album: {
      id: albumId,
      name: albumName,
      coverUrl: picUrl || undefined,
    },
    durationMs: duration,
    aliases: Array.isArray(base?.alia) ? base.alia : [],
    translatedNames: Array.isArray(base?.tns) ? base.tns : [],
    t: tValue,
    sourceType,
    sourceRef: {
      kind: 'online',
      providerId: 'netease',
      mediaId: String(Number(base?.id ?? raw?.id ?? 0)),
      ...(sourceType === 'cloud' ? { variant: 'cloud' } : {}),
    },
    fee: typeof (base?.fee ?? raw?.fee) === 'number' ? Number(base?.fee ?? raw?.fee) : undefined,
    noCopyrightRcmd: normalizeNoCopyrightRecommendation(base?.noCopyrightRcmd ?? raw?.noCopyrightRcmd),
    resourceState: typeof (base?.resourceState ?? raw?.resourceState) === 'boolean'
      ? Boolean(base?.resourceState ?? raw?.resourceState)
      : undefined,
    privilege: normalizeSongPrivilege(base?.privilege ?? raw?.privilege),
  };
};

export const isSongMarkedUnavailable = (
  song?: { privilege?: unknown; resourceState?: unknown } | null
): boolean => {
  if (!song) {
    return false;
  }

  // 公共实例在未登录时会给绝大多数歌曲返回 privilege.st < 0（版权 / 试听限制），
  // 这并不等于「已下架」。旧逻辑据此把整页搜索结果打上「已下架」并禁用播放按钮，
  // 只有官方明确标记资源失效（resourceState === false）才认定为不可用。
  return song.resourceState === false;
};

export const getSongUnavailableTagText = (
  song: Pick<SongResult, 'privilege' | 'noCopyrightRcmd'> | null | undefined,
  fallbackLabel: string
): string => {
  if (!isSongMarkedUnavailable(song)) {
    return fallbackLabel;
  }

  const typeDesc = song?.noCopyrightRcmd?.typeDesc;
  return typeof typeDesc === 'string' && typeDesc.trim()
    ? typeDesc.trim()
    : fallbackLabel;
};

export const getSongAlternativeVersionId = (
  song?: Pick<SongResult, 'privilege' | 'noCopyrightRcmd'> | null
): number | null => {
  if (!song || !isSongMarkedUnavailable(song)) {
    return null;
  }

  const candidate = song.noCopyrightRcmd?.songId;
  if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
    return candidate;
  }

  if (typeof candidate === 'string' && candidate.trim()) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
};

const getReplacementSongFromDetailResponse = (
  response: any,
  replacementSongId: number
): SongResult | null => {
  const replacementSong = response?.songs?.find((candidate: SongResult) => candidate.id === replacementSongId)
    || response?.songs?.[0];

  if (!replacementSong || isSongMarkedUnavailable(replacementSong)) {
    return null;
  }

  return replacementSong;
};

const normalizeUnavailableSongReplacement = (response: any): UnavailableSongReplacement | null => {
  if (response?.code !== 200) {
    return null;
  }

  const rawReplacementSong = response?.data?.rcmd;
  if (!rawReplacementSong || typeof rawReplacementSong !== 'object') {
    return null;
  }

  const replacementSong = applyPrivilegeToSong(
    normalizeSongResult(rawReplacementSong),
    normalizeSongPrivilege(response?.data?.sp)
  );

  if (!replacementSong.id || isSongMarkedUnavailable(replacementSong)) {
    return null;
  }

  const typeDesc = typeof response?.data?.originSong?.noCopyrightRcmd?.typeDesc === 'string'
    ? response.data.originSong.noCopyrightRcmd.typeDesc
    : undefined;

  return {
    replacementSong,
    replacementSongId: Number(replacementSong.id),
    typeDesc,
  };
};

const getSongDetail = async (ids: number[] | number) => {
  const idParam = Array.isArray(ids) ? ids.join(',') : String(ids);
  const res = await fetchWithCreds(`/song/detail?ids=${idParam}`);
  res.songs = mergeSongsWithPrivileges(res.songs, res.privileges);
  return res;
};

const getSongCopyrightRecommendation = async (songId: number) => {
  const result = await fetchWithCreds(`/song/copyright/rcmd?songid=${songId}`);
  return normalizeUnavailableSongReplacement(result);
};

// Resolves an alternate playable song while keeping legacy APIs as the primary path.
const getUnavailableSongReplacement = async (
  song?: Pick<SongResult, 'id' | 'privilege' | 'noCopyrightRcmd'> | null
): Promise<UnavailableSongReplacement | null> => {
  if (!song || !isSongMarkedUnavailable(song)) {
    return null;
  }

  const fallbackTypeDesc = typeof song.noCopyrightRcmd?.typeDesc === 'string'
    ? song.noCopyrightRcmd.typeDesc
    : undefined;
  const replacementSongId = getSongAlternativeVersionId(song);
  let detailError: unknown = null;

  if (replacementSongId) {
    try {
      const detailResponse = await getSongDetail(replacementSongId);
      const replacementSong = getReplacementSongFromDetailResponse(detailResponse, replacementSongId);
      if (replacementSong) {
        return {
          replacementSong,
          replacementSongId,
          typeDesc: fallbackTypeDesc,
        };
      }
    } catch (error) {
      detailError = error;
    }
  }

  if (songCopyrightRecommendationApiSupported === false) {
    if (detailError) {
      throw detailError;
    }
    return null;
  }

  try {
    const replacement = await getSongCopyrightRecommendation(Number(song.id));
    if (replacement) {
      songCopyrightRecommendationApiSupported = true;
      return {
        ...replacement,
        typeDesc: replacement.typeDesc || fallbackTypeDesc,
      };
    }

    if (!isElectronRuntime()) {
      songCopyrightRecommendationApiSupported = false;
    }
  } catch {
    if (!isElectronRuntime()) {
      songCopyrightRecommendationApiSupported = false;
    }
  }

  if (detailError) {
    throw detailError;
  }

  return null;
};

export const isCloudSong = (song?: Pick<SongResult, 't'> | null): boolean =>
  Boolean(song && (song.t === 1 || song.t === 2));

export const getOnlineSongCacheKey = (
  kind: 'audio' | 'lyric' | 'cover',
  song: Pick<SongResult, 'id' | 't'>
) => {
  if (isCloudSong(song)) {
    return `${kind}_cloud_${song.id}`;
  }
  return `${kind}_${song.id}`;
};

const getProcessedLyricPayload = (response: any) => {
  if (!response) return { type: 'netease' as const };
  if (response.lrc || response.yrc || response.tlyric || response.ytlrc || response.romalrc || response.yromalrc) {
    return { type: 'netease' as const, ...response };
  }
  if (response.data && (response.data.lrc || response.data.yrc || response.data.tlyric || response.data.ytlrc || response.data.romalrc || response.data.yromalrc)) {
    return { type: 'netease' as const, ...response.data };
  }

  const lyricText = response.lyric || response.data?.lyric || response.data?.lrc || response.data?.lyrics;
  if (typeof lyricText === 'string') {
    return {
      type: 'netease' as const,
      lrc: { lyric: lyricText },
    };
  }

  return { type: 'netease' as const, ...response };
};

export const neteaseApi = {
  // --- Login ---
  logout: async () => {
    return fetchWithCreds(`/logout`);
  },

  getQrKey: async () => {
    return fetchWithCreds(`/login/qr/key`);
  },

  createQr: async (key: string) => {
    return fetchWithCreds(`/login/qr/create?key=${key}&qrimg=true`);
  },

  checkQr: async (key: string) => {
    return fetchWithCreds(`/login/qr/check?key=${key}`);
  },

  getLoginStatus: async () => {
    const res = await fetchWithCreds(`/login/status`);
    if (res.data?.profile) {
      res.data.profile.avatarUrl = toHttps(res.data.profile.avatarUrl);
      res.data.profile.backgroundUrl = toHttps(res.data.profile.backgroundUrl);
    }
    return res;
  },

  getUserAccount: async () => {
    const res = await fetchWithCreds(`/user/account`);
    if (res.profile) {
      res.profile.avatarUrl = toHttps(res.profile.avatarUrl);
      res.profile.backgroundUrl = toHttps(res.profile.backgroundUrl);
    }
    return res;
  },

  // --- User Data ---
  likeSong: async (id: number, like = true) => {
    return fetchWithCreds(`/like?id=${id}&like=${like}`);
  },

  getLikedSongs: async (uid: number) => {
    return fetchWithCreds(`/likelist?uid=${uid}`);
  },

  getUserPlaylists: async (uid: number, limit = 50, offset = 0) => {
    const res = await fetchWithCreds(`/user/playlist?uid=${uid}&limit=${limit}&offset=${offset}`);
    if (res.playlist) {
      res.playlist.forEach((p: any) => {
        p.coverImgUrl = toHttps(p.coverImgUrl);
        if (p.creator) p.creator.avatarUrl = toHttps(p.creator.avatarUrl);
      });
    }
    return res;
  },

  // --- Playlist Data ---
  getPlaylistTracks: async (id: number, limit = 50, offset = 0) => {
    const res = await fetchWithCreds(`/playlist/track/all?id=${id}&limit=${limit}&offset=${offset}`);
    res.songs = mergeSongsWithPrivileges(res.songs, res.privileges);
    return res;
  },

  getPlaylistDetail: async (id: number) => {
    const res = await fetchWithCreds(`/playlist/detail?id=${id}`);
    if (res.playlist) {
      res.playlist.coverImgUrl = toHttps(res.playlist.coverImgUrl);
      if (res.playlist.creator) res.playlist.creator.avatarUrl = toHttps(res.playlist.creator.avatarUrl);
      if (res.playlist.tracks) {
        res.playlist.tracks = mergeSongsWithPrivileges(res.playlist.tracks, res.privileges);
      }
    }
    return res;
  },

  updatePlaylistTracks: async (op: 'add' | 'del', pid: number, tracks: number[] | number) => {
    const trackParam = Array.isArray(tracks) ? tracks.join(',') : String(tracks);
    return fetchWithCreds(`/playlist/tracks?op=${op}&pid=${pid}&tracks=${trackParam}&timestamp=${Date.now()}`);
  },

  getAlbum: async (id: number) => {
    const res = await fetchWithCreds(`/album?id=${id}`);
    if (res.album) {
      res.album.picUrl = toHttps(res.album.picUrl);
    }
    if (res.songs) {
      res.songs = mergeSongsWithPrivileges(res.songs, res.privileges);
    }
    return res;
  },

  getSongDetail: async (ids: number[] | number) => {
    return getSongDetail(ids);
  },

  getFavoriteAlbums: async (limit = 25, offset = 0) => {
    const res = await fetchWithCreds(`/album/sublist?limit=${limit}&offset=${offset}`);
    if (res.data) {
      res.data.forEach((a: any) => {
        a.picUrl = toHttps(a.picUrl);
        // Map artist info if needed, ensuring picUrl is https
      });
    }
    return res;
  },

  // --- Artist Data ---
  getArtistDetail: async (id: number) => {
    const res = await fetchWithCreds(`/artist/detail?id=${id}`);
    if (res.data && res.data.artist) {
      res.data.artist.cover = toHttps(res.data.artist.cover);
      res.data.artist.avatar = toHttps(res.data.artist.avatar);
    }
    return res;
  },

  getArtistAlbums: async (id: number, limit = 30, offset = 0) => {
    const res = await fetchWithCreds(`/artist/album?id=${id}&limit=${limit}&offset=${offset}`);
    if (res.hotAlbums) {
      res.hotAlbums.forEach((a: any) => {
        a.picUrl = toHttps(a.picUrl);
      });
    }
    return res;
  },

  getAllArtistAlbums: async (id: number) => {
    const limit = 50;
    const albums: any[] = [];
    const seenIds = new Set<string>();

    // Follow the API's `more` flag while guarding against malformed repeated pages.
    for (let page = 0; page < 200; page++) {
      const res = await neteaseApi.getArtistAlbums(id, limit, page * limit);
      const pageAlbums = Array.isArray(res?.hotAlbums) ? res.hotAlbums : [];
      let added = 0;
      for (const album of pageAlbums) {
        const key = String(album?.id ?? `${page}:${added}`);
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        albums.push(album);
        added++;
      }
      if (!res?.more || pageAlbums.length === 0 || added === 0) break;
    }

    return albums;
  },

  getArtistTopSongs: async (id: number) => {
    const res = await fetchWithCreds(`/artist/top/song?id=${id}`);
    res.songs = mergeSongsWithPrivileges(res.songs, res.privileges);
    return res;
  },

  getArtistSongs: async (id: number, limit = 50, offset = 0, order = 'hot') => {
    const res = await fetchWithCreds(`/artist/songs?id=${id}&limit=${limit}&offset=${offset}&order=${order}`);
    res.songs = mergeSongsWithPrivileges(res.songs, res.privileges);
    return res;
  },

  // --- Song Data ---
  getSongUrl: async (id: number, level: string = 'exhigh') => {
    // Use exhigh (320k) by default to ensure VIP songs have a valid signed URL.
    // 'standard' often returns null or invalid links for VIP content even if logged in.
    // randomCNIP=true added to improve success rate for some restricted tracks
    // https=true ensures URLs are returned with HTTPS protocol to avoid mixed content issues
    return fetchWithCreds(`/song/url/v1?id=${id}&level=${level}&randomCNIP=true&https=true`);
  },

  getLyric: async (id: number) => {
    return fetchWithCreds(`/lyric/new?id=${id}`);
  },

  getChorus: async (id: number) => {
    return fetchWithCreds(`/song/chorus?id=${id}`);
  },

  getCloudLyric: async (uid: number, sid: number) => {
    return fetchWithCreds(`/cloud/lyric/get?uid=${uid}&sid=${sid}`);
  },

  getUserCloud: async (limit = 200, offset = 0) => {
    const res = await fetchWithCreds(`/user/cloud?limit=${limit}&offset=${offset}`);
    const normalizedSongs = (res.data || []).map((item: any) => normalizeSongResult({
      ...item,
      t: item?.t ?? 1,
      simpleSong: item?.simpleSong
        ? { ...item.simpleSong, t: item.simpleSong.t ?? item?.t ?? 1 }
        : item.simpleSong,
    }));
    return {
      ...res,
      songs: normalizedSongs,
    };
  },

  getUserCloudDetail: async (ids: number[] | number) => {
    const idParam = Array.isArray(ids) ? ids.join(',') : String(ids);
    const res = await fetchWithCreds(`/user/cloud/detail?id=${idParam}`);
    return {
      ...res,
      songs: (res.data || []).map((item: any) => normalizeSongResult({
        ...item,
        t: item?.t ?? 1,
        simpleSong: item?.simpleSong
          ? { ...item.simpleSong, t: item.simpleSong.t ?? item?.t ?? 1 }
          : item.simpleSong,
      })),
    };
  },

  normalizeSongResult,
  getProcessedLyricPayload,
  getUnavailableSongReplacement,

  // --- Search ---
  cloudSearch: async (keywords: string, limit = 30, offset = 0) => {
    const res = await fetchWithCreds(`/cloudsearch?keywords=${encodeURIComponent(keywords)}&limit=${limit}&offset=${offset}`);
    if (res.result) {
      res.result.songs = mergeSongsWithPrivileges(res.result.songs, res.result.privileges ?? res.privileges);
    }
    return res;
  },

  // --- Radio ---
  getPersonalFm: async () => {
    return fetchWithCreds(`/personal_fm?timestamp=${Date.now()}`);
  },

  getDailyRecommendedSongs: async (afresh = false) => {
    const res = await fetchWithCreds(`/recommend/songs?afresh=${afresh}&timestamp=${Date.now()}`);
    const rawSongs = res.data?.dailySongs || res.data?.songs || res.recommendData?.dailySongs || res.songs || [];
    return {
      ...res,
      songs: mergeSongsWithPrivileges(rawSongs, res.data?.privileges || res.privileges),
    };
  },

  dislikeDailyRecommendedSong: async (songId: number) => {
    const res = await fetchWithCreds(`/recommend/songs/dislike?id=${songId}&timestamp=${Date.now()}`);
    return {
      ...res,
      song: res.data ? normalizeSongResult(res.data) : null,
    };
  },

  getDailyRecommendationHistoryDates: async () => {
    const res = await fetchWithCreds(`/history/recommend/songs?timestamp=${Date.now()}`);
    const rawDates = res.data?.dates || res.dates || res.data || [];
    return {
      ...res,
      dates: Array.isArray(rawDates)
        ? rawDates
          .map((item: unknown) => typeof item === 'string' ? item : (item as { date?: string })?.date)
          .filter((date: unknown): date is string => typeof date === 'string' && date.length > 0)
        : [],
    };
  },

  getDailyRecommendationHistoryDetail: async (date: string) => {
    const res = await fetchWithCreds(`/history/recommend/songs/detail?date=${encodeURIComponent(date)}&timestamp=${Date.now()}`);
    const rawSongs = res.data?.dailySongs || res.data?.songs || res.recommendData?.dailySongs || res.songs || [];
    return {
      ...res,
      songs: mergeSongsWithPrivileges(rawSongs, res.data?.privileges || res.privileges),
    };
  },

  getPersonalizedPlaylists: async (limit = 35) => {
    return fetchWithCreds(`/personalized?limit=${limit}`);
  },

  fmTrash: async (songId: number) => {
    return fetchWithCreds(`/fm_trash?id=${songId}&timestamp=${Date.now()}`);
  },

  subscribePlaylist: async (id: number, subscribe = true) => {
    const t = subscribe ? 1 : 2;
    return fetchWithCreds(`/playlist/subscribe?t=${t}&id=${id}&timestamp=${Date.now()}`);
  },

  subscribeAlbum: async (id: number, subscribe = true) => {
    const t = subscribe ? 1 : 2;
    return fetchWithCreds(`/album/sub?t=${t}&id=${id}&timestamp=${Date.now()}`);
  },

  getPlaylistDetailDynamic: async (id: number) => {
    return fetchWithCreds(`/playlist/detail/dynamic?id=${id}`);
  },

  getAlbumDetailDynamic: async (id: number) => {
    return fetchWithCreds(`/album/detail/dynamic?id=${id}`);
  },
};
