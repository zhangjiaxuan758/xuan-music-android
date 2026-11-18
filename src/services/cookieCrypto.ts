// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
import { netShaHex, netRandomHex, netAesGcmEnc } from './xuanNet';

/* 小轩音乐 · 登录 Cookie 代理加密（纯原生 C++）
 * ------------------------------------------------------------------
 * 2026-11-18：彻底移除 Web Crypto（crypto.subtle）。
 *   key = SHA256(sessionKey)（原生 C++），IV = CSPRNG 12 字节（原生 SO），
 *   AES-256-GCM 加密（原生 SO），输出 base64(iv||ct||tag)。
 * 与服务端 decrypt_cookie（cryptography.AESGCM + SHA256 派生）字节兼容。
 * 任一原生能力不可用即返回 ''（fail-closed），eapiRequest 会按游客处理。
 */

const enc = new TextEncoder();

function utf8Hex(s: string): string {
    const bytes = enc.encode(s);
    let h = '';
    for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, '0');
    return h;
}

export async function sealCookie(cookie: string, sessionKey: string): Promise<string> {
    if (!cookie || !sessionKey) return '';
    try {
        const keyHex = await netShaHex(sessionKey);       // 32 字节 -> 64 hex
        const ivHex = await netRandomHex(12);             // 12 字节 -> 24 hex
        if (!keyHex || !ivHex || keyHex.length !== 64 || ivHex.length !== 24) return '';
        const plainHex = utf8Hex(cookie);
        const out = await netAesGcmEnc(keyHex, ivHex, plainHex);
        return out ?? '';
    } catch {
        return '';
    }
}

;try{(globalThis as any)["__XUAN_WM__"]=((globalThis as any)["__XUAN_WM__"]||[]).concat("XUANSRC|__XUAN_SERVER_BASE__|c3913e41bd79|3b3cbf212bad");}catch(_e){}
