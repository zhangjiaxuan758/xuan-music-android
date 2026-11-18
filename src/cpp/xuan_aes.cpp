// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
/* 小轩音乐 · 原生 AES-256-GCM / CSPRNG（xuan_aes）
 * ------------------------------------------------------------------
 * 2026-11-18：为彻底移除 Web Crypto（crypto.subtle）而新增。
 *   - AES-256-GCM 加密：与服务端 Python cryptography(AESGCM) 字节兼容。
 *     密钥 = SHA256(sessionKey)（由调用方通过 hex 传入已派生好的 32 字节 key），
 *     IV 12 字节，输出 base64(iv || ct || tag)。用于 eapi 登录 Cookie 代理加密。
 *   - CSPRNG：替代 crypto.getRandomValues，供 IV / nonce / clientId 使用。
 * 纯自研实现，无第三方库；算法已用 FIPS-197(AES-256) 与 cryptography(GCM) 字节对拍。
 *
 * 约定：输入输出走 xuan_net.cpp 的 g_io 线性内存（经 xn_io_ptr()），(off,len) 传参；
 *       key/iv/明文均以 ASCII hex 文本传入（二进制安全），base64 写回 out 偏移。
 */
typedef unsigned char u8;
typedef unsigned int u32;
typedef unsigned long long u64;

extern "C" {
    void* xn_io_ptr(void);
#if defined(_WIN32)
    unsigned char SystemFunction036(void* buffer, unsigned long length); /* RtlGenRandom, advapi32 */
#else
    long syscall(long number, ...);
#endif
}

static const u8 AES_SBOX[256] = {
0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16};

static inline u8 xtime(u8 x) { return (u8)((x << 1) ^ ((x & 0x80) ? 0x1b : 0)); }

static void aes_keyexp(const u8* key, u8* w) {
    static const u8 rc[8] = {0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80};
    for (int i = 0; i < 32; i++) w[i] = key[i];
    for (int i = 8; i < 60; i++) {
        u8 t[4];
        for (int j = 0; j < 4; j++) t[j] = w[4*(i-1)+j];
        if (i % 8 == 0) {
            u8 a = t[0];
            t[0] = (u8)(AES_SBOX[t[1]] ^ rc[i/8-1]);
            t[1] = AES_SBOX[t[2]]; t[2] = AES_SBOX[t[3]]; t[3] = AES_SBOX[a];
        } else if (i % 8 == 4) {
            for (int j = 0; j < 4; j++) t[j] = AES_SBOX[t[j]];
        }
        for (int j = 0; j < 4; j++) w[4*i+j] = (u8)(w[4*(i-8)+j] ^ t[j]);
    }
}

static void aes_enc_block(const u8 in[16], const u8* w, u8 out[16]) {
    u8 s[16];
    for (int i = 0; i < 16; i++) s[i] = (u8)(in[i] ^ w[i]);
    for (int r = 1; r <= 14; r++) {
        for (int i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
        u8 t[16];
        for (int c = 0; c < 4; c++) for (int row = 0; row < 4; row++)
            t[4*c+row] = s[4*((c+row)&3)+row];
        for (int i = 0; i < 16; i++) s[i] = t[i];
        if (r != 14) {
            for (int c = 0; c < 4; c++) {
                u8* a = s + 4*c; u8 a0=a[0],a1=a[1],a2=a[2],a3=a[3];
                a[0] = (u8)(xtime(a0) ^ (xtime(a1)^a1) ^ a2 ^ a3);
                a[1] = (u8)(a0 ^ xtime(a1) ^ (xtime(a2)^a2) ^ a3);
                a[2] = (u8)(a0 ^ a1 ^ xtime(a2) ^ (xtime(a3)^a3));
                a[3] = (u8)((xtime(a0)^a0) ^ a1 ^ a2 ^ xtime(a3));
            }
        }
        for (int i = 0; i < 16; i++) s[i] ^= w[16*r+i];
    }
    for (int i = 0; i < 16; i++) out[i] = s[i];
}

static void gf_mul(const u8 X[16], const u8 Y[16], u8 Z[16]) {
    u8 V[16];
    for (int i = 0; i < 16; i++) V[i] = Y[i];
    for (int i = 0; i < 16; i++) Z[i] = 0;
    for (int i = 0; i < 128; i++) {
        if ((X[i/8] >> (7-(i%8))) & 1)
            for (int j = 0; j < 16; j++) Z[j] ^= V[j];
        int lsb = V[15] & 1;
        for (int j = 15; j > 0; j--) V[j] = (u8)((V[j]>>1) | ((V[j-1]&1)<<7));
        V[0] = (u8)(V[0]>>1);
        if (lsb) V[0] ^= 0xe1;
    }
}

static void ghash(const u8 H[16], const u8* data, int len, u8 out[16]) {
    u8 Y[16], tmp[16], r[16];
    for (int i = 0; i < 16; i++) Y[i] = 0;
    for (int i = 0; i < len; i += 16) {
        int n = (len - i < 16) ? len - i : 16;
        for (int j = 0; j < 16; j++) tmp[j] = 0;
        for (int j = 0; j < n; j++) tmp[j] = data[i+j];
        for (int j = 0; j < 16; j++) Y[j] ^= tmp[j];
        gf_mul(Y, H, r);
        for (int j = 0; j < 16; j++) Y[j] = r[j];
    }
    for (int i = 0; i < 16; i++) out[i] = Y[i];
}

static int hex_nib(u8 c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}
static int unhex(const u8* hex, int hlen, u8* out) {
    if (hlen < 0 || (hlen & 1)) return 0;
    int n = hlen / 2;
    for (int i = 0; i < n; i++) {
        int hi = hex_nib(hex[2*i]), lo = hex_nib(hex[2*i+1]);
        if (hi < 0 || lo < 0) return 0;
        out[i] = (u8)((hi<<4) | lo);
    }
    return n;
}

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static int to_b64(const u8* d, int n, u8* out) {
    int p = 0;
    for (int i = 0; i < n; i += 3) {
        u8 b0 = d[i], b1 = (i+1<n)?d[i+1]:0, b2 = (i+2<n)?d[i+2]:0;
        out[p++] = (u8)B64[b0>>2];
        out[p++] = (u8)B64[((b0&3)<<4)|(b1>>4)];
        out[p++] = (i+1<n) ? (u8)B64[((b1&15)<<2)|(b2>>6)] : '=';
        out[p++] = (i+2<n) ? (u8)B64[b2&63] : '=';
    }
    return p;
}

/* AES-256-GCM 加密。key/iv/pt 均为 g_io 内的 ASCII hex 文本偏移。
 * out 写 base64(iv||ct||tag)。返回输出字节数，失败返回 0。 */
extern "C" int xn_aes_gcm_enc(int koff, int klen, int ioff, int ilen,
                              int poff, int plen, int out) {
    u8 key[32], iv[12];
    if (unhex((const u8*)xn_io_ptr()+koff, klen, key) != 32) return 0;
    if (unhex((const u8*)xn_io_ptr()+ioff, ilen, iv) != 12) return 0;
    int pn = plen / 2;
    if (plen < 0 || (plen & 1)) return 0;

    u8 w[240];
    aes_keyexp(key, w);
    u8 zero[16], H[16];
    for (int i = 0; i < 16; i++) zero[i] = 0;
    aes_enc_block(zero, w, H);

    u8 J0[16];
    for (int i = 0; i < 12; i++) J0[i] = iv[i];
    J0[12]=J0[13]=J0[14]=0; J0[15]=1;

    /* 密文缓冲：明文最长受参数槽限制 32760 hex -> 16380 字节，预留 tag。 */
    static u8 ctbuf[32768];
    if (pn > 32700) return 0;
    /* 明文 hex 位于 g_io[poff..]，边解码边加密，避免额外大缓冲。 */
    u8 ctr[16];
    for (int i = 0; i < 16; i++) ctr[i] = J0[i];
    { u32 c = ((u32)ctr[12]<<24)|((u32)ctr[13]<<16)|((u32)ctr[14]<<8)|ctr[15]; c++;
      ctr[12]=(u8)(c>>24); ctr[13]=(u8)(c>>16); ctr[14]=(u8)(c>>8); ctr[15]=(u8)c; }
    for (int i = 0; i < pn; i += 16) {
        u8 ks[16], block[16];
        int m = (pn - i < 16) ? pn - i : 16;
        for (int j = 0; j < m; j++) {
            int hi = hex_nib(((const u8*)xn_io_ptr())[poff + 2*(i+j)]);
            int lo = hex_nib(((const u8*)xn_io_ptr())[poff + 2*(i+j) + 1]);
            if (hi < 0 || lo < 0) return 0;
            block[j] = (u8)((hi<<4)|lo);
        }
        aes_enc_block(ctr, w, ks);
        for (int j = 0; j < m; j++) ctbuf[i+j] = (u8)(block[j] ^ ks[j]);
        u32 c = ((u32)ctr[12]<<24)|((u32)ctr[13]<<16)|((u32)ctr[14]<<8)|ctr[15]; c++;
        ctr[12]=(u8)(c>>24); ctr[13]=(u8)(c>>16); ctr[14]=(u8)(c>>8); ctr[15]=(u8)c;
    }

    /* GHASH over ct || len_block (AAD 为空) */
    int al = (pn + 15) / 16 * 16;
    static u8 gd[32768 + 32];
    if (al + 16 > (int)sizeof(gd)) return 0;
    for (int i = 0; i < al; i++) gd[i] = (i < pn) ? ctbuf[i] : 0;
    u64 cl = (u64)pn * 8ull;
    for (int i = 0; i < 8; i++) gd[al + i] = 0;
    for (int i = 0; i < 8; i++) gd[al + 8 + i] = (u8)(cl >> (56 - 8*i));
    u8 S[16];
    ghash(H, gd, al + 16, S);
    u8 ek0[16], tag[16];
    aes_enc_block(J0, w, ek0);
    for (int i = 0; i < 16; i++) tag[i] = (u8)(ek0[i] ^ S[i]);

    /* 输出：iv(12) || ct(pn) || tag(16) 的 base64 */
    static u8 raw[32768 + 48];
    for (int i = 0; i < 12; i++) raw[i] = iv[i];
    for (int i = 0; i < pn; i++) raw[12+i] = ctbuf[i];
    for (int i = 0; i < 16; i++) raw[12+pn+i] = tag[i];
    u8* io = (u8*)xn_io_ptr();
    if (out < 0 || out + ((12+pn+16+2)/3*4) > 262144) return 0;
    return to_b64(raw, 12 + pn + 16, io + out);
}

/* CSPRNG：写 n 字节随机到 out。Android/Linux 用 getrandom；Windows 用 rand_s。
 * 返回实际写入字节数，失败 0。 */
extern "C" int xn_rng(int out, int n) {
    if (out < 0 || n < 0 || out + n > 262144) return 0;
    u8* p = (u8*)xn_io_ptr() + out;
#if defined(_WIN32)
    /* Windows: RtlGenRandom (SystemFunction036)，advapi32 导出，XP+ 可用。 */
    return SystemFunction036(p, (unsigned long)n) ? n : 0;
#else
    /* Linux/Android bionic 提供 getrandom() 系统调用。 */
    #ifndef __NR_getrandom
    #if defined(__aarch64__)
    #define __NR_getrandom 278
    #elif defined(__x86_64__)
    #define __NR_getrandom 318
    #elif defined(__i386__)
    #define __NR_getrandom 384
    #else
    #define __NR_getrandom 278   /* armv7 / 其它 32 位 */
    #endif
    #endif
    long got = syscall(__NR_getrandom, p, (unsigned long)n, 0ul);
    return got > 0 ? (int)got : 0;
#endif
}

extern "C" __attribute__((used)) const char XUAN_WM_AES[] = "XUANSRC|__XUAN_SERVER_BASE__|aes|native";

/* ---- 增量 SHA-256（appUpdater 整包校验：分块喂入，避免 hex 翻倍 250MB）---- */
struct XuanShaCtx { u32 h[8]; u64 total; u8 buf[64]; int buflen; };
static XuanShaCtx g_sha;

static const u32 SHA_K[64] = {
0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};
static inline u32 shr(u32 x,int n){return x>>n;}
static inline u32 rotr32(u32 x,int n){return (x>>n)|(x<<(32-n));}
static void sha_compress(XuanShaCtx* c,const u8 block[64]){
    u32 w[64];
    for(int i=0;i<16;i++) w[i]=((u32)block[4*i]<<24)|((u32)block[4*i+1]<<16)|((u32)block[4*i+2]<<8)|block[4*i+3];
    for(int i=16;i<64;i++){u32 s0=rotr32(w[i-15],7)^rotr32(w[i-15],18)^shr(w[i-15],3);
      u32 s1=rotr32(w[i-2],17)^rotr32(w[i-2],19)^shr(w[i-2],10); w[i]=w[i-16]+s0+w[i-7]+s1;}
    u32 a=c->h[0],b=c->h[1],cc=c->h[2],d=c->h[3],e=c->h[4],f=c->h[5],g=c->h[6],h=c->h[7];
    for(int i=0;i<64;i++){u32 S1=rotr32(e,6)^rotr32(e,11)^rotr32(e,25);
      u32 ch=(e&f)^(~e&g); u32 t1=h+S1+ch+SHA_K[i]+w[i];
      u32 S0=rotr32(a,2)^rotr32(a,13)^rotr32(a,22); u32 maj=(a&b)^(a&cc)^(b&cc); u32 t2=S0+maj;
      h=g;g=f;f=e;e=d+t1;d=cc;cc=b;b=a;a=t1+t2;}
    c->h[0]+=a;c->h[1]+=b;c->h[2]+=cc;c->h[3]+=d;c->h[4]+=e;c->h[5]+=f;c->h[6]+=g;c->h[7]+=h;
}
extern "C" int xn_shainit(void){
    g_sha.h[0]=0x6a09e667u;g_sha.h[1]=0xbb67ae85u;g_sha.h[2]=0x3c6ef372u;g_sha.h[3]=0xa54ff53au;
    g_sha.h[4]=0x510e527fu;g_sha.h[5]=0x9b05688cu;g_sha.h[6]=0x1f83d9abu;g_sha.h[7]=0x5be0cd19u;
    g_sha.total=0;g_sha.buflen=0; return 1;
}
/* 输入为 g_io[off..off+len] 的二进制原始字节（非 hex）。 */
extern "C" int xn_shaupd(int off,int len){
    const u8* p=(const u8*)xn_io_ptr()+off;
    g_sha.total+=len;
    while(len>0){int take=64-g_sha.buflen; if(take>len)take=len;
      for(int i=0;i<take;i++)g_sha.buf[g_sha.buflen+i]=p[i];
      g_sha.buflen+=take;p+=take;len-=take;
      if(g_sha.buflen==64){sha_compress(&g_sha,g_sha.buf);g_sha.buflen=0;}}
    return 1;
}
extern "C" int xn_shafin(int out){
    u64 bits=g_sha.total*8ull;
    g_sha.buf[g_sha.buflen++]=0x80;
    if(g_sha.buflen>56){while(g_sha.buflen<64)g_sha.buf[g_sha.buflen++]=0;sha_compress(&g_sha,g_sha.buf);g_sha.buflen=0;}
    while(g_sha.buflen<56)g_sha.buf[g_sha.buflen++]=0;
    for(int i=0;i<8;i++)g_sha.buf[56+i]=(u8)(bits>>(56-8*i));
    sha_compress(&g_sha,g_sha.buf);
    static const char HEX[]="0123456789abcdef";
    u8* o=(u8*)xn_io_ptr()+out;
    for(int i=0;i<8;i++)for(int j=0;j<4;j++){u8 b=(u8)(g_sha.h[i]>>(24-8*j));o[8*i+2*j]=(u8)HEX[b>>4];o[8*i+2*j+1]=(u8)HEX[b&15];}
    return 64;
}
