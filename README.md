# ui-guard

给 AI 生成的前端做**交付前布局验收**：不依赖模型肉眼，用浏览器几何测量判断页面是否客观存在布局错误。

定位：美学 skill 管**生成期**（写得好看），ui-guard 管**验收期**（交付前没破）。引擎负责判断对错，修复交给 agent；硬错误零误报，疑似问题只出证据。

## 检查什么

| 层 | 规则 | 内容 | 误报控制 |
|---|---|---|---|
| 硬错误 | H1 | 页面级水平溢出 | 排除横向滚动容器与 fixed 浮层 |
| 硬错误 | H1c | 文本横向裁剪（无省略号） | 只查直接文本；`ellipsis`、`sr-only`（1px 裁剪）豁免 |
| 硬错误 | H2 | 文本纵向裁剪 | `line-clamp` / `ellipsis` 豁免；`sr-only` 豁免 |
| 硬错误 | H3 | fixed 浮层越出视口 | 纯装饰、`aria-hidden` / `inert`、`data-state=closed`、`pointer-events:none` 豁免 |
| 硬错误 | H4 | 可交互元素被完全遮挡、点不到 | 命中测试取栈顶；模态只查内部；滚动容器 / sticky 头 / disabled（含 `fieldset` 与祖先 `aria-disabled`）豁免 |
| 疑似 | H4-partial | 部分采样点被遮挡 | warn，不作为交付阻塞 |
| 硬错误 | H5 | 可交互元素互相重叠 | 只算可交互；父子包含 / 模态 / disabled 豁免；30% 面积阈值 |
| 疑似 | S1 | 字体声明了但加载失败 | `document.fonts` 状态 |
| 疑似 | S2 | 同排按钮垂直中心不齐 | 只查同父按钮组 |
| 疑似 | S3 | 非交互文本互相重叠 | 模态打开时只查模态内部；fixed/sticky 浮层豁免 |
| 疑似 | S4 | 文本被挤成单字竖排 | 排除 `writing-mode: vertical-*` |
| 疑似 | S5 | 文本对比度低于 WCAG AA（4.5:1 / 大字 3:1） | 只算纯色背景；渐变/图片、透明文字、`sr-only` 跳过 |
| 疑似 | S6 | 省略号截断但没有 `title` / `aria-label` | 只查确实溢出且无完整文本入口的元素 |
| 疑似 | S7 | 触控目标小于 24×24（WCAG 2.5.8） | 禁用控件、视口外、inline 链接、checkbox 的关联 label 豁免 |
| 疑似 | S8 | hash 锚点被吸顶 / 固定头部遮住 | 有 `scroll-margin-top` 时不报 |
| 性能 | P1 | 帧率 < 45 或长任务过多（`--perf` 开启） | 只采样一次，1.2 秒 |

## 安装

```bash
npm install
npx playwright install chromium        # 或直接使用本机浏览器：
# Windows PowerShell: $env:UI_GUARD_CHANNEL='chrome'
```

Node 20+。也可以用系统 Chrome / Edge（`UI_GUARD_CHANNEL=chrome|msedge`），免下载 Chromium。

## 用法

```bash
# 扫描：退出码 0 = 无硬错误，1 = 有硬错误
node bin/ui-guard.js scan --url http://localhost:3000 \
  --viewports 375,768,1280 --out report.json

# 打开抽屉 / 气泡后再测一个状态（每个动作从干净页面重载）
node bin/ui-guard.js scan --url http://localhost:3000 \
  --actions "click:#open-drawer;hover:.help" --out report.json

# 性能采样（FPS + 长任务）
node bin/ui-guard.js scan --url http://localhost:3000 --perf

# 回归对比：只输出增量，退出码 0 = 无新增/残留硬错误
node bin/ui-guard.js verify --url http://localhost:3000 --baseline report.json
```

默认会等待全屏启动遮罩（`[aria-modal]` 且覆盖 ≥90% 视口）消失再测量，最多 8 秒，避免把开场动画当成页面终态。要专门测动画中间态：

```bash
node bin/ui-guard.js scan --url http://localhost:3000 --no-wait-overlay
```

输出是给 agent 消费的结构化摘要（规则、selector、实测数据、视口/状态），完整几何数据落在 `--out` 指定的 JSON。

## MCP（给 coding agent 用）

```bash
node bin/ui-guard.js mcp
# Claude Code:
claude mcp add -s user ui-guard -- node <绝对路径>/bin/ui-guard.js mcp
```

工具：`ui_scan` / `ui_verify`，参数含 `viewports`、`actions`、`perf`、`waitForStartupOverlay`。几何数据写到系统临时目录，回给模型的只有摘要 + 报告路径。

**验收协议**（写在工具描述里）：扫描 → 修复 → `ui_verify` 核对增量 → 最多 3 轮，未收敛就停下，把完整报告交给人类。

## 测试

```bash
npm test                 # 69 项：多视口断言 + 交互状态 + 回归对比 + 新规则
npm run eval             # 真实 23 + 合成 125 条标签的命中 / 误报 / 覆盖评估
node test/run-mcp.js     # MCP stdio 端到端
```

fixtures 覆盖：正常页的刻意设计（badge 重叠、省略号、line-clamp、横向滚动、关闭态抽屉、装饰光晕、竖排文字、模态背景、sr-only、fieldset disabled、透明渐变文字、transform 关闭抽屉）、各类硬错误、交互打开态、启动遮罩、低对比度、长任务。

标签：`datasets/labels.jsonl`（真实 23 条）、`datasets/labels-synthetic.jsonl`（合成 125 条）、`datasets/evidence.json`；原始扫描报告在 `datasets/raw/`（本地，不提交）。

## 设计原则

- **无基线检测**：没有设计稿时，引擎不猜意图。客观不可能正确的进硬错误；需要意图判断的进疑似层，附实测数据交 agent / 人判断。
- **误报优先于漏报**：硬错误零误报是信用来源；豁免规则（模态、装饰、滚动、省略号、关闭态）都来自真实项目误报。
- **判断与修复分离**：引擎只回答“对不对”，不自动改代码；修复后的回归由 `verify` 证明。

## 已知局限

- 不覆盖 shadow DOM、iframe、canvas 内部、WebGL。
- 动画/过渡中间态需要显式 `--no-wait-overlay` 或在动作后测量。
- 对比度检测跳过渐变/图片背景；`opacity` 叠加只做近似。
- 性能阈值是启发式（headless 环境帧率可能高于/低于真实设备）。
- S2 / S3 信噪比一般，适合参考不适合当门禁。
- 不判断业务语义（“过期按钮”、文案错误不属于布局验收）。
- **H1 被 `html/body{overflow-x:hidden}` 掩盖时查不到**（子代理审查 R2，未修：需要区分“故意裁切”与“掩盖溢出”）。
- **H4 只检查首屏采样点**：长页面下方被绝对定位浮层永久遮挡的按钮查不到（R4）。
- **fixed 底部操作栏**未像 sticky 头那样豁免：滚动可露出的按钮可能报 H4（R5）。
- **常驻 `aria-modal`**（不可见抽屉靠 transform 关闭）会让 H4/H5/S3 只查它内部（R9）；纯 transform 且无 `data-state` / `pointer-events` 信号的关闭抽屉仍可能报 H3（R1）。
- **H5 30% 面积阈值**对头像堆叠、`stretched-link` 可能误报（R3）。
- **`aria-hidden` / `inert` 子树整体不参与检查**（R8）：SPA 给 `#root` 加 aria-hidden 做 focus trap 时会整页空报告。

## 目录

```
bin/ui-guard.js      CLI（scan / verify / mcp）
src/scan.js          多视口扫描、交互状态、启动遮罩等待、性能采样
src/measure.js       页面内几何测量与全部规则
src/compare.js       回归指纹对比（new / persisting / fixed）
src/mcp.js           零依赖 MCP stdio server
fixtures/            带标注的测试页
test/                fixture 断言、MCP 端到端
REPORT.md            可行性验证与真实项目实测报告
```
