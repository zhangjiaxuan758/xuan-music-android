// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import { describe, expect, it } from 'vitest';
import { resolveXuanApiUrl } from '@/services/webApi';

// 当前文件：验证 Xuan API 地址在 Web 与 Capacitor Android 中的解析契约。

describe('resolveXuanApiUrl', () => {
  it('normalizes the configured remote base and endpoint', () => {
    expect(resolveXuanApiUrl('/api/lyric-proxy', {
      apiBase: ' __XUAN_SERVER_BASE__/api/ ',
      capacitorAndroid: true,
    })).toBe('__XUAN_SERVER_BASE__/api/lyric-proxy');
  });

  it('keeps the same-origin Web fallback when no base is configured', () => {
    expect(resolveXuanApiUrl('generate-theme', {
      apiBase: '',
      capacitorAndroid: false,
    })).toBe('/api/generate-theme');
  });

  it('requires a remote base for Capacitor Android', () => {
    expect(() => resolveXuanApiUrl('/api/generate-theme', {
      apiBase: '',
      capacitorAndroid: true,
    })).toThrow(/VITE_XUAN_API_BASE/);
  });
});
