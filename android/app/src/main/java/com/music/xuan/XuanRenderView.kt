// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
package com.music.xuan

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView

/**
 * 小轩音乐 · 自研 C++ 原生渲染承载层
 * ---------------------------------------------------------------------------
 * 这个 SurfaceView 把真正的 GLES2 渲染交给自研引擎 libxuan_ui.so：
 *   - 引擎源：src/cpp/xuan_ui.cpp + xuan_ui_jni.cpp（零第三方库，仅系统 GLES2/EGL）
 *   - 本类只做三件事：管理 Surface 生命周期、把 UI 描述转成扁平 float[] 提交、命中回调
 *   - 文字像素由系统 Canvas/Paint 生成后作为纹理上传（系统能力，非第三方库）
 *
 * 如实标注（重要）：这是原生渲染引擎的「地基 + 可运行承载层」。
 * 它证明「所有界面由 C++ 渲染」这条路真实可行，但它本身还不等于
 * 全盘 299 屏迁移完成——业务界面逐屏搬进来是后续持续工程。
 */
class XuanRenderView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : SurfaceView(context, attrs), SurfaceHolder.Callback {

    private var engine: Long = 0L
    private val holderRef = holder

    /** 一帧的绘制指令提供者，由业务层实现，返回打包后的 float[] 与条数。 */
    fun interface FrameProvider {
        fun buildFrame(width: Int, height: Int): Frame
    }

    data class Frame(val cmds: FloatArray, val count: Int)

    var frameProvider: FrameProvider? = null
    /** 控件级渲染提供者：返回一批语义化控件，由 C++/so 完成布局与绘制。 */
    var widgetProvider: (() -> List<Widget>)? = null
    var onHotspot: ((id: Int) -> Unit)? = null

    private var hotSpots = FloatArray(0)

    init {
        holderRef.addCallback(this)
    }

    override fun surfaceCreated(h: SurfaceHolder) {
        val density = resources.displayMetrics.density
        engine = nativeCreate(h.surface, density)
        nativeSetClear(engine, pendingClear ?: Color.rgb(12, 12, 16))
    }

    override fun surfaceChanged(h: SurfaceHolder, format: Int, width: Int, height: Int) {
        // 引擎每帧按 ANativeWindow 实际尺寸自适应，这里只需触发一次重绘。
        renderOnce()
        // BUG-5 修复：provider 可能在 surface 就绪之后才设置，延迟补一帧避免首屏空白。
        post { renderOnce() }
    }

    override fun surfaceDestroyed(h: SurfaceHolder) {
        if (engine != 0L) {
            nativeDestroy(engine)
            engine = 0L
        }
    }

    /** 由外部（如 Choreographer）驱动渲染；也可直接调用做单帧更新。
     *  控件级 provider 优先：界面描述交给 C++/so 布局并绘制。 */
    fun renderOnce() {
        if (engine == 0L) return
        widgetProvider?.let { provider ->
            val widgets = provider()
            if (widgets.isNotEmpty()) renderWidgets(widgets)
            return
        }
        val fp = frameProvider ?: return
        val w = width.coerceAtLeast(1)
        val h = height.coerceAtLeast(1)
        val frame = fp.buildFrame(w, h)
        if (frame.count > 0 && frame.cmds.size >= frame.count * 20) {
            nativeFrame(engine, frame.cmds, frame.count)
        }
    }

    /** 设置每帧清屏色。 */
    fun setClearColor(argb: Int) {
        if (engine != 0L) nativeSetClear(engine, argb)
        else pendingClear = argb
    }

    private var pendingClear: Int? = null

    /** 从系统 Paint 生成文字纹理（RGBA8888），返回纹理 id 供纹理指令引用。 */
    fun textTexture(text: String, textSizeSp: Float, color: Int): Int {
        if (engine == 0L) return 0
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.textSize = textSizeSp * resources.displayMetrics.scaledDensity
            this.color = color
            typeface = Typeface.DEFAULT
            textAlign = Paint.Align.LEFT
        }
        val fm = paint.fontMetrics
        val w = paint.measureText(text).toInt().coerceAtLeast(1) + 4
        val h = (fm.descent - fm.ascent).toInt().coerceAtLeast(1) + 4
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.drawText(text, 2f, 2f - fm.ascent, paint)
        val tex = nativeTextureCreate(engine, bmp)
        bmp.recycle()
        return tex
    }

    fun deleteTexture(tex: Int) {
        if (engine != 0L && tex != 0) nativeTextureDelete(engine, tex)
    }

    fun setHotSpots(spots: FloatArray) { hotSpots = spots }

    /* ------------------------- 控件级渲染（界面布局跑在 C++/so） ------------------------- */

    /** 语义化控件，Kotlin 只描述「是什么、在哪」，布局/圆角/状态合成交给 C++。 */
    data class Widget(
        val kind: Int,
        val x: Float, val y: Float, val w: Float, val h: Float,
        val color: Int,
        val color2: Int = 0,
        val radius: Float = 0f,
        val alpha: Float = 1f,
        val texture: Int = 0,
        val textColor: Int = 0,
        val t: Float = 0f,
        val flags: Int = 0,
        val id: Int = 0,
    ) {
        companion object {
            const val RECT = 0
            const val TEXT = 1
            const val BUTTON = 2
            const val CARD = 3
            const val SWITCH = 4
            const val CIRCLE = 5
            const val LINE = 6
            const val GRAD_TOP_BOTTOM = 1
            const val SHOW_KNOB = 2
            const val HAS_ICON = 4
        }
    }

    private var widgetPacked = FloatArray(0)
    private var widgetCount = 0

    /** 提交一批控件并渲染一帧（C++ 完成布局换算与绘制）。返回实际绘制指令数。 */
    fun renderWidgets(widgets: List<Widget>): Int {
        if (engine == 0L || widgets.isEmpty()) return 0
        val packed = FloatArray(widgets.size * 16)
        for (i in widgets.indices) {
            val w = widgets[i]
            val o = i * 16
            packed[o] = w.kind.toFloat()
            packed[o + 1] = w.x; packed[o + 2] = w.y
            packed[o + 3] = w.w; packed[o + 4] = w.h
            packed[o + 5] = java.lang.Float.intBitsToFloat(w.color)
            packed[o + 6] = java.lang.Float.intBitsToFloat(w.color2)
            packed[o + 7] = w.radius; packed[o + 8] = w.alpha
            packed[o + 9] = w.texture.toFloat()
            packed[o + 10] = java.lang.Float.intBitsToFloat(w.textColor)
            packed[o + 11] = w.t; packed[o + 12] = w.flags.toFloat()
            packed[o + 13] = java.lang.Float.intBitsToFloat(w.id)
        }
        widgetPacked = packed
        widgetCount = widgets.size
        return nativeWidgetFrame(engine, packed, widgets.size)
    }

    /** 从系统 Bitmap 生成图片纹理（如头像/图标），交给 C++ 绘制。 */
    fun bitmapTexture(bmp: Bitmap): Int {
        if (engine == 0L) return 0
        val tex = nativeTextureCreate(engine, bmp)
        return tex
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        /* BUG-3 修复：ACTION_DOWN 命中可交互控件时必须返回 true 消费，
         * 否则后续 MOVE/UP 不会投递到本 View，按钮在部分机型上失灵。 */
        if (ev.actionMasked == MotionEvent.ACTION_DOWN && engine != 0L) {
            if (widgetCount > 0 &&
                nativeWidgetHit(widgetPacked, widgetCount, ev.x, ev.y) != 0) return true
            if (widgetCount == 0 && hotSpots.isNotEmpty()) {
                val count = hotSpots.size / 7
                if (nativeHitTest(engine, hotSpots, count, ev.x, ev.y) != 0) return true
            }
        }
        if (ev.actionMasked == MotionEvent.ACTION_UP) {
            if (widgetCount > 0) {
                val id = nativeWidgetHit(widgetPacked, widgetCount, ev.x, ev.y)
                if (id != 0) {
                    onHotspot?.invoke(id)
                    return true
                }
            } else if (engine != 0L && hotSpots.isNotEmpty()) {
                val count = hotSpots.size / 7
                val id = nativeHitTest(engine, hotSpots, count, ev.x, ev.y)
                if (id != 0) {
                    onHotspot?.invoke(id)
                    return true
                }
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    fun engineVersion(): String = nativeVersion()

    companion object {
        init {
            System.loadLibrary("xuan_ui")
        }
        @JvmStatic private external fun nativeCreate(surface: android.view.Surface, density: Float): Long
        @JvmStatic private external fun nativeDestroy(engine: Long)
        @JvmStatic private external fun nativeSetClear(engine: Long, argb: Int)
        @JvmStatic private external fun nativeFrame(engine: Long, packed: FloatArray, count: Int)
        @JvmStatic private external fun nativeTextureCreate(engine: Long, bitmap: Bitmap): Int
        @JvmStatic private external fun nativeTextureDelete(engine: Long, tex: Int)
        @JvmStatic private external fun nativeHitTest(engine: Long, spots: FloatArray, count: Int, x: Float, y: Float): Int
        @JvmStatic private external fun nativeWidgetFrame(engine: Long, packed: FloatArray, count: Int): Int
        @JvmStatic private external fun nativeWidgetHit(packed: FloatArray, count: Int, x: Float, y: Float): Int
        @JvmStatic private external fun nativeResolveAction(widgetId: Int, toggled: Int, copied: Int, loading: Int, argOut: LongArray): Int
        @JvmStatic private external fun nativeVersion(): String

        /** 交互逻辑在 C++ 侧决策：控件 id + UI 状态 → 业务动作码。 */
        @JvmStatic fun resolveAction(widgetId: Int, toggled: Boolean = false, copied: Boolean = false,
                                     loading: Boolean = false): Pair<Int, Int> {
            val arg = LongArray(1)
            val action = try {
                nativeResolveAction(widgetId, if (toggled) 1 else 0, if (copied) 1 else 0,
                                    if (loading) 1 else 0, arg)
            } catch (_: Throwable) { 0 }
            return action to arg[0].toInt()
        }

        /** 自研 C++ 渲染引擎版本串（供插件/JS 自检）。 */
        @JvmStatic fun versionString(): String = try { nativeVersion() } catch (_: Throwable) { "unavailable" }

        /** 引擎 so 是否成功加载。 */
        @JvmStatic fun isEngineAvailable(): Boolean =
            try { nativeVersion().startsWith("xuan-ui") } catch (_: Throwable) { false }
    }
}
