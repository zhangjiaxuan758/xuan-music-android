// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
/*
 * 小轩音乐 · C++ 音效/渲染引擎 JNI 适配层（真自研 SO 后端）
 * ---------------------------------------------------------------------------
 * 核心算法在 xuan_engine_so.cpp（与 wasm 版同一份源码，一字不改，保证音效与像素一致）。
 * 本文件只做数据搬运：Java 层的 Float32Array / byte[] 与 so 内全局缓冲互拷。
 *
 * 依赖：仅 JNI（Android 系统）+ 核心算法（自写数学，无第三方库）。
 *
 * 如实标注：这是把「原本内嵌 WASM 的 C++ 引擎」升级为真 SO 的适配层。
 * 页面/音效不变由「核心算法一字不改 + 前端接口不变」共同保证。
 */
#include <jni.h>
#include <stdint.h>
#include <string.h>

/* 核心算法导出的 C 接口（来自 xuan_engine_so.cpp） */
extern "C" {
    void xe_init(int sampleRate);
    void xe_set_state(int enabled, int presetId);
    void xe_reset_state();
    void xe_process(int n);
    void xe_render(int w, int h, float t, int bands);
    float*  xe_pcm_l_ptr();
    float*  xe_pcm_r_ptr();
    float*  xe_spec_ptr();
    unsigned char* xe_frame_ptr();
    int xe_frame_w();
    int xe_frame_h();
}

#define ENGINE_PKG com_music_xuan_XuanEngineNative

extern "C" JNIEXPORT void JNICALL
Java_com_music_xuan_XuanEngineNative_nativeInit(JNIEnv*, jclass, jint sr){ xe_init(sr); }

extern "C" JNIEXPORT void JNICALL
Java_com_music_xuan_XuanEngineNative_nativeSetState(JNIEnv*, jclass, jint enabled, jint preset){ xe_set_state(enabled, preset); }

extern "C" JNIEXPORT void JNICALL
Java_com_music_xuan_XuanEngineNative_nativeResetState(JNIEnv*, jclass){ xe_reset_state(); }

/* 把 Java float[] 拷入 so 的 pcmL/pcmR，就地处理后拷回。n<=2048。 */
extern "C" JNIEXPORT void JNICALL
Java_com_music_xuan_XuanEngineNative_nativeProcess(JNIEnv* env, jclass, jfloatArray L, jfloatArray R, jint n){
    if(n <= 0 || n > 2048) return;
    jfloat* l = env->GetFloatArrayElements(L, NULL);
    jfloat* r = env->GetFloatArrayElements(R, NULL);
    if(!l || !r){ if(l) env->ReleaseFloatArrayElements(L, l, JNI_ABORT); if(r) env->ReleaseFloatArrayElements(R, r, JNI_ABORT); return; }
    float* pl = xe_pcm_l_ptr();
    float* pr = xe_pcm_r_ptr();
    memcpy(pl, l, (size_t)n * sizeof(float));
    memcpy(pr, r, (size_t)n * sizeof(float));
    xe_process(n);
    memcpy(l, pl, (size_t)n * sizeof(float));
    memcpy(r, pr, (size_t)n * sizeof(float));
    env->ReleaseFloatArrayElements(L, l, 0);
    env->ReleaseFloatArrayElements(R, r, 0);
}

/* 渲染一帧到 so 的 frame，再拷回 Java byte[]。 */
extern "C" JNIEXPORT void JNICALL
Java_com_music_xuan_XuanEngineNative_nativeRender(JNIEnv* env, jclass, jint w, jint h, jfloat t, jint bands, jbyteArray out){
    if(w <= 0 || h <= 0) return;
    xe_render(w, h, t, bands);
    int need = w * h * 4;
    jsize outLen = env->GetArrayLength(out);
    if(outLen < need) need = outLen;
    jbyte* dst = env->GetByteArrayElements(out, NULL);
    if(!dst) return;
    memcpy(dst, xe_frame_ptr(), (size_t)need);
    env->ReleaseByteArrayElements(out, dst, 0);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_music_xuan_XuanEngineNative_nativeFrameW(JNIEnv*, jclass){ return xe_frame_w(); }

extern "C" JNIEXPORT jint JNICALL
Java_com_music_xuan_XuanEngineNative_nativeFrameH(JNIEnv*, jclass){ return xe_frame_h(); }

extern "C" JNIEXPORT jstring JNICALL
Java_com_music_xuan_XuanEngineNative_nativeVersion(JNIEnv* env, jclass){
    /* 如实标注：真自研 SO 后端，核心算法与 wasm 版同源。 */
    return env->NewStringUTF("xuan-engine/1.0-native-so (same source as wasm core)");
}

extern "C" __attribute__((used)) const char XUAN_WM_95126794c331[] = "XUANSRC|__XUAN_SERVER_BASE__|95126794c331|c76d9cc02e8f";
