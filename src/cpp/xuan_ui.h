// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
/*
 * 小轩音乐 · 自研原生 UI 渲染引擎公共接口
 * ---------------------------------------------------------------------------
 * 这是「全盘切换」的物理地基：一个不依赖任何第三方 UI/图形库的 C++ 渲染内核。
 * 图形 API 只用 Android 系统提供的 GLES2 / EGL（系统能力，非第三方库）；
 * 文字与图片的像素由宿主（Android Canvas / Bitmap，系统 API）生成后作为纹理
 * 上传，引擎本身不解析字体、不解码图片，因此引入零第三方依赖。
 *
 * 设计：retained display-list。宿主每帧（或按需）提交一批绘制指令 + 可点击热区，
 * 引擎把它们批次化后交给 GLES2 绘制，并在触摸时做命中测试回调宿主。
 *
 * 当前状态（如实标注，见交付说明）：这是引擎内核，尚未接入业务界面。
 * 全盘 299 屏的迁移是后续逐屏工程，本文件不代表那部分已完成。
 */
#ifndef XUAN_UI_H
#define XUAN_UI_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 颜色：0xAARRGGBB，与 Android Color 一致 */
typedef uint32_t XColor;

/* 绘制指令类型 */
typedef enum {
    XD_RECT = 0,        /* 矩形 / 圆角矩形，支持纯色或两色线性渐变 */
    XD_CIRCLE,          /* 圆 / 圆环 */
    XD_LINE,            /* 线段（可抗锯齿） */
    XD_TEXTURE,         /* 纹理四边形（文字/图片由宿主上传的纹理） */
    XD_CLIP_RECT        /* 裁剪区（圆角裁剪用于头像/卡片） */
} XDrawKind;

/* 渐变方向 */
typedef enum {
    XG_NONE = 0,
    XG_TOP_BOTTOM,
    XG_LEFT_RIGHT,
    XG_TL_BR
} XGradient;

/* 一条绘制指令。位置单位为像素，坐标原点左上，y 向下。 */
typedef struct {
    XDrawKind kind;
    float x, y, w, h;       /* 包围盒 */
    XColor color;           /* 主色 / 纯色 */
    XColor color2;          /* 渐变终止色 */
    XGradient grad;
    float radius;           /* 圆角半径 / 圆环粗细 / 线宽 */
    float alpha;            /* 0..1 额外透明度 */
    uint32_t texture;       /* XD_TEXTURE 用的纹理 id，由 xuan_ui_texture_create 返回 */
    float uv[4];            /* u0,v0,u1,v1 */
    float rotation;         /* 弧度，绕包围盒中心 */
    XColor tint;            /* 纹理乘色；0 表示不染色（默认白） */
} XDrawCmd;

/* 可点击热区 */
typedef struct {
    uint32_t id;            /* 宿主自定义 id，命中时回传 */
    float x, y, w, h;
    float radius;           /* 圆角命中 */
    int enabled;
} XHotspot;

/* 引擎句柄 */
typedef struct XEngine XEngine;

/* 生命周期 --------------------------------------------------------------- */
/* 创建引擎并接管一个 Android NativeWindow 的 EGL 上下文（window 为 ANativeWindow*）。
 * 由 native 侧全权管理 EGL 上下文与 GLES2 渲染。失败返回 NULL。 */
XEngine* xuan_ui_create(void* window, float density);
/* surface 尺寸变化（横竖屏 / 窗口变化） */
void xuan_ui_resize(XEngine* e, int width, int height);
/* 引擎销毁，释放所有 GPU 资源 */
void xuan_ui_destroy(XEngine* e);

/* 渲染 ------------------------------------------------------------------- */
/* 提交本帧显示列表并绘制一帧。cmd 数组由宿主持有，引擎在返回前用完即止。 */
void xuan_ui_frame(XEngine* e, const XDrawCmd* cmds, size_t count);
/* 每帧起始清屏色 */
void xuan_ui_set_clear_color(XEngine* e, XColor color);

/* 纹理 ------------------------------------------------------------------- */
/* 从 RGBA8888 像素创建纹理。pixels 为 top-down 紧密排列，stride 为行字节数。 */
uint32_t xuan_ui_texture_create(XEngine* e, const void* pixels, int w, int h, int stride);
/* 更新已有纹理像素 */
void xuan_ui_texture_update(XEngine* e, uint32_t tex, const void* pixels, int w, int h, int stride);
/* 删除纹理 */
void xuan_ui_texture_delete(XEngine* e, uint32_t tex);

/* 触摸命中 --------------------------------------------------------------- */
/* 提交热区（宿主每帧或按需设置）。返回命中热区的 id，未命中返回 0。 */
uint32_t xuan_ui_hit_test(XEngine* e, const XHotspot* spots, size_t count, float x, float y);

/* =========================================================================
 * 控件级渲染层（自研，零第三方依赖）
 * -------------------------------------------------------------------------
 * 上面的 XDrawCmd 是像素级原语；这一层让「界面描述」本身进入 C++：
 * 宿主只传语义化控件（卡片/文本/按钮/开关/分隔线/头像底板），
 * 由 C++ 完成布局换算、圆角/边框/状态合成，再翻译成 XDrawCmd 绘制。
 * 这样界面逻辑真正在 C++/so 中执行，而非停留在 Kotlin/JS。
 * ========================================================================= */

typedef enum {
    XW_RECT = 0,    /* 圆角矩形/渐变底板 */
    XW_TEXT,        /* 文字（宿主上传的纹理，按 x/y/w/h 绘制） */
    XW_BUTTON,      /* 圆角按钮：底板 + 可选图标纹理 + 可选文字纹理 */
    XW_CARD,        /* 圆角卡片：底板 + 1px 边框 */
    XW_SWITCH,      /* 开关：轨道 + 滑块，t=0..1 滑块位置 */
    XW_CIRCLE,      /* 圆/圆环头像底板，t=进度(0 表示实心) */
    XW_LINE         /* 分隔线（用 h 表示线宽） */
} XWidgetKind;

typedef struct {
    int        kind;        /* XWidgetKind */
    float      x, y, w, h;  /* 像素包围盒，左上原点 */
    XColor     color;       /* 主色/底色 */
    XColor     color2;      /* 渐变终止色 / 边框色 / 滑块色 */
    float      radius;      /* 圆角/圆环粗细 */
    float      alpha;       /* 0..1 */
    uint32_t   texture;     /* 文字/图标/图片纹理 id，0 表示无 */
    XColor     textColor;   /* 图标/文字着色（按钮前景） */
    float      t;           /* 通用参数：开关进度/圆环进度/按压态 */
    int        flags;       /* 位标志：bit0 渐变上下 / bit1 显示滑块 / bit2 图标 */
    uint32_t   id;          /* 控件 id，命中时回传 */
} XWidget;

/* 把控件数组翻译成显示列表并绘制一帧（在 C++ 内完成布局与状态合成）。
 * 返回本帧实际生成的 XDrawCmd 条数。 */
size_t xuan_ui_frame_widgets(XEngine* e, const XWidget* widgets, size_t count);

/* 控件级命中测试：返回命中控件 id（从后往前，后绘制者在上），未命中 0。 */
uint32_t xuan_ui_widget_hit(const XWidget* widgets, size_t count, float x, float y);

/* =========================================================================
 * 交互逻辑层（自研，零第三方依赖）
 * -------------------------------------------------------------------------
 * 把「点击某控件 → 触发什么业务动作」的决策规则放进 C++。
 * 宿主(Kotlin)只执行动作码对应的平台能力（剪贴板/关闭页面/发事件），
 * 不再用 when(id) 硬编码业务语义，交互逻辑真正在 so 中运行。
 * ========================================================================= */
typedef enum {
    XA_NONE = 0,        /* 无动作 */
    XA_NAV_BACK,        /* 返回上一页 */
    XA_COPY_IDENTITY,   /* 复制身份授权码 */
    XA_TOGGLE,          /* 切换开关状态 */
    XA_RETRY_LOAD,      /* 重试加载 */
    XA_OPEN_LINK        /* 打开链接 */
} XAction;

/* 交互状态：由宿主每帧同步给 C++，使动作决策可依赖当前 UI 状态 */
typedef struct {
    int  toggled;       /* 开关当前态 */
    int  copied;        /* 是否已复制（用于动作幂等/反馈） */
    int  loading;       /* 加载中 */
} XUiState;

/* 把控件 id 解析为业务动作；action_arg 输出附加参数（如链接索引），可空。
 * 决策表在 C++ 内维护，宿主不参与业务判断。 */
XAction xuan_ui_resolve_action(uint32_t widget_id, const XUiState* state, int* action_arg);

/* 工具 ------------------------------------------------------------------- */
/* 解析 #RRGGBB / #AARRGGBB 字符串为 XColor；失败返回 0。 */
XColor xuan_ui_parse_color(const char* hex);
/* 版本字符串（自研引擎标识，如实标注） */
const char* xuan_ui_version(void);

#ifdef __cplusplus
}
#endif
#endif /* XUAN_UI_H */

/* 头文件会被多个 TU include，水印符号必须用内部链接，否则链接期重复定义。 */
static __attribute__((used)) const char XUAN_WM_5dfd7c1d80aa[] = "XUANSRC|__XUAN_SERVER_BASE__|5dfd7c1d80aa|c17478f07541";
