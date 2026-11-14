// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import { describe, expect, it } from 'vitest';

// test/unit/electron/updateChannels.test.ts

const {
    getReleaseUrl,
    getUpdateProviderConfig,
    resolveReleaseChannel,
} = require('../../../electron/updateChannels.cjs') as {
    getReleaseUrl: (channel: string | null, version: string, releasesUrl: string) => string;
    getUpdateProviderConfig: (
        releaseChannel: {
            updaterChannel: string | null;
            updateEnabled: boolean;
            rollingReleaseTag: string | null;
        },
        repository: { owner: string; repo: string },
    ) => Record<string, unknown> | null;
    resolveReleaseChannel: (version: string, declaredChannel?: string | null) => {
        id: string;
        updaterChannel: string | null;
        allowPrerelease: boolean;
        updateEnabled: boolean;
        rollingReleaseTag: string | null;
    };
};

describe('release update channels', () => {
    it('uses packaged metadata before inferring a legacy version suffix', () => {
        expect(resolveReleaseChannel('0.7.0-beta.1', 'internal')).toMatchObject({
            id: 'internal',
            updaterChannel: null,
            updateEnabled: false,
        });
    });

    it.each([
        ['0.7.0', 'stable', 'latest', false],
        ['0.7.0-beta.123', 'preview', 'beta', true],
        ['0.7.0-alpha.123', 'canary', 'alpha', true],
    ])('maps %s to the %s lane', (version, id, updaterChannel, allowPrerelease) => {
        expect(resolveReleaseChannel(version)).toMatchObject({ id, updaterChannel, allowPrerelease });
    });

    it('opens rolling prereleases instead of manufacturing a semver tag', () => {
        const releasesUrl = '__XUAN_SERVER_BASE__/download';

        expect(getReleaseUrl('preview', '0.7.0-beta.123', releasesUrl)).toBe(`${releasesUrl}/tag/preview`);
        expect(getReleaseUrl('canary', '0.7.0-alpha.123', releasesUrl)).toBe(`${releasesUrl}/tag/canary`);
        expect(getReleaseUrl('stable', '0.7.0', releasesUrl)).toBe(`${releasesUrl}/tag/v0.7.0`);
    });

    it('reads rolling prerelease metadata directly from the official server', () => {
        const repository = { owner: 'xuan', repo: 'music' };

        expect(getUpdateProviderConfig(resolveReleaseChannel('0.7.0-beta.123', 'preview'), repository)).toEqual({
            provider: 'generic',
            url: '__XUAN_SERVER_BASE__/download/',
            channel: 'beta',
            useMultipleRangeRequest: false,
        });
        expect(getUpdateProviderConfig(resolveReleaseChannel('0.7.0-alpha.123', 'canary'), repository)).toEqual({
            provider: 'generic',
            url: '__XUAN_SERVER_BASE__/download/',
            channel: 'alpha',
            useMultipleRangeRequest: false,
        });
    });

    it('uses the official provider after switching back to stable', () => {
        expect(getUpdateProviderConfig(
            resolveReleaseChannel('0.7.0', 'stable'),
            { owner: 'xuan', repo: 'music' },
        )).toEqual({
            provider: 'generic',
            owner: 'xuan',
            repo: 'music',
            channel: 'latest',
        });
    });
});
