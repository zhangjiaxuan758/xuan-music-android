// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import path from 'path';
import { fileURLToPath } from 'url';
import { type ConfigEnv, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'child_process';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 小轩音乐只提供网易云音源：第三方歌词代理中间件已移除。

export default async function viteConfig(_config: ConfigEnv): Promise<UserConfig> {
  const isCapacitorBuild = process.env.XUAN_BUILD_TARGET === 'capacitor';
  let commitHash = '';
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    commitHash = process.env.VERCEL_GIT_COMMIT_SHA.substring(0, 7);
  } else {
    try {
      commitHash = execSync('git rev-parse --short HEAD').toString().trim();
    } catch (e) {
      console.warn('Could not get commit hash:', e);
      commitHash = 'unknown, probably dev version';
    }
  }

  let gitBranch = '';
  if (process.env.VERCEL_GIT_COMMIT_REF) {
    gitBranch = process.env.VERCEL_GIT_COMMIT_REF;
  } else {
    try {
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    } catch (e) {
      console.warn('Could not get git branch:', e);
      gitBranch = 'unknown';
    }
  }

  let commitSuffix = '';
  const canResolveCommitName = /^[0-9a-f]{7,40}$/i.test(commitHash) && !/^0+$/.test(commitHash);
  if (canResolveCommitName) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`__XUAN_SERVER_BASE__/api/commit-name?hash=${commitHash}`, {
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json() as { name?: string };
        if (data?.name) {
          commitSuffix = `/${data.name}`;
        }
      }
    } catch (e) {
      // Ignore errors during fetch to prevent build failure
    }
  }
  if (process.env.REQUIRE_COMMIT_NAME === 'true' && canResolveCommitName && !commitSuffix) {
    throw new Error(`Could not resolve the commit name for ${commitHash}`);
  }

  const appVersionLabel = process.env.APP_VERSION_LABEL?.trim() || '小轩音乐';
  const appReleaseChannel = process.env.APP_RELEASE_CHANNEL?.trim().toLowerCase() || 'stable';
  const dockerStackVersion = process.env.DOCKER_STACK_VERSION?.trim() || '';

  // 客户端在线更新依赖真实 versionCode：直接以 android/app/build.gradle 为唯一来源注入，
  // 避免前端里写死的兜底值与 APK 版本漂移，导致「装了新版仍反复弹更新」。
  let xuanVersionCode = 10625;
  let xuanVersionName = '';
  try {
    const gradleText = fs.readFileSync(path.resolve(__dirname, 'android/app/build.gradle'), 'utf-8');
    const mCode = /versionCode\s+(\d+)/.exec(gradleText);
    if (mCode) xuanVersionCode = Number(mCode[1]);
    const mName = /versionName\s+"([^"]+)"/.exec(gradleText);
    if (mName) xuanVersionName = mName[1];
  } catch { /* 非 Android 工程时保留兜底 */ }
  // 版本名单一来源：build.gradle 的 versionName（package.json 长期停在旧值，
  // 曾导致每版装完「关于」仍显示同一版本号）。
  const packageVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')).version;
  const displayVersion = xuanVersionName || packageVersion;

  return {
    base: process.env.ELECTRON === 'true' || isCapacitorBuild ? './' : '/',
    worker: {
      format: 'es'
    },
    build: {
      rollupOptions: {
        input: {
          main: 'index.html',
          stageClient: 'stage-client.html',
        },
        output: {
          // three.js is a large dependency used only by the diorama 3D visualizer. Split it into its
          // own chunk so it doesn't bloat the main bundle past the PWA precache size limit (each file
          // must stay under workbox.maximumFileSizeToCacheInBytes to be cached for offline use).
          manualChunks(id) {
            return id.includes('/node_modules/three/') ? 'three' : undefined;
          },
        },
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [
      react(),
      ...(isCapacitorBuild ? [] : [VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.png'],
        devOptions: {
          enabled: true
        },
        workbox: {
          maximumFileSizeToCacheInBytes: 5000000,
          // Docker serves this file dynamically; it must never be pinned in the PWA precache.
          globIgnores: ['**/runtime-config.js']
        },
        manifest: {
          name: '小轩音乐',
          short_name: '小轩音乐',
          description: '小轩音乐客户端',
          theme_color: '#09090b',
          background_color: '#09090b',
          display: 'standalone',
          icons: [
            {
              src: 'favicon.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any maskable'
            }
          ]
        }
      })])
    ],
    define: {
      '__COMMIT_HASH__': JSON.stringify(commitHash + commitSuffix),
      '__GIT_BRANCH__': JSON.stringify(gitBranch),
      '__APP_VERSION__': JSON.stringify(displayVersion),
      '__APP_VERSION_LABEL__': JSON.stringify(appVersionLabel),
      '__APP_RELEASE_CHANNEL__': JSON.stringify(appReleaseChannel),
      '__DOCKER_STACK_VERSION__': JSON.stringify(dockerStackVersion),
      '__XUAN_VERSION_CODE__': JSON.stringify(xuanVersionCode)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      }
    }
  };
}
