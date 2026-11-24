// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
/*
 * 小轩音乐 · C++ 音效 DSP + 播放器页渲染引擎
 * ---------------------------------------------------------------------------
 * 这是移动端(Android/Capacitor WebView)与桌面端(Electron/Chromium)共用的
 * 唯一一份 C++ 源码，经 clang --target=wasm32 编译为 xuan_engine.wasm：
 *
 *   - 音效：preamp -> bt(低/高搁架) -> 10 段参数 EQ -> DRC -> 空间/混响 -> 限幅
 *           全部在 C++ 中对 PCM 逐采样（IIR Biquad）计算，不依赖任何 Web Audio
 *           滤波节点，也不调用系统均衡器。
 *   - 渲染：正在播放页的频谱柱 / 波形 / 光晕 / 粒子逐像素写入 RGBA 帧缓冲，
 *           由前端 Canvas.putImageData 呈现；像素由本 C++ 生成。
 *   - 音效设计：低音只来自所选预设，不再常驻隐藏超重低音层（避免多层叠加产生糊感）。
 *           选「超重低音」即一层超重低音；选其他预设用各自曲线，不额外叠加低音；
 *           音效关闭则透明直通。3D / 全景 / 震撼环绕等空间预设带真实交叉馈送(wet>0)。
 *
 * 零依赖：不 link libm / libc，所有数学函数自包含实现，编译产物不含任何
 * WASM import（用 `wasm-objdump -x` 可验证），因此任意 WebView / Electron
 * 版本都能直接 WebAssembly.instantiate，无需提供 env 导入。
 *
 * 构建见同目录 build_wasm.sh。
 */
typedef float f32;
typedef int i32;
typedef unsigned char u8;
typedef unsigned int u32;
typedef unsigned long usize;

/* -nostdlib 下 clang 仍会把批量清零优化成对 memset 的调用，进而产生 WASM import。
 * 自己提供实现，保证编译产物零 import（任意 WebView 可直接 instantiate）。 */
extern "C" {
    void *memset(void *dst, i32 c, usize n) {
        u8 *p = (u8 *)dst;
        for (usize i = 0; i < n; i++) p[i] = (u8)c;
        return dst;
    }
    void *memcpy(void *dst, const void *src, usize n) {
        u8 *d = (u8 *)dst; const u8 *s = (const u8 *)src;
        for (usize i = 0; i < n; i++) d[i] = s[i];
        return dst;
    }
    void *memmove(void *dst, const void *src, usize n) {
        u8 *d = (u8 *)dst; const u8 *s = (const u8 *)src;
        if (d < s) { for (usize i = 0; i < n; i++) d[i] = s[i]; }
        else { for (usize i = n; i > 0; i--) d[i - 1] = s[i - 1]; }
        return dst;
    }
}

#define XPI 3.14159265358979323846f
#define MAX_FRAMES 2048
#define MAX_BANDS 64
#define FRAME_W 480
#define FRAME_H 270
#define FRAME_BYTES (FRAME_W * FRAME_H * 4)
#define NBQ 10
#define DLY 512

/* ------------------------------------------------------------------ 自包含数学 */
static inline f32 f_abs(f32 x) { return x < 0 ? -x : x; }
static inline f32 f_min(f32 a, f32 b) { return a < b ? a : b; }
static inline f32 f_max(f32 a, f32 b) { return a > b ? a : b; }
static inline f32 f_clamp(f32 x, f32 lo, f32 hi) { return x < lo ? lo : (x > hi ? hi : x); }

static f32 f_sqrt(f32 x) {
    if (x <= 0) return 0;
    f32 r = x > 1 ? x * 0.5f : 0.5f;
    for (int i = 0; i < 14; i++) r = 0.5f * (r + x / r);
    return r;
}

static f32 f_sin(f32 x) {
    const f32 two = 2 * XPI;
    while (x > XPI) x -= two;
    while (x < -XPI) x += two;
    if (x > XPI * 0.5f) x = XPI - x;
    else if (x < -XPI * 0.5f) x = -XPI - x;
    f32 x2 = x * x;
    return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72))));
}
static f32 f_cos(f32 x) { return f_sin(x + XPI * 0.5f); }

/* |x| < 2 的 e^x 泰勒（Horner），用于 dB->linear 与 DRC 系数，精度足够 */
static f32 f_exp_small(f32 x) {
    return 1 + x * (1 + x * (0.5f + x * (0.16666667f + x * (0.041666667f
        + x * (0.0083333335f + x * (0.0013888889f + x * (0.00019841270f
        + x * (0.000024801587f + x * 0.0000027557319f))))))));
}
static f32 f_pow10(f32 x) { return f_exp_small(x * 2.302585093f); }

/* Pade 近似 tanh，用于软限幅，避免引入 exp */
static f32 f_tanh(f32 x) {
    if (x > 3) return 1;
    if (x < -3) return -1;
    f32 x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
}

/* 软限幅（真正的限幅器，而非整段 tanh 失真）：
 *   |x| <= 0.92  → 完全线性，零失真（绝大多数节目素材落在此区间，声音干净）；
 *   |x| >  0.92  → 用 tanh 平滑饱和到 ±0.999 硬顶，绝不超 1.0，杜绝数字削波破音。
 * 旧实现 f_tanh(x*1.35) 对 ~0.37 以上信号就开始 tanh 染色，叠加两层超重低音后
 * 瞬态极易越过该区间 → 偶发「爆音」。新逻辑把线性区拓宽到 0.92，爆音随之消失。 */
static inline f32 xe_limiter(f32 x) {
    const f32 thr = 0.92f;
    const f32 ceil = 0.999f;
    const f32 k = 1.0f / (ceil - thr);
    if (x > thr)  return thr + (ceil - thr) * f_tanh((x - thr) * k);
    if (x < -thr) return -thr - (ceil - thr) * f_tanh((-x - thr) * k);
    return x;
}

/* ------------------------------------------------------------------ Biquad IIR */
struct Biquad { f32 b0, b1, b2, a1, a2, x1, x2, y1, y2; };
static inline void bq_reset(Biquad *q) { q->x1 = q->x2 = q->y1 = q->y2 = 0; }
static inline f32 bq_run(Biquad *q, f32 x) {
    f32 y = q->b0 * x + q->b1 * q->x1 + q->b2 * q->x2 - q->a1 * q->y1 - q->a2 * q->y2;
    q->x2 = q->x1; q->x1 = x; q->y2 = q->y1; q->y1 = y;
    return y;
}
static void bq_norm(Biquad *q, f32 b0, f32 b1, f32 b2, f32 a0, f32 a1, f32 a2) {
    f32 inv = 1 / a0;
    q->b0 = b0 * inv; q->b1 = b1 * inv; q->b2 = b2 * inv;
    q->a1 = a1 * inv; q->a2 = a2 * inv;
    bq_reset(q);
}
static void bq_peaking(Biquad *q, f32 fs, f32 f0, f32 Q, f32 dB) {
    f32 A = f_pow10(dB / 40);
    f32 w = 2 * XPI * f0 / fs, c = f_cos(w), s = f_sin(w);
    f32 alpha = s / (2 * Q);
    bq_norm(q, 1 + alpha * A, -2 * c, 1 - alpha * A,
            1 + alpha / A, -2 * c, 1 - alpha / A);
}
static void bq_lowshelf(Biquad *q, f32 fs, f32 f0, f32 dB) {
    f32 A = f_pow10(dB / 40), sqA = f_sqrt(A);
    f32 w = 2 * XPI * f0 / fs, c = f_cos(w), s = f_sin(w);
    f32 alpha = s * 0.5f * f_sqrt(2.0f); /* S=1 */
    bq_norm(q,
        A * ((A + 1) - (A - 1) * c + 2 * sqA * alpha),
        2 * A * ((A - 1) - (A + 1) * c),
        A * ((A + 1) - (A - 1) * c - 2 * sqA * alpha),
        (A + 1) + (A - 1) * c + 2 * sqA * alpha,
        -2 * ((A - 1) + (A + 1) * c),
        (A + 1) + (A - 1) * c - 2 * sqA * alpha);
}
static void bq_highshelf(Biquad *q, f32 fs, f32 f0, f32 dB) {
    f32 A = f_pow10(dB / 40), sqA = f_sqrt(A);
    f32 w = 2 * XPI * f0 / fs, c = f_cos(w), s = f_sin(w);
    f32 alpha = s * 0.5f * f_sqrt(2.0f);
    bq_norm(q,
        A * ((A + 1) + (A - 1) * c + 2 * sqA * alpha),
        -2 * A * ((A - 1) + (A + 1) * c),
        A * ((A + 1) + (A - 1) * c - 2 * sqA * alpha),
        (A + 1) - (A - 1) * c + 2 * sqA * alpha,
        2 * ((A - 1) - (A + 1) * c),
        (A + 1) - (A - 1) * c - 2 * sqA * alpha);
}

/* ------------------------------------------------------------------ 预设表（唯一 DSP 参数源，两端共用） */
struct Preset {
    f32 btB, btT, eq[NBQ];
    f32 thr, ratio, atk, rel;
    f32 se, wet;
    int drcOn;
};
static const f32 EQ_FREQ[NBQ] = { 31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 };
/* 按用户提供的系统均衡器截图工程化后的「超重低音」等效曲线（dB） */
static const f32 SUPER_BASS[NBQ] = { 3, 4, 6, 6, -4, -4, 1, 1, 0, 0 };

static const Preset PRESETS[8] = {
    /* 0 off          */ { 0, 0, {0,0,0,0,0,0,0,0,0,0},                -18, 3,   .008f, .15f, 0, 0,   0 },
    /* 1 superBass    */ { 9, -6, {5,7,9,8,-4,-4,1,1,0,0},             -18, 5,   .005f, .20f, 8, .18f, 1 },
    /* 2 clearVocal   */ { 0, 6, {-3,-2.5f,-3.5f,-2.5f,-1.5f,2.5f,5,3,2,1}, -18, 2, .01f, .10f, 0, .08f, 1 },
    /* 3 surround3d   */ { 0, 2, {-1,-1,-2,-2.5f,-1,1.5f,2.5f,2.5f,1.5f,1}, -18, 3, .008f, .15f, 6, .32f, 1 },
    /* 4 panoramic    */ { 2, 2.5f, {1.5f,1,0,-1,-1,1.5f,2.5f,3.5f,3,2},  -18, 2, .01f, .15f, 5, .26f, 1 },
    /* 5 hdVocal      */ { -1, 3, {-2.5f,-2,-3,-2.5f,-1,4,6,4.5f,3,2},   -18, 2, .01f, .10f, 0, 0,   1 },
    /* 6 hifiLive     */ { 2.5f, 2, {3.5f,2.5f,1.5f,-1,-1,2,3.5f,4.5f,3.5f,2.5f}, -18, 2, .01f, .18f, 3, .18f, 1 },
    /* 7 immersive    */ { 5.5f, 2.5f, {6,5,3,-1.5f,-1.5f,2.5f,4,5,3.5f,2.5f}, -18, 4, .005f, .20f, 7, .30f, 1 },
};

/* ------------------------------------------------------------------ 全局状态 & 内存（导出指针偏移） */
static f32 g_pcmL[MAX_FRAMES], g_pcmR[MAX_FRAMES];
static f32 g_spec[MAX_BANDS];
static u8  g_frame[FRAME_BYTES];

static Biquad g_btB[2], g_btT[2], g_eq[2][NBQ];
static f32 g_preamp = 1;
static f32 g_outGain = 1.35f;
static i32 g_enabled = 0;
static f32 g_drcEnv = 0, g_drcAtk = 0.9f, g_drcRel = 0.99f, g_drcThr = 0.126f, g_drcRatio = 3, g_drcOn = 1;
static f32 g_se = 0, g_wet = 0;
static f32 g_dlyL[DLY], g_dlyR[DLY];
static int g_dlyIdx = 0;
static i32 g_sr = 44100;

extern "C" {
    void xe_reset_state();  /* 前置声明：xe_init 需要调用 */

    i32 xe_pcm_l_ptr() { return (i32)(u32)(void *)g_pcmL; }
    i32 xe_pcm_r_ptr() { return (i32)(u32)(void *)g_pcmR; }
    i32 xe_spec_ptr()  { return (i32)(u32)(void *)g_spec; }
    i32 xe_frame_ptr() { return (i32)(u32)(void *)g_frame; }
    i32 xe_frame_w()   { return FRAME_W; }
    i32 xe_frame_h()   { return FRAME_H; }

    /* 低音只来自所选预设：不再常驻隐藏超重低音，避免多层叠加产生糊感。
     * 选「超重低音」= 一层超重低音；选其他预设 = 各自曲线，不额外叠加低音；
     * 音效关闭 = 透明直通（无 EQ / 无低音）。 */
    void xe_set_state(i32 enabled, i32 presetId) {
        if (presetId < 0 || presetId > 7) presetId = 0;
        f32 btB = 0, btT = 0, eq[NBQ];
        for (int i = 0; i < NBQ; i++) eq[i] = 0;

        f32 thr = -18, ratio = 3, atk = 0.008f, rel = 0.15f, se = 0, wet = 0;
        int drcOn = 1;
        g_enabled = 1; /* 处理链始终运行；关闭音效时 EQ 全 0，等效透明直通 */
        if (enabled && presetId != 0) {
            /* 开启音效：直接应用用户所选预设（其低音曲线仅此一层）。 */
            const Preset &p = PRESETS[presetId];
            btB += p.btB; btT += p.btT;
            for (int i = 0; i < NBQ; i++) eq[i] += p.eq[i];
            thr = p.thr; ratio = p.ratio; atk = p.atk; rel = p.rel;
            se = p.se; wet = p.wet; drcOn = p.drcOn;
        }

        /* 温和前置增益：只对最大正增益做部分补偿，避免整体被压得过小
         * （旧实现按全量补偿 + 额外 -1dB，导致要开到最大音量才听得清）。
         * 后端软限幅负责防削波，因此这里可以保留充足响度。 */
        f32 maxGain = 0;
        for (int i = 0; i < NBQ; i++) if (eq[i] > maxGain) maxGain = eq[i];
        if (btB > maxGain) maxGain = btB;
        if (btT > maxGain) maxGain = btT;
        g_preamp = f_pow10((-f_max(0, maxGain) * 0.35f) / 20);
        /* 基础输出增益：正常音量即可听清，无需把音量/音效拉满 */
        g_outGain = 1.35f;

        for (int ch = 0; ch < 2; ch++) {
            bq_lowshelf(&g_btB[ch], (f32)g_sr, 90, btB);
            bq_highshelf(&g_btT[ch], (f32)g_sr, 9000, btT);
            for (int i = 0; i < NBQ; i++)
                bq_peaking(&g_eq[ch][i], (f32)g_sr, EQ_FREQ[i], 1.2f, eq[i]);
        }
        g_drcThr = f_pow10(thr / 20);
        g_drcRatio = ratio > 1 ? ratio : 1;
        /* 限幅器攻击需足够快：把预设攻击时间钳到 <=1.2ms，确保瞬态（鼓点/起音）也能被及时压住，
         * 避免瞬态未被压缩就冲进限幅器造成爆音；释放时间沿用预设。 */
        g_drcAtk = 1 - f_exp_small(-1.0f / (f_min(atk, 0.0012f) * (f32)g_sr));
        g_drcRel = 1 - f_exp_small(-1.0f / (rel * (f32)g_sr));
        g_drcOn = drcOn;
        g_se = se;
        g_wet = wet;
    }

    void xe_init(i32 sampleRate) {
        g_sr = sampleRate > 0 ? sampleRate : 44100;
        xe_reset_state();
        xe_set_state(0, 0);
    }

    /* 切回前台 / 恢复播放时调用：清空所有滤波器历史、DRC 包络与混响延迟线，
     * 避免挂起→恢复时状态突变产生「爆音」。 */
    void xe_reset_state() {
        g_drcEnv = 0;
        for (int i = 0; i < DLY; i++) { g_dlyL[i] = 0; g_dlyR[i] = 0; }
        g_dlyIdx = 0;
        for (int ch = 0; ch < 2; ch++) {
            bq_reset(&g_btB[ch]); bq_reset(&g_btT[ch]);
            for (int i = 0; i < NBQ; i++) bq_reset(&g_eq[ch][i]);
        }
    }

    static f32 run_chain(int ch, f32 x) {
        x = bq_run(&g_btB[ch], x);
        x = bq_run(&g_btT[ch], x);
        for (int i = 0; i < NBQ; i++) x = bq_run(&g_eq[ch][i], x);
        return x;
    }

    /* 对 g_pcmL/g_pcmR 就地处理 n 帧（C++ 完成整条 DSP 链） */
    void xe_process(i32 n) {
        if (n > MAX_FRAMES) n = MAX_FRAMES;
        for (int i = 0; i < n; i++) {
            f32 L = g_pcmL[i] * g_preamp;
            f32 R = g_pcmR[i] * g_preamp;
            L = run_chain(0, L);
            R = run_chain(1, R);

            /* DRC：立体声链接峰值包络 + 前馈软压缩 */
            f32 peak = f_max(f_abs(L), f_abs(R));
            f32 coef = peak > g_drcEnv ? g_drcAtk : g_drcRel;
            g_drcEnv = coef * peak + (1 - coef) * g_drcEnv;
            if (g_drcOn && g_drcEnv > g_drcThr) {
                f32 g = (g_drcThr + (g_drcEnv - g_drcThr) / g_drcRatio) / g_drcEnv;
                L *= g; R *= g;
            }

            /* 双扬声器环绕：mid/side 展宽 + 对侧延迟交叉馈送(Haas 空间化) */
            f32 mid = (L + R) * 0.5f;
            f32 side = (L - R) * 0.5f * (1 + g_se * 0.06f);
            f32 nl = mid + side, nr = mid - side;
            g_dlyL[g_dlyIdx] = nl;
            g_dlyR[g_dlyIdx] = nr;
            int rdL = (g_dlyIdx + 110) & (DLY - 1);
            int rdR = (g_dlyIdx + 53) & (DLY - 1);
            f32 dl = g_dlyL[rdL], dr = g_dlyR[rdR];
            L = nl + g_wet * dr * 0.55f;
            R = nr + g_wet * dl * 0.55f;
            g_dlyIdx = (g_dlyIdx + 1) & (DLY - 1);

            /* 基础增益 + 软限幅：正常音量即可听清；线性区零失真，仅极端峰值被温柔限制，杜绝爆音 */
            g_pcmL[i] = xe_limiter(L * g_outGain);
            g_pcmR[i] = xe_limiter(R * g_outGain);
        }
    }

    /* -------- 播放器页渲染：逐像素写 RGBA 帧缓冲（频谱 / 波形 / 光晕 / 粒子） -------- */
    void xe_render(i32 w, i32 h, f32 t, i32 bands) {
        if (w > FRAME_W) w = FRAME_W;
        if (h > FRAME_H) h = FRAME_H;
        if (bands > MAX_BANDS) bands = MAX_BANDS;
        if (bands < 1) bands = 1;
        f32 pulse = 0.5f + 0.5f * f_sin(t * 0.9f);

        for (int y = 0; y < h; y++) {
            f32 vy = (f32)y / (f32)h;
            for (int x = 0; x < w; x++) {
                int idx = (y * w + x) * 4;
                f32 ux = (f32)x / (f32)w - 0.5f;
                f32 uy = vy - 0.5f;
                f32 d = f_sqrt(ux * ux + uy * uy);
                f32 glow = (1 - f_min(1, d * 2.1f));
                f32 band = 0.5f + 0.5f * f_sin(uy * 9 + t * 0.4f);
                /* 深色渐变底 + 中心呼吸光晕（暖金/品红） */
                f32 r = 8 + glow * (46 + 24 * pulse) + band * 6;
                f32 g = 8 + glow * (18 + 10 * pulse);
                f32 b = 16 + glow * (52 + 20 * (1 - pulse));
                g_frame[idx] = (u8)f_clamp(r, 0, 255);
                g_frame[idx + 1] = (u8)f_clamp(g, 0, 255);
                g_frame[idx + 2] = (u8)f_clamp(b, 0, 255);
                g_frame[idx + 3] = 255;
            }
        }

        /* 频谱柱：读取前端从 AnalyserNode 灌入的 g_spec[] */
        f32 bw = (f32)w / (f32)bands;
        for (int k = 0; k < bands; k++) {
            f32 v = g_spec[k];
            if (v < 0) v = 0; if (v > 1) v = 1;
            int colH = (int)(v * (f32)h * 0.68f);
            int x0 = (int)(k * bw) + 1;
            int x1 = (int)((k + 1) * bw) - 1;
            if (x1 < x0) x1 = x0;
            for (int yy = h - colH; yy < h; yy++) {
                for (int xx = x0; xx <= x1; xx++) {
                    int idx = (yy * w + xx) * 4;
                    f32 fade = (f32)(h - yy) / (f32)f_max(1, h);
                    g_frame[idx] = (u8)f_clamp(232 - fade * 60, 0, 255);
                    g_frame[idx + 1] = (u8)f_clamp(178 + fade * 40, 0, 255);
                    g_frame[idx + 2] = (u8)f_clamp(76 + fade * 90, 0, 255);
                }
            }
        }

        /* 中线波形（随时间的正弦轨迹） */
        int midY = h / 2;
        for (int xx = 0; xx < w; xx++) {
            f32 ph = (f32)xx / (f32)w * 12 * XPI + t * 2.2f;
            int y = midY + (int)(f_sin(ph) * (4 + 10 * pulse));
            if (y >= 0 && y < h) {
                int idx = (y * w + xx) * 4;
                g_frame[idx] = 255; g_frame[idx + 1] = 236; g_frame[idx + 2] = 170;
            }
        }

        /* 旋转粒子 */
        for (int p = 0; p < 18; p++) {
            f32 a = (f32)p / 18 * 2 * XPI + t * (0.3f + 0.02f * p);
            f32 rad = 0.14f + 0.24f * (0.5f + 0.5f * f_sin(t * 0.5f + p));
            int px = (int)(w * (0.5f + f_cos(a) * rad));
            int py = (int)(h * (0.5f + f_sin(a) * rad * 1.6f));
            for (int oy = -1; oy <= 1; oy++) for (int ox = -1; ox <= 1; ox++) {
                int xx = px + ox, yy = py + oy;
                if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
                int idx = (yy * w + xx) * 4;
                g_frame[idx] = 255; g_frame[idx + 1] = 220; g_frame[idx + 2] = 150;
            }
        }
    }
}

extern "C" __attribute__((used)) const char XUAN_WM_b413c26d8d86[] = "XUANSRC|__XUAN_SERVER_BASE__|b413c26d8d86|5d226a28280b";
