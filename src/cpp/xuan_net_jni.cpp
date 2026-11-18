// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
/*
 * 小轩音乐 · C++ 网络层 JNI 桥（Android 原生 SO）
 * ------------------------------------------------------------------
 * 安全整改 M4：网络密码学从「内嵌 WASM 的 C++」升级为「真实 .cpp 源码
 * + NDK 编译的 libxuan_net.so」。本文件把 xuan_net.cpp 里的 xn_* 导出函数
 * 包装成一个统一 JNI 入口，供 Kotlin(XuanCryptoBridge) 经 JNI 调用，再经
 * Capacitor 插件(XuanNativePlugin.netCrypto) 暴露给 JS。
 *
 * 算法实现仍只有 xuan_net.cpp 一份，SO / WASM / 桌面端共用同一份源码，
 * 保证协议字节完全一致；区别只是 Android 运行时不再加载任何内联 WASM。
 *
 * 统一入口：nativeCrypto(op, args[]) -> String
 *   op = sha|shab|hmac|route|boot|cteq|auth|aes|rng|shainit|shaupd|shafin|decl|version
 * 输入输出现用 xuan_net.cpp 的 262144 字节 g_io（2026-11-18 扩充）：
 *   参数 i 写入 slot i*32768（每槽 32KB，足够放长 Cookie/身份快照），
 *   结果统一从 OUT=229376 读回；子密钥临时区在 C++ 内部 258048。
 *   这样长 body 的 SHA-256/HMAC 也走原生，JS 侧无需任何 Web Crypto 兜底。
 */
#include <jni.h>
#include <string.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

/* xuan_net.cpp 的 extern "C" 导出（两个 .cpp 一起编进同一个 .so） */
extern "C" {
    void* xn_io_ptr(void);
    int xn_sha_hex(int off, int len, int out);
    int xn_sha_hexbytes(int off, int len, int out);
    int xn_hmac_hex(int koff, int klen, int moff, int mlen, int out);
    int xn_route_key(int off, int len, int out);
    int xn_boot_verify(int coff, int clen, int soff, int slen, int koff, int klen);
    int xn_ct_eq(int aoff, int alen, int boff, int blen);
    int xn_build_auth(int koff, int klen, int tsoff, int tslen, int noff, int nlen,
                      int poff, int plen, int hoff, int hlen, int secoff, int seclen,
                      int vcoff, int vclen, int out);
    int xn_network_layer(int out);
    int xn_version(void);
    int xn_aes_gcm_enc(int koff, int klen, int ioff, int ilen, int poff, int plen, int out);
    int xn_rng(int out, int n);
    int xn_shainit(void);
    int xn_shaupd(int off, int len);
    int xn_shafin(int out);
}

#define SLOT(i) ((i) * 32768)
#define OUT    229376

/* 把 Java 字符串写进 g_io 的 slot，返回字节数（截断到槽容量-8 以留足边界）。 */
static int put_arg(JNIEnv* e, jobjectArray args, int idx) {
    if (idx >= e->GetArrayLength(args)) return 0;
    jstring s = (jstring)e->GetObjectArrayElement(args, idx);
    if (!s) return 0;
    const char* c = e->GetStringUTFChars(s, 0);
    int n = (int)strlen(c);
    if (n > 32760) n = 32760;
    memcpy((unsigned char*)xn_io_ptr() + SLOT(idx), c, n);
    e->ReleaseStringUTFChars(s, c);
    e->DeleteLocalRef(s);
    return n;
}

/* 从 OUT 读 n 字节 ASCII 作为 Java String */
static jstring take(JNIEnv* e, int n) {
    char buf[32768];
    if (n < 0) n = 0;
    if (n > (int)sizeof(buf) - 1) n = (int)sizeof(buf) - 1;
    memcpy(buf, (unsigned char*)xn_io_ptr() + OUT, n);
    buf[n] = 0;
    return e->NewStringUTF(buf);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_music_xuan_XuanCryptoBridge_nativeCrypto(
        JNIEnv* e, jclass /*clazz*/, jstring jop, jobjectArray args) {
    if (!jop) return e->NewStringUTF("");
    const char* op = e->GetStringUTFChars(jop, 0);

    if (!strcmp(op, "sha")) {
        int l0 = put_arg(e, args, 0);
        xn_sha_hex(SLOT(0), l0, OUT);
        e->ReleaseStringUTFChars(jop, op);
        return take(e, 64);
    }
    if (!strcmp(op, "shab")) {
        /* 输入 hex 文本 -> 解码字节 -> SHA-256；用于二进制切片哈希 */
        int l0 = put_arg(e, args, 0);
        int n = xn_sha_hexbytes(SLOT(0), l0, OUT);
        e->ReleaseStringUTFChars(jop, op);
        return take(e, n == 64 ? 64 : 0);
    }
    if (!strcmp(op, "hmac")) {
        int l0 = put_arg(e, args, 0);
        int l1 = put_arg(e, args, 1);
        xn_hmac_hex(SLOT(0), l0, SLOT(1), l1, OUT);
        e->ReleaseStringUTFChars(jop, op);
        return take(e, 64);
    }
    if (!strcmp(op, "route")) {
        int l0 = put_arg(e, args, 0);
        xn_route_key(SLOT(0), l0, OUT);
        e->ReleaseStringUTFChars(jop, op);
        return take(e, 12);
    }
    if (!strcmp(op, "boot")) {
        int l0 = put_arg(e, args, 0);   /* canon */
        int l1 = put_arg(e, args, 1);   /* sig (64 hex) */
        int l2 = put_arg(e, args, 2);   /* secret */
        int r = xn_boot_verify(SLOT(0), l0, SLOT(1), l1, SLOT(2), l2);
        e->ReleaseStringUTFChars(jop, op);
        return e->NewStringUTF(r == 1 ? "1" : "0");
    }
    if (!strcmp(op, "cteq")) {
        int l0 = put_arg(e, args, 0);
        int l1 = put_arg(e, args, 1);
        int r = xn_ct_eq(SLOT(0), l0, SLOT(1), l1);
        e->ReleaseStringUTFChars(jop, op);
        return e->NewStringUTF(r == 1 ? "1" : "0");
    }
    if (!strcmp(op, "auth")) {
        /* 7 个输入：key,ts,nonce,path,bodyHash,secret,vc —— 与 TS 的 BA_* 布局一致 */
        int l0 = put_arg(e, args, 0);   /* key       -> slot 0    */
        int l1 = put_arg(e, args, 1);   /* ts        -> slot 1024 */
        int l2 = put_arg(e, args, 2);   /* nonce     -> slot 2048 */
        int l3 = put_arg(e, args, 3);   /* path      -> slot 3072 */
        int l4 = put_arg(e, args, 4);   /* bodyHash  -> slot 4096 */
        int l5 = put_arg(e, args, 5);   /* secret    -> slot 5120 */
        int l6 = put_arg(e, args, 6);   /* vc        -> slot 6144 */
        int n = xn_build_auth(
            SLOT(0), l0, SLOT(1), l1, SLOT(2), l2, SLOT(3), l3,
            SLOT(4), l4, SLOT(5), l5, SLOT(6), l6, OUT);
        e->ReleaseStringUTFChars(jop, op);
        if (n != 256) return e->NewStringUTF("");
        return take(e, 256);   /* sign/cal/seq/loc 各 64 hex 拼接 */
    }
    if (!strcmp(op, "aes")) {
        /* AES-256-GCM 加密：args = [keyHex(64), ivHex(24), plainHex]
         * 返回 base64(iv||ct||tag)，与服务端 cryptography.AESGCM 字节兼容。 */
        int l0 = put_arg(e, args, 0);   /* key hex  -> slot 0  */
        int l1 = put_arg(e, args, 1);   /* iv hex   -> slot 1  */
        int l2 = put_arg(e, args, 2);   /* plain hex-> slot 2  */
        int n = xn_aes_gcm_enc(SLOT(0), l0, SLOT(1), l1, SLOT(2), l2, OUT);
        e->ReleaseStringUTFChars(jop, op);
        return take(e, n);
    }
    if (!strcmp(op, "shainit")) {
        xn_shainit();
        e->ReleaseStringUTFChars(jop, op);
        return e->NewStringUTF("1");
    }
    if (!strcmp(op, "shaupd")) {
        /* args = [blockHex]；就地 hex 解码为二进制后喂入增量 SHA。 */
        int l0 = put_arg(e, args, 0);
        unsigned char* io = (unsigned char*)xn_io_ptr() + SLOT(0);
        int n = 0;
        for (int i = 0; i + 1 < l0; i += 2) {
            auto nib = [](unsigned char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                return -1;
            };
            int hi = nib(io[i]), lo = nib(io[i+1]);
            if (hi < 0 || lo < 0) break;
            io[n++] = (unsigned char)((hi << 4) | lo);
        }
        xn_shaupd(SLOT(0), n);
        e->ReleaseStringUTFChars(jop, op);
        return e->NewStringUTF("1");
    }
    if (!strcmp(op, "shafin")) {
        int n = xn_shafin(OUT);
        e->ReleaseStringUTFChars(jop, op);
        return take(e, n);
    }
    if (!strcmp(op, "rng")) {
        /* CSPRNG：args = [n]，返回 n 字节随机数的 hex（2n 字符）。 */
        int l0 = put_arg(e, args, 0);
        int n = 32;
        if (l0 > 0) {
            const char* s = (const char*)xn_io_ptr() + SLOT(0);
            n = atoi(s);
            if (n < 1 || n > 4096) n = 32;
        }
        int r = xn_rng(OUT, n);
        unsigned char* p = (unsigned char*)xn_io_ptr() + OUT;
        char outhex[8192];
        static const char HEX[] = "0123456789abcdef";
        for (int i = 0; i < r; i++) { outhex[2*i] = HEX[p[i]>>4]; outhex[2*i+1] = HEX[p[i]&15]; }
        outhex[2*r] = 0;
        e->ReleaseStringUTFChars(jop, op);
        return e->NewStringUTF(outhex);
    }
    if (!strcmp(op, "decl")) {
        int n = xn_network_layer(OUT);
        e->ReleaseStringUTFChars(jop, op);
        return take(e, n);
    }
    if (!strcmp(op, "version")) {
        e->ReleaseStringUTFChars(jop, op);
        char v[16];
        snprintf(v, sizeof(v), "%d", xn_version());
        return e->NewStringUTF(v);
    }

    e->ReleaseStringUTFChars(jop, op);
    return e->NewStringUTF("");
}

extern "C" __attribute__((used)) const char XUAN_WM_6743b57d73ed[] = "XUANSRC|__XUAN_SERVER_BASE__|6743b57d73ed|38c6561f072f";
