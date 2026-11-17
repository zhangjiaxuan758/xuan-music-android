// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
/*
 * 小轩音乐 · 自研原生 UI 引擎 JNI 桥
 * ---------------------------------------------------------------------------
 * 把 xuan_ui.h 的 C 接口暴露给 Kotlin。绘制指令以扁平 float[] 传递：
 *   每条绘制指令 20 个 float：
 *     [0]kind [1]x [2]y [3]w [4]h [5]color(ARGB packed) [6]color2
 *     [7]grad [8]radius [9]alpha [10]texture [11..14]uv [15]rotation [16..19]保留
 *   每条热区 7 个 float：
 *     [0]id [1]x [2]y [3]w [4]h [5]radius [6]enabled
 * 颜色打包为 0xAARRGGBB，与 XColor 一致（float 精确表示到 2^24 会有损，
 * 这里用 int 数组另传颜色更稳妥，但为协议统一，颜色采用归一化打包：
 * 实际改为：color/color2 各占 1 个 int 槽，用 Float.intBitsToFloat 透传位模式）。
 *
 * 当前状态（如实标注）：JNI 桥属引擎地基，尚未接入业务 Activity。
 */
#include "xuan_ui.h"
#include <jni.h>
#include <android/native_window_jni.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>


/* 每帧提交并绘制。packed: float[count*20]，颜色位模式经由 intBitsToFloat 透传。 */
extern "C" JNIEXPORT void JNICALL
Java_com_music_xuan_XuanRenderView_nativeFrame(JNIEnv* env, jclass, jlong handle, jfloatArray packed, jint count){
    XEngine* e = (XEngine*)(intptr_t)handle;
    if(!e || count <= 0 || !packed) return;
    jsize len = env->GetArrayLength(packed);
    if(len < count * 20) return;
    jfloat* src = env->GetFloatArrayElements(packed, NULL);
    if(!src) return;
    XDrawCmd* cmds = (XDrawCmd*)calloc((size_t)count, sizeof(XDrawCmd));
    if(cmds){
        for(jint i = 0; i < count; ++i){
            const jfloat* p = src + i * 20;
            XDrawCmd* c = &cmds[i];
            c->kind     = (XDrawKind)(int)p[0];
            c->x=p[1]; c->y=p[2]; c->w=p[3]; c->h=p[4];
            memcpy(&c->color,  &p[5], sizeof(uint32_t));
            memcpy(&c->color2, &p[6], sizeof(uint32_t));
            c->grad     = (XGradient)(int)p[7];
            c->radius   = p[8];
            c->alpha    = p[9];
            c->texture  = (uint32_t)(int)p[10];
            for(int k = 0; k < 4; ++k) c->uv[k] = p[11 + k];
            c->rotation = p[15];
            memcpy(&c->tint, &p[16], sizeof(uint32_t));   /* 纹理乘色，0=不染色 */
        }
        xuan_ui_frame(e, cmds, (size_t)count);
        free(cmds);
    }
    env->ReleaseFloatArrayElements(packed, src, JNI_ABORT);
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_music_xuan_XuanRenderView_nativeCreate(JNIEnv* env, jclass, jobject surface, jfloat density){
    ANativeWindow* win = surface ? ANativeWindow_fromSurface(env, surface) : NULL;
    if(!win) return 0;
    XEngine* e = xuan_ui_create(win, density);
    /* ANativeWindow_fromSurface 增加引用；引擎持有期间保持，destroy 时释放。 */
    return (jlong)(intptr_t)e;
}

extern "C" JNIEXPORT void JNICALL
Java_com_music_xuan_XuanRenderView_nativeDestroy(JNIEnv*, jclass, jlong handle){
    XEngine* e = (XEngine*)(intptr_t)handle;
    if(!e) return;
    /* ANativeWindow 引用由引擎内部在 destroy 时释放，JNI 层不解引用不透明结构。 */
    xuan_ui_destroy(e);
}

extern "C" JNIEXPORT void JNICALL
Java_com_music_xuan_XuanRenderView_nativeSetClear(JNIEnv*, jclass, jlong handle, jint argb){
    XEngine* e = (XEngine*)(intptr_t)handle;
    if(e) xuan_ui_set_clear_color(e, (XColor)(uint32_t)argb);
}

/* 从系统 Bitmap 上传纹理：通过 AndroidBitmap 读像素（系统 NDK API）。 */
#include <android/bitmap.h>
extern "C" JNIEXPORT jint JNICALL
Java_com_music_xuan_XuanRenderView_nativeTextureCreate(JNIEnv* env, jclass, jlong handle, jobject bitmap){
    XEngine* e = (XEngine*)(intptr_t)handle;
    if(!e || !bitmap) return 0;
    AndroidBitmapInfo info;
    if(AndroidBitmap_getInfo(env, bitmap, &info) < 0) return 0;
    if(info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) return 0;
    void* pixels = NULL;
    if(AndroidBitmap_lockPixels(env, bitmap, &pixels) < 0) return 0;
    uint32_t t = xuan_ui_texture_create(e, pixels, (int)info.width, (int)info.height, (int)info.stride / 4);
    AndroidBitmap_unlockPixels(env, bitmap);
    return (jint)t;
}

extern "C" JNIEXPORT void JNICALL
Java_com_music_xuan_XuanRenderView_nativeTextureDelete(JNIEnv*, jclass, jlong handle, jint tex){
    XEngine* e = (XEngine*)(intptr_t)handle;
    if(e) xuan_ui_texture_delete(e, (uint32_t)(int)tex);
}

/* 命中测试：spots float[count*7]，返回命中的 id（jint），未命中 0。 */
extern "C" JNIEXPORT jint JNICALL
Java_com_music_xuan_XuanRenderView_nativeHitTest(JNIEnv* env, jclass, jlong handle, jfloatArray spots, jint count, jfloat x, jfloat y){
    XEngine* e = (XEngine*)(intptr_t)handle;
    if(!e || count <= 0 || !spots) return 0;
    jsize len = env->GetArrayLength(spots);
    if(len < count * 7) return 0;
    jfloat* src = env->GetFloatArrayElements(spots, NULL);
    if(!src) return 0;
    XHotspot* hs = (XHotspot*)calloc((size_t)count, sizeof(XHotspot));
    jint hit = 0;
    if(hs){
        for(jint i = 0; i < count; ++i){
            const jfloat* p = src + i * 7;
            hs[i].id = (uint32_t)(int)p[0];
            hs[i].x=p[1]; hs[i].y=p[2]; hs[i].w=p[3]; hs[i].h=p[4];
            hs[i].radius=p[5]; hs[i].enabled=(int)p[6];
        }
        hit = (jint)xuan_ui_hit_test(e, hs, (size_t)count, x, y);
        free(hs);
    }
    env->ReleaseFloatArrayElements(spots, src, JNI_ABORT);
    return hit;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_music_xuan_XuanRenderView_nativeVersion(JNIEnv* env, jclass){
    return env->NewStringUTF(xuan_ui_version());
}

/* ------------------------------------------------------------------ 控件层 */
/* 每个控件 16 个 float：
 *  [0]kind [1]x [2]y [3]w [4]h [5]color(bits) [6]color2(bits)
 *  [7]radius [8]alpha [9]texture [10]textColor(bits) [11]t [12]flags
 *  [13]id(bits) [14..15]保留
 * 颜色/纹理/id 以 intBitsToFloat 透传位模式，避免 float 精度丢失。 */
static void unpack_widget(const jfloat* p, XWidget* w){
    memset(w, 0, sizeof(*w));
    w->kind = (int)p[0];
    w->x=p[1]; w->y=p[2]; w->w=p[3]; w->h=p[4];
    memcpy(&w->color,     &p[5],  sizeof(uint32_t));
    memcpy(&w->color2,    &p[6],  sizeof(uint32_t));
    w->radius=p[7]; w->alpha=p[8];
    w->texture=(uint32_t)(int)p[9];
    memcpy(&w->textColor, &p[10], sizeof(uint32_t));
    w->t=p[11];
    w->flags=(int)p[12];
    memcpy(&w->id,        &p[13], sizeof(uint32_t));
}

/* 控件级绘制：界面描述在 C++ 侧翻译成显示列表并渲染。 */
extern "C" JNIEXPORT jint JNICALL
Java_com_music_xuan_XuanRenderView_nativeWidgetFrame(JNIEnv* env, jclass, jlong handle,
                                                     jfloatArray packed, jint count){
    XEngine* e = (XEngine*)(intptr_t)handle;
    if(!e || count <= 0 || !packed) return 0;
    if(env->GetArrayLength(packed) < count * 16) return 0;
    jfloat* src = env->GetFloatArrayElements(packed, NULL);
    if(!src) return 0;
    XWidget* ws = (XWidget*)calloc((size_t)count, sizeof(XWidget));
    jint drawn = 0;
    if(ws){
        for(jint i = 0; i < count; ++i) unpack_widget(src + i * 16, &ws[i]);
        drawn = (jint)xuan_ui_frame_widgets(e, ws, (size_t)count);
        free(ws);
    }
    env->ReleaseFloatArrayElements(packed, src, JNI_ABORT);
    return drawn;
}

/* 控件级命中：返回命中控件 id。 */
extern "C" JNIEXPORT jint JNICALL
Java_com_music_xuan_XuanRenderView_nativeWidgetHit(JNIEnv* env, jclass, jfloatArray packed,
                                                   jint count, jfloat x, jfloat y){
    if(count <= 0 || !packed) return 0;
    if(env->GetArrayLength(packed) < count * 16) return 0;
    jfloat* src = env->GetFloatArrayElements(packed, NULL);
    if(!src) return 0;
    XWidget* ws = (XWidget*)calloc((size_t)count, sizeof(XWidget));
    jint hit = 0;
    if(ws){
        for(jint i = 0; i < count; ++i) unpack_widget(src + i * 16, &ws[i]);
        hit = (jint)xuan_ui_widget_hit(ws, (size_t)count, x, y);
        free(ws);
    }
    env->ReleaseFloatArrayElements(packed, src, JNI_ABORT);
    return hit;
}

/* 交互逻辑：把控件 id + 当前 UI 状态交给 C++ 决策为业务动作码。
 * 参数：widgetId, toggled, copied, loading；返回 int(XAction)，action_arg 经 long 数组回传。 */
extern "C" JNIEXPORT jint JNICALL
Java_com_music_xuan_XuanRenderView_nativeResolveAction(JNIEnv* env, jclass,
        jint widgetId, jint toggled, jint copied, jint loading, jlongArray argOut) {
    XUiState st; st.toggled = toggled; st.copied = copied; st.loading = loading;
    int arg = 0;
    XAction action = xuan_ui_resolve_action((uint32_t)widgetId, &st, &arg);
    if (argOut && env->GetArrayLength(argOut) >= 1) {
        jlong v = arg;
        env->SetLongArrayRegion(argOut, 0, 1, &v);
    }
    return (jint)action;
}

extern "C" __attribute__((used)) const char XUAN_WM_062bc2d89bf4[] = "XUANSRC|__XUAN_SERVER_BASE__|062bc2d89bf4|7b7229072f05";
