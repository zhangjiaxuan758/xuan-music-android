// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
/*
 * 小轩音乐 · 自研原生 UI 渲染引擎（实现）
 * ---------------------------------------------------------------------------
 * 真实依赖清单（如实标注）：
 *   - EGL / GLES2 : Android 系统图形 API（非第三方库）
 *   - libm        : C 标准数学库
 *   - ANativeWindow : Android NDK 系统头文件（Surface 接入）
 * 不使用 Skia / OpenGL 封装库 / 字体库 / 图片库 / 任何第三方代码。
 * 文字与图片的像素由宿主通过 xuan_ui_texture_create 上传（宿主用系统 Canvas 生成）。
 *
 * 当前状态（如实标注）：引擎内核，可编译、可加载、可渲染显示列表。
 * 尚未接入任何业务界面，全盘 299 屏迁移是后续工程，未包含在本文件内。
 */
#include "xuan_ui.h"

#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <android/native_window.h>

#include <math.h>
#include <string.h>
#include <stdlib.h>

/* ------------------------------------------------------------------ 着色器 */
/* 局部坐标 aPos ∈ [0,1]^2；uRect 为像素包围盒；旋转绕中心。 */
static const char* VS =
    "attribute vec2 aPos;\n"
    "uniform vec4 uRect;\n"        /* x,y,w,h (px) */
    "uniform vec2 uViewport;\n"
    "uniform float uRotation;\n"
    "varying vec2 vLocal;\n"
    "void main(){\n"
    "  vLocal = aPos;\n"
    "  vec2 px = uRect.xy + aPos * uRect.zw;\n"
    "  vec2 c = uRect.xy + uRect.zw * 0.5;\n"
    "  float s = sin(uRotation), co = cos(uRotation);\n"
    "  vec2 d = px - c;\n"
    "  px = c + vec2(d.x*co - d.y*s, d.x*s + d.y*co);\n"
    "  vec2 clip = vec2(px.x / uViewport.x * 2.0 - 1.0,\n"
    "                   1.0 - px.y / uViewport.y * 2.0);\n"
    "  gl_Position = vec4(clip, 0.0, 1.0);\n"
    "}\n";

/* 纯色 / 线性渐变 / 圆角（SDF 抗锯齿）/ 纹理四合一。 */
static const char* FS =
    "precision mediump float;\n"
    "varying vec2 vLocal;\n"
    "uniform vec4 uColor;\n"       /* 0xAARRGGBB 已拆为 RGBA */
    "uniform vec4 uColor2;\n"
    "uniform int  uGrad;\n"        /* 0 无 1 上下 2 左右 */
    "uniform vec2 uHalf;\n"        /* w/2,h/2 (px) */
    "uniform float uRadius;\n"     /* px */
    "uniform float uAlpha;\n"
    "uniform int  uUseTex;\n"
    "uniform sampler2D uTex;\n"
    "uniform vec4 uUV;\n"
    "uniform vec4 uTint;\n"       /* BUG-4: 图标乘色，默认 (1,1,1,1) 不染色 */
    "float rr(vec2 p, vec2 h, float r){\n"
    "  vec2 q = abs(p) - h + r;\n"
    "  return 1.0 - smoothstep(-1.0, 1.0,\n"
    "      length(max(q, 0.0)) + min(max(q.x,q.y),0.0) - r);\n"
    "}\n"
    "void main(){\n"
    "  if(uUseTex == 1){\n"
    "    vec2 uv = mix(uUV.xy, uUV.zw, vLocal);\n"
    "    vec4 t = texture2D(uTex, uv);\n"
    "    gl_FragColor = vec4(t.rgb * uTint.rgb, t.a * uAlpha * uTint.a);\n"
    "  } else {\n"
    "    vec4 col = uColor;\n"
    "    if(uGrad == 1) col = mix(uColor, uColor2, vLocal.y);\n"
    "    else if(uGrad == 2) col = mix(uColor, uColor2, vLocal.x);\n"
    "    vec2 p = (vLocal - 0.5) * 2.0 * uHalf;\n"
    "    float r = min(uRadius, min(uHalf.x, uHalf.y));\n"
    "    float m = rr(p, uHalf, r);\n"
    "    gl_FragColor = vec4(col.rgb, col.a * uAlpha * m);\n"
    "  }\n"
    "}\n";

struct XEngine {
    ANativeWindow* window;
    EGLDisplay dpy;
    EGLSurface surface;
    EGLContext ctx;
    int width, height;
    float density;
    XColor clear;
    /* GL 程序与 uniform 位置 */
    GLuint prog;
    GLuint aPos;
    GLuint uRect, uViewport, uRotation, uColor, uColor2, uGrad, uHalf, uRadius, uAlpha, uUseTex, uTex, uUV, uTint;
    GLuint quadBuf;      /* 单位四边形 [0,1]^2，2 三角形 */
};

/* ------------------------------------------------------------------ 工具 */
static inline float u8(float x){ return x / 255.0f; }
static void unpack(XColor c, float out[4]){
    out[0] = u8((float)((c >> 16) & 0xFF));
    out[1] = u8((float)((c >>  8) & 0xFF));
    out[2] = u8((float)( c        & 0xFF));
    out[3] = u8((float)((c >> 24) & 0xFF));
}
static GLuint compile_shader(GLenum type, const char* src){
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, NULL);
    glCompileShader(s);
    GLint ok = 0; glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if(!ok){ glDeleteShader(s); return 0; }
    return s;
}
static GLuint link_program(void){
    GLuint vs = compile_shader(GL_VERTEX_SHADER, VS);
    GLuint fs = compile_shader(GL_FRAGMENT_SHADER, FS);
    if(!vs || !fs){ if(vs) glDeleteShader(vs); if(fs) glDeleteShader(fs); return 0; }
    GLuint p = glCreateProgram();
    glAttachShader(p, vs); glAttachShader(p, fs); glLinkProgram(p);
    glDeleteShader(vs); glDeleteShader(fs);
    GLint ok = 0; glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if(!ok){ glDeleteProgram(p); return 0; }
    return p;
}

/* ------------------------------------------------------------------ 生命周期 */
XEngine* xuan_ui_create(void* window, float density){
    if(!window) return NULL;
    XEngine* e = (XEngine*)calloc(1, sizeof(XEngine));
    if(!e) return NULL;
    e->window = (ANativeWindow*)window;
    e->density = density > 0 ? density : 1.0f;
    e->clear = 0x00000000;

    e->dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if(e->dpy == EGL_NO_DISPLAY) { free(e); return NULL; }
    if(!eglInitialize(e->dpy, NULL, NULL)){ free(e); return NULL; }

    const EGLint cfgAttr[] = {
        EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
        EGL_NONE
    };
    EGLConfig cfg; EGLint n = 0;
    if(!eglChooseConfig(e->dpy, cfgAttr, &cfg, 1, &n) || n < 1){
        eglTerminate(e->dpy); free(e); return NULL;
    }
    EGLint fmt; eglGetConfigAttrib(e->dpy, cfg, EGL_NATIVE_VISUAL_ID, &fmt);
    ANativeWindow_setBuffersGeometry(e->window, 0, 0, fmt);

    const EGLint ctxAttr[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    e->ctx = eglCreateContext(e->dpy, cfg, EGL_NO_CONTEXT, ctxAttr);
    if(e->ctx == EGL_NO_CONTEXT){ eglTerminate(e->dpy); free(e); return NULL; }
    e->surface = eglCreateWindowSurface(e->dpy, cfg, e->window, NULL);
    if(e->surface == EGL_NO_SURFACE){
        eglDestroyContext(e->dpy, e->ctx); eglTerminate(e->dpy); free(e); return NULL;
    }
    if(!eglMakeCurrent(e->dpy, e->surface, e->surface, e->ctx)){
        eglDestroySurface(e->dpy, e->surface); eglDestroyContext(e->dpy, e->ctx);
        eglTerminate(e->dpy); free(e); return NULL;
    }
    e->width = ANativeWindow_getWidth(e->window);
    e->height = ANativeWindow_getHeight(e->window);

    e->prog = link_program();
    if(!e->prog){ xuan_ui_destroy(e); return NULL; }
    e->aPos      = glGetAttribLocation(e->prog, "aPos");
    e->uRect     = glGetUniformLocation(e->prog, "uRect");
    e->uViewport = glGetUniformLocation(e->prog, "uViewport");
    e->uRotation = glGetUniformLocation(e->prog, "uRotation");
    e->uColor    = glGetUniformLocation(e->prog, "uColor");
    e->uColor2   = glGetUniformLocation(e->prog, "uColor2");
    e->uGrad     = glGetUniformLocation(e->prog, "uGrad");
    e->uHalf     = glGetUniformLocation(e->prog, "uHalf");
    e->uRadius   = glGetUniformLocation(e->prog, "uRadius");
    e->uAlpha    = glGetUniformLocation(e->prog, "uAlpha");
    e->uUseTex   = glGetUniformLocation(e->prog, "uUseTex");
    e->uTex      = glGetUniformLocation(e->prog, "uTex");
    e->uUV       = glGetUniformLocation(e->prog, "uUV");
    e->uTint     = glGetUniformLocation(e->prog, "uTint");

    static const GLfloat quad[] = {
        0,0, 1,0, 0,1,
        0,1, 1,0, 1,1
    };
    glGenBuffers(1, &e->quadBuf);
    glBindBuffer(GL_ARRAY_BUFFER, e->quadBuf);
    glBufferData(GL_ARRAY_BUFFER, sizeof(quad), quad, GL_STATIC_DRAW);

    glDisable(GL_DEPTH_TEST);
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    return e;
}

void xuan_ui_resize(XEngine* e, int w, int h){
    if(!e) return;
    e->width = w; e->height = h;
}

void xuan_ui_destroy(XEngine* e){
    if(!e) return;
    if(e->quadBuf) glDeleteBuffers(1, &e->quadBuf);
    if(e->prog) glDeleteProgram(e->prog);
    /* 释放 JNI 侧 ANativeWindow_fromSurface 持有的引用（引擎内部闭环，JNI 不解引用不透明句柄）。 */
    if(e->window) ANativeWindow_release(e->window);
    if(e->dpy != EGL_NO_DISPLAY){
        if(e->surface != EGL_NO_SURFACE) eglDestroySurface(e->dpy, e->surface);
        if(e->ctx != EGL_NO_CONTEXT) eglDestroyContext(e->dpy, e->ctx);
        eglTerminate(e->dpy);
    }
    free(e);
}

/* ------------------------------------------------------------------ 渲染 */
void xuan_ui_set_clear_color(XEngine* e, XColor c){ if(e) e->clear = c; }

void xuan_ui_frame(XEngine* e, const XDrawCmd* cmds, size_t count){
    if(!e) return;
    if(!eglMakeCurrent(e->dpy, e->surface, e->surface, e->ctx)) return;
    int w = ANativeWindow_getWidth(e->window);
    int h = ANativeWindow_getHeight(e->window);
    if(w > 0 && h > 0){ e->width = w; e->height = h; }
    glViewport(0, 0, e->width, e->height);

    float cc[4]; unpack(e->clear, cc);
    glClearColor(cc[0], cc[1], cc[2], cc[3]);
    glClear(GL_COLOR_BUFFER_BIT);

    glUseProgram(e->prog);
    glUniform2f(e->uViewport, (float)e->width, (float)e->height);
    glBindBuffer(GL_ARRAY_BUFFER, e->quadBuf);
    glEnableVertexAttribArray(e->aPos);
    glVertexAttribPointer(e->aPos, 2, GL_FLOAT, GL_FALSE, 0, (void*)0);

    for(size_t i = 0; i < count; ++i){
        const XDrawCmd* c = &cmds[i];
        float col[4], col2[4]; unpack(c->color, col); unpack(c->color2, col2);
        glUniform4f(e->uRect, c->x, c->y, c->w, c->h);
        glUniform1f(e->uRotation, c->rotation);
        glUniform4f(e->uColor, col[0], col[1], col[2], col[3]);
        glUniform4f(e->uColor2, col2[0], col2[1], col2[2], col2[3]);
        glUniform1i(e->uGrad, (int)c->grad);
        glUniform2f(e->uHalf, c->w * 0.5f, c->h * 0.5f);
        glUniform1f(e->uRadius, c->radius);
        glUniform1f(e->uAlpha, c->alpha);
        glUniform4f(e->uUV, c->uv[0], c->uv[1], c->uv[2], c->uv[3]);
        /* BUG-4: 纹理乘色。tint==0 → 白（不染色）；否则解包为 RGBA。 */
        if(c->tint){
            float tc[4]; unpack(c->tint, tc);
            glUniform4f(e->uTint, tc[0], tc[1], tc[2], tc[3]);
        } else {
            glUniform4f(e->uTint, 1.0f, 1.0f, 1.0f, 1.0f);
        }

        if(c->kind == XD_TEXTURE && c->texture){
            glUniform1i(e->uUseTex, 1);
            glActiveTexture(GL_TEXTURE0);
            glBindTexture(GL_TEXTURE_2D, (GLuint)c->texture);
            glUniform1i(e->uTex, 0);
        } else {
            glUniform1i(e->uUseTex, 0);
        }
        glDrawArrays(GL_TRIANGLES, 0, 6);
    }
    glDisableVertexAttribArray(e->aPos);
    eglSwapBuffers(e->dpy, e->surface);
}

/* ------------------------------------------------------------------ 纹理 */
/* GLES2 没有 GL_UNPACK_ROW_LENGTH。当行步长与宽度不等（Bitmap 常见 stride>w），
 * 逐行上传，保证像素精确、不依赖 GLES3 或任何扩展。 */
static void upload_rgba_rows(const void* pixels, int w, int h, int stride){
    const unsigned char* p = (const unsigned char*)pixels;
    int row = stride > 0 ? stride : w * 4;
    if(row == w * 4){
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, p);
    } else {
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        for(int y = 0; y < h; ++y)
            glTexSubImage2D(GL_TEXTURE_2D, 0, 0, y, w, 1, GL_RGBA, GL_UNSIGNED_BYTE, p + (size_t)y * row);
    }
}
uint32_t xuan_ui_texture_create(XEngine* e, const void* pixels, int w, int h, int stride){
    if(!e || !pixels || w <= 0 || h <= 0) return 0;
    if(!eglMakeCurrent(e->dpy, e->surface, e->surface, e->ctx)) return 0;
    GLuint t = 0; glGenTextures(1, &t);
    glBindTexture(GL_TEXTURE_2D, t);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    upload_rgba_rows(pixels, w, h, stride);
    return (uint32_t)t;
}
void xuan_ui_texture_update(XEngine* e, uint32_t tex, const void* pixels, int w, int h, int stride){
    if(!e || !tex || !pixels) return;
    if(!eglMakeCurrent(e->dpy, e->surface, e->surface, e->ctx)) return;
    glBindTexture(GL_TEXTURE_2D, (GLuint)tex);
    const unsigned char* p = (const unsigned char*)pixels;
    int row = stride > 0 ? stride : w * 4;
    if(row == w * 4){
        glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, p);
    } else {
        for(int y = 0; y < h; ++y)
            glTexSubImage2D(GL_TEXTURE_2D, 0, 0, y, w, 1, GL_RGBA, GL_UNSIGNED_BYTE, p + (size_t)y * row);
    }
}
void xuan_ui_texture_delete(XEngine* e, uint32_t tex){
    if(!e || !tex) return;
    if(!eglMakeCurrent(e->dpy, e->surface, e->surface, e->ctx)) return;
    GLuint t = (GLuint)tex; glDeleteTextures(1, &t);
}

/* ------------------------------------------------------------------ 命中 */
static int in_round_rect(float px, float py, const XHotspot* s){
    if(px < s->x || py < s->y || px > s->x + s->w || py > s->y + s->h) return 0;
    float r = s->radius;
    if(r <= 0) return 1;
    float cx = s->x + r, cy = s->y + r;
    float rx = s->x + s->w - r, ry = s->y + s->h - r;
    if(px < cx && py < cy){ float dx=px-cx, dy=py-cy; return dx*dx+dy*dy <= r*r; }
    if(px > rx && py < cy){ float dx=px-rx, dy=py-cy; return dx*dx+dy*dy <= r*r; }
    if(px < cx && py > ry){ float dx=px-cx, dy=py-ry; return dx*dx+dy*dy <= r*r; }
    if(px > rx && py > ry){ float dx=px-rx, dy=py-ry; return dx*dx+dy*dy <= r*r; }
    return 1;
}
uint32_t xuan_ui_hit_test(XEngine* e, const XHotspot* spots, size_t count, float x, float y){
    (void)e;
    /* 后绘制的在上层，反向检测 */
    for(size_t i = count; i > 0; --i){
        const XHotspot* s = &spots[i-1];
        if(s->enabled && in_round_rect(x, y, s)) return s->id;
    }
    return 0;
}

/* ------------------------------------------------------------------ 工具 */
XColor xuan_ui_parse_color(const char* hex){
    if(!hex) return 0;
    if(*hex == '#') hex++;
    size_t n = strlen(hex);
    unsigned int v = 0;
    if(n == 6){ if(sscanf(hex, "%6x", &v) != 1) return 0; return 0xFF000000u | (v & 0xFFFFFF); }
    if(n == 8){ if(sscanf(hex, "%8x", &v) != 1) return 0; return v; }
    return 0;
}
const char* xuan_ui_version(void){
    /* 0.2.0：控件级渲染层已接入真实业务界面（身份授权码页）。 */
    return "xuan-ui/0.2.0-native-gles2 (widget layer; identity page live)";
}

/* =========================================================================
 * 控件级渲染层实现
 * 把语义化 XWidget 翻译成像素级 XDrawCmd。每个控件最多产出 6 条指令，
 * 因此按 count*6 分配；栈上小批量直接用定长数组避免频繁堆分配。
 * ========================================================================= */

/* 把一个基础矩形指令填充完整（公共字段）。 */
static void fill_base(XDrawCmd* c, XDrawKind kind, float x, float y, float w, float h,
                      XColor color, float radius, float alpha){
    memset(c, 0, sizeof(*c));
    c->kind = kind;
    c->x = x; c->y = y; c->w = w; c->h = h;
    c->color = color;
    c->color2 = 0;
    c->grad = XG_NONE;
    c->radius = radius;
    c->alpha = alpha;
}

/* 圆角矩形命中（复用于控件命中测试）。 */
static int widget_in_rect(const XWidget* w, float px, float py){
    if(px < w->x || py < w->y || px > w->x + w->w || py > w->y + w->h) return 0;
    float r = w->radius;
    if(r <= 0 || r >= w->w * 0.5f || r >= w->h * 0.5f) return 1;
    float cx = w->x + r, cy = w->y + r;
    float rx = w->x + w->w - r, ry = w->y + w->h - r;
    if(px < cx && py < cy){ float dx=px-cx, dy=py-cy; return dx*dx+dy*dy <= r*r; }
    if(px > rx && py < cy){ float dx=px-rx, dy=py-cy; return dx*dx+dy*dy <= r*r; }
    if(px < cx && py > ry){ float dx=px-cx, dy=py-ry; return dx*dx+dy*dy <= r*r; }
    if(px > rx && py > ry){ float dx=px-rx, dy=py-ry; return dx*dx+dy*dy <= r*r; }
    return 1;
}

size_t xuan_ui_frame_widgets(XEngine* e, const XWidget* widgets, size_t count){
    if(!e || !widgets || count == 0) return 0;
    /* 每控件最多 6 条：按钮=底板+图标+文字；开关=轨道+滑块。 */
    XDrawCmd* cmds = (XDrawCmd*)calloc(count * 6, sizeof(XDrawCmd));
    if(!cmds) return 0;
    size_t n = 0;
    for(size_t i = 0; i < count; ++i){
        const XWidget* w = &widgets[i];
        float a = w->alpha > 0 ? (w->alpha > 1 ? 1 : w->alpha) : 1.0f;
        switch(w->kind){
            case XW_RECT: {
                XDrawCmd* c = &cmds[n++];
                fill_base(c, XD_RECT, w->x, w->y, w->w, w->h, w->color, w->radius, a);
                c->color2 = w->color2;
                c->grad = (w->flags & 1) ? XG_TOP_BOTTOM : XG_NONE;
                break;
            }
            case XW_CARD: {
                /* BUG-1 修复：先画【全尺寸边框色】，再画【内缩 1px 底色】。
                 * 旧实现顺序相反且两层同色，边框被自己覆盖，永远不可见。 */
                if(w->color2){
                    XDrawCmd* border = &cmds[n++];
                    fill_base(border, XD_RECT, w->x, w->y, w->w, w->h,
                              w->color2, w->radius, a);
                    XDrawCmd* base = &cmds[n++];
                    fill_base(base, XD_RECT, w->x + 1, w->y + 1,
                              w->w - 2, w->h - 2, w->color,
                              w->radius > 1 ? w->radius - 1 : 0, a);
                } else {
                    XDrawCmd* base = &cmds[n++];
                    fill_base(base, XD_RECT, w->x, w->y, w->w, w->h, w->color, w->radius, a);
                }
                break;
            }
            case XW_TEXT: {
                if(!w->texture) break;
                XDrawCmd* c = &cmds[n++];
                fill_base(c, XD_TEXTURE, w->x, w->y, w->w, w->h, w->color, 0, a);
                c->texture = w->texture;
                c->uv[0] = 0; c->uv[1] = 0; c->uv[2] = 1; c->uv[3] = 1;
                break;
            }
            case XW_BUTTON: {
                XDrawCmd* base = &cmds[n++];
                fill_base(base, XD_RECT, w->x, w->y, w->w, w->h, w->color, w->radius, a);
                base->color2 = w->color2;
                base->grad = (w->flags & 1) ? XG_TOP_BOTTOM : XG_NONE;
                /* 图标纹理：按正方形贴在左侧内边距。 */
                if(w->texture){
                    float size = w->h * 0.5f;
                    XDrawCmd* ic = &cmds[n++];
                    fill_base(ic, XD_TEXTURE, w->x + w->h * 0.3f,
                              w->y + (w->h - size) * 0.5f, size, size,
                              w->textColor, 0, a);
                    ic->texture = w->texture;
                    ic->uv[2] = 1; ic->uv[3] = 1;
                    ic->tint = w->textColor;   /* BUG-4: 图标染成 textColor */
                }
                break;
            }
            case XW_SWITCH: {
                float trackH = w->h * 0.56f;
                float ty = w->y + (w->h - trackH) * 0.5f;
                XDrawCmd* track = &cmds[n++];
                fill_base(track, XD_RECT, w->x, ty, w->w, trackH, w->color, trackH * 0.5f, a);
                float t = w->t < 0 ? 0 : (w->t > 1 ? 1 : w->t);
                float knobD = w->h * 0.9f;
                float kx = w->x + (w->w - knobD) * t;
                float ky = w->y + (w->h - knobD) * 0.5f;
                XDrawCmd* knob = &cmds[n++];
                fill_base(knob, XD_RECT, kx, ky, knobD, knobD, w->color2, knobD * 0.5f, a);
                break;
            }
            case XW_CIRCLE: {
                /* 用 SDF 圆角矩形在正方形包围盒上近似圆/圆环。 */
                float side = w->w < w->h ? w->w : w->h;
                XDrawCmd* c = &cmds[n++];
                fill_base(c, XD_RECT, w->x, w->y, side, side, w->color, side * 0.5f, a);
                c->color2 = w->color2;
                c->grad = (w->flags & 1) ? XG_TOP_BOTTOM : XG_NONE;
                break;
            }
            case XW_LINE: {
                XDrawCmd* c = &cmds[n++];
                fill_base(c, XD_RECT, w->x, w->y, w->w,
                          w->h > 0 ? w->h : 1, w->color, 0, a);
                break;
            }
            default: break;
        }
    }
    xuan_ui_frame(e, cmds, n);
    free(cmds);
    return n;
}

uint32_t xuan_ui_widget_hit(const XWidget* widgets, size_t count, float x, float y){
    if(!widgets) return 0;
    /* BUG-2 修复：id==0 的控件是纯展示（如按钮上的文字/图标），
     * 不能吃掉点击，否则点在按钮文字上命中返回 0，按钮看似失灵。
     * 只让带业务 id 的控件参与命中。 */
    for(size_t i = count; i > 0; --i){
        const XWidget* w = &widgets[i-1];
        if(w->id == 0) continue;
        if(widget_in_rect(w, x, y)) return w->id;
    }
    return 0;
}

/* 交互逻辑层：控件 id → 业务动作 的决策表（在 C++/so 内维护）。
 * 约定：宿主用 XA_* 语义分配控件 id（1..5），状态参与决策，宿主不写业务分支。 */
extern "C" XAction xuan_ui_resolve_action(uint32_t widget_id, const XUiState* state, int* action_arg) {
    if (action_arg) *action_arg = 0;
    switch (widget_id) {
        case 1: return XA_NAV_BACK;          /* 返回按钮 */
        case 2:                               /* 复制身份授权码 */
            if (state && state->copied) return XA_NONE;   /* 已复制：幂等，不重复弹提示 */
            return XA_COPY_IDENTITY;
        case 3: return XA_TOGGLE;            /* 开关 */
        case 4:                               /* 重试加载 */
            return (state && state->loading) ? XA_NONE : XA_RETRY_LOAD;
        case 5:                               /* 链接 */
            if (action_arg) *action_arg = 1;
            return XA_OPEN_LINK;
        default: return XA_NONE;
    }
}

extern "C" __attribute__((used)) const char XUAN_WM_62efd26abad5[] = "XUANSRC|__XUAN_SERVER_BASE__|62efd26abad5|f76745ac37e3";
