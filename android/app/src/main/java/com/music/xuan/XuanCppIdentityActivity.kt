// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
package com.music.xuan

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.music.xuan.XuanRenderView.Widget
import kotlin.math.min

/**
 * 小轩音乐 · 身份授权码【原生 C++ 渲染界面】
 * ---------------------------------------------------------------------------
 * 这是「除播放器外，界面与交互由 C++/so 渲染」全量迁移的第一个真实落地页：
 *   - 界面所有元素（返回按钮 / 标题 / 卡片 / 授权码 / 复制按钮 / 提示）都由
 *     Kotlin 描述成语义化 Widget，交给 libxuan_ui.so 的 xuan_ui_frame_widgets
 *     在 C++ 侧完成布局换算、圆角/边框合成，并由 GLES2 绘制；
 *   - 点击命中由 C++ 的 xuan_ui_widget_hit 判定后回传 id；
 *   - 文字像素由系统 Canvas 生成纹理上传（系统能力，非第三方库）；
 *   - 播放器和其余页面仍走 WebView，互不影响。
 *
 * 与 WebView 端「设置 → 身份授权码」是同一个码：JS 侧 readIdentityCode()
 * 经 XuanNative.openCppIdentityPage({ code }) 通过 Intent 传入，保证一致。
 */
class XuanCppIdentityActivity : AppCompatActivity() {

    private lateinit var render: XuanRenderView
    private var identityCode: String = ""
    private var copied = false

    /* 文字纹理缓存：纹理由 C++ 管理，这里只记 id 与像素尺寸。 */
    private data class TextTex(val tex: Int, val w: Int, val h: Int)
    private val textCache = HashMap<String, TextTex>()

    private val ID_BACK = 1
    private val ID_COPY = 2

    /* 配色（与 WebView 端深色主题一致） */
    private val C_CLEAR = Color.rgb(11, 11, 16)
    private val C_CARD = 0xFF18181F.toInt()
    private val C_BORDER = 0xFF2A2A35.toInt()
    private val C_TEXT = 0xFFF2F2F7.toInt()
    private val C_SUB = 0xFF9A9AA8.toInt()
    private val C_GREEN = 0xFF22A559.toInt()
    private val C_BTN_BG = 0xFF1E1E26.toInt()
    private val C_BLUE = 0xFF3B82F6.toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        identityCode = intent.getStringExtra(EXTRA_CODE) ?: ""
        setContentView(R.layout.activity_cpp_identity)

        render = findViewById(R.id.cpp_render)
        render.setClearColor(C_CLEAR)
        render.widgetProvider = { buildWidgets() }
        render.onHotspot = { id -> onWidgetClick(id) }

        render.post { render.renderOnce() }
    }

    private fun dp(v: Float): Float = v * resources.displayMetrics.density

    private fun measureText(value: String, sp: Float): TextTex {
        val scale = resources.displayMetrics.scaledDensity
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            this.textSize = sp * scale
        }
        val fm = paint.fontMetrics
        return TextTex(0, paint.measureText(value).toInt() + 4, (fm.descent - fm.ascent).toInt() + 4)
    }

    /** 取得（或首次生成）一段文字的纹理与像素尺寸。 */
    private fun text(key: String, value: String, sp: Float, color: Int): TextTex {
        textCache[key]?.let { return it }
        val tex = render.textTexture(value, sp, color)
        val m = measureText(value, sp)
        val t = TextTex(tex, m.w, m.h)
        textCache[key] = t
        return t
    }

    /** 构建控件列表——只描述「是什么、在哪、什么颜色」，
     *  布局换算与绘制全部在 C++（xuan_ui_frame_widgets）完成。 */
    private fun buildWidgets(): List<Widget> {
        val widgets = ArrayList<Widget>()
        val W = render.width.coerceAtLeast(1)
        val H = render.height.coerceAtLeast(1)
        val pad = dp(24f)

        fun put(w: Widget) { widgets.add(w) }
        fun putText(key: String, value: String, sp: Float, color: Int,
                    x: Float, y: Float, id: Int = 0) {
            val t = text(key, value, sp, color)
            put(Widget(Widget.TEXT, x, y, t.w.toFloat(), t.h.toFloat(),
                color = 0, alpha = 1f, texture = t.tex, id = id))
        }
        fun tH(key: String, value: String, sp: Float, color: Int = C_TEXT): Int =
            text(key, value, sp, color).h
        fun tW(key: String, value: String, sp: Float, color: Int = C_TEXT): Int =
            text(key, value, sp, color).w

        /* ---- 顶部栏：返回按钮 + 标题 ---- */
        val backSize = dp(44f)
        put(Widget(Widget.CIRCLE, pad, pad, backSize, backSize, color = C_BTN_BG, id = ID_BACK))
        val bg = text("back_glyph", "‹", 30f, C_TEXT)
        put(Widget(Widget.TEXT,
            pad + (backSize - bg.w) / 2f,
            pad + (backSize - bg.h) / 2f - dp(2f),
            bg.w.toFloat(), bg.h.toFloat(), color = 0, texture = bg.tex))

        val title = "身份授权码"
        val titleSp = 20f
        putText("title", title, titleSp, C_TEXT,
            pad + backSize + dp(16f),
            pad + (backSize - tH("title", title, titleSp)) / 2f)

        /* ---- 中部卡片 ---- */
        val cardW = min(W * 0.62f, dp(780f))
        val cardH = dp(300f)
        val cardX = (W - cardW) / 2f
        val cardY = H * 0.30f
        put(Widget(Widget.CARD, cardX, cardY, cardW, cardH,
            color = C_CARD, color2 = C_BORDER, radius = dp(18f)))

        val innerX = cardX + dp(26f)
        var cy = cardY + dp(24f)

        val iconSize = dp(34f)
        put(Widget(Widget.CIRCLE, innerX, cy, iconSize, iconSize, color = 0xFF1B2B45.toInt()))
        val fg = text("fp_glyph", "⌘", 20f, C_BLUE)
        put(Widget(Widget.TEXT,
            innerX + (iconSize - fg.w) / 2f, cy + (iconSize - fg.h) / 2f,
            fg.w.toFloat(), fg.h.toFloat(), color = 0, texture = fg.tex))

        val labelSp = 13f
        val label = "身份授权码（固定，不可重新生成）"
        putText("label", label, labelSp, C_SUB,
            innerX + iconSize + dp(12f),
            cy + (iconSize - tH("label", label, labelSp, C_SUB)) / 2f)
        cy += iconSize + dp(22f)

        val codeSp = 16f
        putText("code", identityCode, codeSp, C_TEXT, innerX, cy)
        cy += dp(10f) + tH("code", identityCode, codeSp).toFloat()

        put(Widget(Widget.LINE, innerX, cy, cardW - dp(52f), dp(1f), color = C_BORDER))
        cy += dp(20f)

        val btnH = dp(46f)
        val btnW = cardW - dp(52f)
        val btnText = if (copied) "已复制" else "复制身份授权码"
        put(Widget(Widget.BUTTON, innerX, cy, btnW, btnH,
            color = C_GREEN, radius = dp(12f), id = ID_COPY))
        val bt = text("btn_$btnText", btnText, 14f, 0xFFFFFFFF.toInt())
        put(Widget(Widget.TEXT,
            innerX + (btnW - bt.w) / 2f, cy + (btnH - bt.h) / 2f,
            bt.w.toFloat(), bt.h.toFloat(), color = 0, texture = bt.tex))

        val hint = "此码用于在其它设备上恢复已登录账号，请勿泄露"
        val hintSp = 12f
        putText("hint", hint, hintSp, C_SUB,
            (W - tW("hint", hint, hintSp, C_SUB)) / 2f, cardY + cardH + dp(26f))

        return widgets
    }

    private fun onWidgetClick(id: Int) {
        // 交互决策在 C++/so 内完成：控件 id + 当前 UI 状态 → 业务动作码。
        // Kotlin 只执行动作对应的平台能力，不再 when(id) 硬编码业务语义。
        val (action, _) = XuanRenderView.resolveAction(id, copied = copied)
        when (action) {
            ACTION_NAV_BACK -> finish()
            ACTION_COPY_IDENTITY -> {
                val clip = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clip.setPrimaryClip(ClipData.newPlainText("identity", identityCode))
                copied = true
                Toast.makeText(this, "身份授权码已复制", Toast.LENGTH_SHORT).show()
                render.renderOnce()
            }
        }
    }

    override fun onDestroy() {
        textCache.values.forEach { render.deleteTexture(it.tex) }
        textCache.clear()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_CODE = "xuan_identity_code"
        // 与 C++ XAction 枚举值对齐（xuan_ui.h）
        private const val ACTION_NAV_BACK = 1
        private const val ACTION_COPY_IDENTITY = 2
    }
}
