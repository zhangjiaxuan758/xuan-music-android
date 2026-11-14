// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
/**
 * 小轩音乐 · C++ 网络层封装（TS 侧仅做 IO 编排，密码学全在 C++ wasm 里）
 * 真正的 HTTP 收发由宿主原生通道完成（CapacitorHttp / Electron net），本层不碰网络。
 */
import { XUAN_NET_WASM_BASE64 } from './wasm/xuanNetWasm';

let EXP: any = null;
let MEM: Uint8Array | null = null;
let IO = 0;

function inst(): any {
    if (EXP) return EXP;
    const raw = atob(XUAN_NET_WASM_BASE64);
    const bin = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bin[i] = raw.charCodeAt(i);
    const mod = new WebAssembly.Module(bin);
    const ins = new WebAssembly.Instance(mod, {});
    EXP = ins.exports;
    MEM = new Uint8Array((EXP.memory as WebAssembly.Memory).buffer);
    IO = EXP.xn_io() as number;
    return EXP;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
// IO 区布局：A=0, B=1024, C=2048, OUT=8192（与 C++ g_io 一致）
const A = 0, B = 1024, C = 2048, OUT = 8192;

function put(s: string, off: number): number {
    const e = inst(); const m = MEM!; const b = enc.encode(s);
    m.set(b, IO + off);
    return b.length;
}
function gethex(off: number, len: number): string {
    return dec.decode(MEM!.slice(IO + off, IO + off + len));
}

/** SHA-256 hex（C++） */
export function netShaHex(s: string): string {
    const n = put(s, A); inst().xn_sha_hex(A, n, OUT);
    return gethex(OUT, 64);
}
/** HMAC-SHA256 hex（C++） */
export function netHmacHex(key: string, msg: string): string {
    const kl = put(key, A), ml = put(msg, B);
    inst().xn_hmac_hex(A, kl, B, ml, OUT);
    return gethex(OUT, 64);
}
/** 路由表键 = sha256("key|"+规范路径) 前 12 位（C++） */
export function netRouteKey(canon: string): string {
    const n = put(canon, A); inst().xn_route_key(A, n, OUT);
    return gethex(OUT, 12);
}
/** 引导表验签：HMAC(secret,"xuan-boot|"+canon)==sig，常量时间比较（C++） */
export function netBootVerify(canon: string, sig: string, secret: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(sig || '')) return false;
    const cl = put(canon, A), sl = put(sig, B), kl = put(secret, C);
    return inst().xn_boot_verify(A, cl, B, sl, C, kl) === 1;
}
/** 常量时间相等比较（C++） */
export function netCtEq(a: string, b: string): boolean {
    const al = put(a, A), bl = put(b, B);
    return inst().xn_ct_eq(A, al, B, bl) === 1;
}

/** 与服务端 json.dumps(sort_keys=True) 一致的规范化串（v2 含 role）。 */
export function canonicalBoot(t: { v: number; role: string; epoch: number; ttl: number; routes: Record<string, string> }): string {
    const routes: Record<string, string> = {};
    Object.keys(t.routes).sort().forEach(k => { routes[k] = t.routes[k]; });
    // Python sort_keys 顶层键序: epoch, role, routes, ttl, v
    return JSON.stringify({ epoch: t.epoch, role: t.role, routes, ttl: t.ttl, v: t.v });
}
