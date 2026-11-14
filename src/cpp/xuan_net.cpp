// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
/* 小轩音乐 · C++ 网络层核心（xuan_net）
 * ------------------------------------------------------------------
 * 所有「网络层密码学逻辑」都在这份 C++ 里，编译成无 import 的 wasm 二进制，
 * 安卓客户端 / 管理端 / PC 端共用同一份产物：
 *   - SHA-256 / HMAC-SHA256（自实现，无第三方库、无 libc）
 *   - 引导路由表签名验签（HMAC 覆盖 role，防跨端替换）
 *   - 规范路径 -> 表键（sha256("key|"+canon)[:12]）
 *   - 请求签名 / 隐蔽版本号派生所需的 HMAC 原语
 *   - 常量时间比较（验签 / 令牌比对），避免时序侧信道
 *
 * 动态链接由这份 C++ 代码验签并派生，而不是由任何网页 / 内嵌页获取；
 * 真正的 HTTP 收发由各端宿主「原生通道」完成（CapacitorHttp / Electron net）。
 *
 * 约束：-nostdlib -fno-exceptions -fno-rtti，纯 POD 静态数组，零 import。
 * IO 约定：调用方把输入写进 xn_io() 返回的线性内存区，用 (相对偏移,长度) 传参；
 *          输出 hex 写回同一缓冲区的指定偏移。
 */
typedef unsigned char u8;
typedef unsigned int u32;
typedef unsigned long long u64;

static const u32 K256[64] = {
    0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
    0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
    0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
    0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
    0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
    0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
    0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
    0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u,
};

static inline u32 rotr(u32 x, int n) { return (x >> n) | (x << (32 - n)); }

static void sha256_raw(const u8* data, int len, u8 out[32]) {
    u32 h[8] = {0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,
                0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};
    int nblk = (len + 9 + 63) / 64;
    u64 bits = (u64)len * 8ull;
    u8 block[64];
    for (int b = 0; b < nblk; b++) {
        for (int i = 0; i < 64; i++) {
            int idx = b * 64 + i;
            if (idx < len) block[i] = data[idx];
            else if (idx == len) block[i] = 0x80;
            else block[i] = 0;
        }
        if (b == nblk - 1) {
            for (int i = 0; i < 8; i++) block[56 + i] = (u8)(bits >> (56 - 8 * i));
        }
        u32 w[64];
        for (int i = 0; i < 16; i++)
            w[i] = ((u32)block[4*i] << 24) | ((u32)block[4*i+1] << 16) |
                   ((u32)block[4*i+2] << 8) | (u32)block[4*i+3];
        for (int i = 16; i < 64; i++) {
            u32 s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >> 3);
            u32 s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >> 10);
            w[i] = w[i-16] + s0 + w[i-7] + s1;
        }
        u32 a=h[0],bb=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
        for (int i = 0; i < 64; i++) {
            u32 S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
            u32 ch = (e & f) ^ ((~e) & g);
            u32 t1 = hh + S1 + ch + K256[i] + w[i];
            u32 S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
            u32 maj = (a & bb) ^ (a & c) ^ (bb & c);
            u32 t2 = S0 + maj;
            hh=g; g=f; f=e; e=d+t1; d=c; c=bb; bb=a; a=t1+t2;
        }
        h[0]+=a; h[1]+=bb; h[2]+=c; h[3]+=d; h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=hh;
    }
    for (int i = 0; i < 8; i++) {
        out[4*i]   = (u8)(h[i] >> 24); out[4*i+1] = (u8)(h[i] >> 16);
        out[4*i+2] = (u8)(h[i] >> 8);  out[4*i+3] = (u8)(h[i]);
    }
}

static const char HEX[] = "0123456789abcdef";
static void to_hex(const u8* d, int n, u8* out) {
    for (int i = 0; i < n; i++) { out[2*i] = (u8)HEX[d[i] >> 4]; out[2*i+1] = (u8)HEX[d[i] & 15]; }
}

/* HMAC-SHA256：key 超 64 字节先 hash；msg 与本函数内拼接缓冲上限 8192。 */
static u8 g_pad[8192];
/* 验签/路由键拼装消息用独立缓冲，避免与 hmac_hex 内部工作缓冲 g_pad 冲突。 */
static u8 g_msg[8192];
static void hmac_hex(const u8* key, int klen, const u8* msg, int mlen, u8 out[64]) {
    u8 kb[64];
    for (int i = 0; i < 64; i++) kb[i] = 0;
    if (klen > 64) { u8 d[32]; sha256_raw(key, klen, d); for (int i = 0; i < 32; i++) kb[i] = d[i]; }
    else for (int i = 0; i < klen; i++) kb[i] = key[i];
    u8 ip[64], op[64];
    for (int i = 0; i < 64; i++) { ip[i] = kb[i] ^ 0x36; op[i] = kb[i] ^ 0x5c; }
    if (mlen > (int)sizeof(g_pad) - 64) mlen = (int)sizeof(g_pad) - 64;
    for (int i = 0; i < 64; i++) g_pad[i] = ip[i];
    for (int i = 0; i < mlen; i++) g_pad[64 + i] = msg[i];
    u8 inner[32]; sha256_raw(g_pad, 64 + mlen, inner);
    for (int i = 0; i < 64; i++) g_pad[i] = op[i];
    for (int i = 0; i < 32; i++) g_pad[64 + i] = inner[i];
    u8 mac[32]; sha256_raw(g_pad, 64 + 32, mac);
    to_hex(mac, 32, out);
}

static int ct_eq(const u8* a, const u8* b, int n) {
    u8 diff = 0;
    for (int i = 0; i < n; i++) diff |= (u8)(a[i] ^ b[i]);
    return diff == 0 ? 1 : 0;
}

/* ---- IO 区：JS/宿主把输入写进这里，读回输出 ---- */
static u8 g_io[16384];

extern "C" {
    int xn_io(void)     { return (int)(u32)(unsigned long)g_io; }
    int xn_io_cap(void) { return (int)sizeof(g_io); }
    int xn_version(void){ return 2; }

    /* sha256(g_io[off..off+len]) 的 hex 写到 out */
    int xn_sha_hex(int off, int len, int out) {
        if (off < 0 || len < 0 || off + len > (int)sizeof(g_io)) return 0;
        if (out < 0 || out + 64 > (int)sizeof(g_io)) return 0;
        u8 d[32]; sha256_raw(g_io + off, len, d);
        to_hex(d, 32, g_io + out);
        return 64;
    }

    /* HMAC-SHA256(key=g_io[koff..], msg=g_io[moff..]) 的 hex 写到 out */
    int xn_hmac_hex(int koff, int klen, int moff, int mlen, int out) {
        if (koff < 0 || klen < 0 || koff + klen > (int)sizeof(g_io)) return 0;
        if (moff < 0 || mlen < 0 || moff + mlen > (int)sizeof(g_io)) return 0;
        if (out < 0 || out + 64 > (int)sizeof(g_io)) return 0;
        hmac_hex(g_io + koff, klen, g_io + moff, mlen, g_io + out);
        return 64;
    }

    /* route key = sha256("key|" + canon) 的前 12 位 hex；写入 out，返回 12 */
    int xn_route_key(int off, int len, int out) {
        if (off < 0 || len < 0 || off + len + 4 > (int)sizeof(g_io)) return 0;
        if (out < 0 || out + 12 > (int)sizeof(g_io)) return 0;
        g_msg[0] = 'k'; g_msg[1] = 'e'; g_msg[2] = 'y'; g_msg[3] = '|';
        for (int i = 0; i < len; i++) g_msg[4 + i] = g_io[off + i];
        u8 d[32]; sha256_raw(g_msg, 4 + len, d);
        u8 hex[64]; to_hex(d, 32, hex);
        for (int i = 0; i < 12; i++) g_io[out + i] = hex[i];
        return 12;
    }

    /* boot 验签：HMAC(secret, "xuan-boot|" + canon) 与 sig(64 hex) 常量时间比较 */
    int xn_boot_verify(int coff, int clen, int soff, int slen,
                       int koff, int klen) {
        if (slen != 64) return 0;
        if (coff < 0 || clen < 0 || coff + clen > (int)sizeof(g_io)) return 0;
        if (soff < 0 || soff + 64 > (int)sizeof(g_io)) return 0;
        if (koff < 0 || klen < 0 || koff + klen > (int)sizeof(g_io)) return 0;
        const char* pre = "xuan-boot|";
        int plen = 10;
        for (int i = 0; i < plen; i++) g_msg[i] = (u8)pre[i];
        if (clen > (int)sizeof(g_msg) - plen) return 0;
        for (int i = 0; i < clen; i++) g_msg[plen + i] = g_io[coff + i];
        u8 want[64];
        hmac_hex(g_io + koff, klen, g_msg, plen + clen, want);
        return ct_eq(want, g_io + soff, 64);
    }

    /* 常量时间相等比较（令牌 / 哈希比对） */
    int xn_ct_eq(int aoff, int alen, int boff, int blen) {
        if (alen != blen) return 0;
        if (aoff < 0 || boff < 0 || aoff + alen > (int)sizeof(g_io) || boff + blen > (int)sizeof(g_io)) return 0;
        return ct_eq(g_io + aoff, g_io + boff, alen);
    }
}
