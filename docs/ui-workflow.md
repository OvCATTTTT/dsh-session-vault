# 界面开发流程（下次照这个做）

> 一句话：**先在 `dev/ui.html` 里当普通网页调好，再用 headless Edge 截图验收，
> 最后翻译成 `lib/client.js` 里的 `h()`。**

## 为什么是两步

DSH 官方 `practices.md` 明确写着：

> Render plugin pages as React components in a slot. **Do not serve an HTML page from
> the Host and embed it in an iframe**: an iframe document does not receive the host's
> theme tokens, light/dark switching, or `ctx.locale`.

所以最终形态必须是 React 组件。但 React 组件只有装进 DSH 才能看到效果，而
**装插件要重启 DSH**——改一行样式就要重启一次，这个循环没法用。

两步走就是解决这个矛盾：

| 阶段 | 在哪改 | 怎么看效果 | 迭代速度 |
|---|---|---|---|
| ① 设计 | `dev/ui.html` | 浏览器刷新 / 截图 | 秒级 |
| ② 落地 | `lib/client.js` | 必须重启 DSH | 分钟级 |

只有①调稳了再进②，能把重启次数从几十次降到一两次。

## 步骤

### ① 起开发服务

```bash
node scripts/dev-ui.js --data ./dev-db
# → http://127.0.0.1:8790/dsh-session-vault/ui
```

这个服务做两件事：

- 直接用**真实的** `src/routes.js`（用一个假 `webServer` 把路由收进 Map 再挂到 http 上），
  所以调的是真接口，不是另造一套假数据
- 每请求都从磁盘读 `dev/ui.html`，**改完刷新，服务不用重启**

### ② 截图验收

```powershell
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
& $edge --headless=new --disable-gpu --hide-scrollbars `
  --user-data-dir="$env:TEMP\sv-shot" --window-size="1000,900" `
  --virtual-time-budget=7000 `
  --screenshot="docs/ui-sessions.png" `
  "http://127.0.0.1:8790/dsh-session-vault/ui?theme=light&tab=sessions"
```

页面支持两个查询参数（专门为截图和深链做的）：

- `?theme=light|dark` —— 强制主题
- `?tab=overview|sessions|terms|ops` —— 直达标签页

**深色模式一定要截一张**。这是当初 iframe 方案出问题的地方——只看浅色以为没事，
切深色一堆颜色是写死的。

### ③ 翻译成 `h()`

对照表：

| 网页里 | React `h()` 里 |
|---|---|
| `<div class="x">` | `h('div', {className: 'x'})` |
| `el.textContent = 'a'` | `h('div', null, 'a')` |
| `style="a:b"` | `style: { a: 'b' }`（驼峰） |
| `el.onclick = fn` | `onClick: fn` |
| `input.value + oninput` | `value` + `onChange`（受控） |
| `document.createElement` 循环 | `array.map(item => h(...))`，**必须给 `key`** |
| `<style>` 标签 | `h('style', null, CSS)` 作为组件子节点（卸载自动移除） |

### ④ 自检清单（提交前逐条过）

- [ ] 没出现 `iframe`
- [ ] 没 `require('@deepseek-ai/dsh-client-ui-*')` —— 官方禁止，且会随版本变
- [ ] 颜色全部是 `var(--dsw-alias-*)`，没有 `#fff` / `rgb(...)` 这类字面值
  （图表/插画的固有颜色除外）
- [ ] 外层套了错误边界（组件一抛错，整个 slot 条目会变空白）
- [ ] 所有 `setTimeout` / `setInterval` / `addEventListener` 在卸载时清理
- [ ] 每个 `map` 出来的元素都有 `key`
- [ ] 深色模式截图确认过

## 真实主题 token 清单

从 `app.asar` 里 `@deepseek-ai/dsh-client-ui-*` 的实际代码里抽出来的，**只用这些**：

```
--dsw-alias-bg-layer-1 / -2 / -3    背景层次
--dsw-alias-settings-card-fill      设置卡片底色（推荐）
--dsw-alias-settings-card-stroke    设置卡片描边（推荐）
--dsw-alias-border-l2 / l3 / l4     边框
--dsw-alias-fill-tsp-secondary      浅填充（进度条底、徽标底）
--dsw-alias-interactive-bg-hover    悬停
--dsw-alias-label-primary           主文本
--dsw-alias-label-secondary         次文本
--dsw-alias-label-tertiary          弱文本
--dsw-alias-label-caption           最弱文本（等宽小字）
--dsw-alias-label-quaternary
--dsw-alias-state-business-primary  主色/品牌色
--dsw-alias-state-error-primary     错误色
```

> 写 `var(--dsw-alias-x, 回退值)` 更安全：token 改名最多影响外观，不会让渲染崩掉。

## 查官方 API 的两个脚本

不要靠猜，也不要只抄第三方插件。官方源码就在本地 `app.asar` 里：

```bash
# 按内容搜（找某个 API 的官方用法）
node scripts/asar-grep.js "settings.section" "slots.register("

# 列目录 / 导出单个文件来看完整实现
node scripts/asar-dump.js --list  "dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills"
node scripts/asar-dump.js --dump  "dsh/node_modules/@deepseek-ai/dsh-client-ui-agent-preset/lib/client.js"
```

导出的东西落在 `asar-dump/`（已 gitignore）。

**最有价值的一份文档**：

```
dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/
  SKILL.md
  references/practices.md      ← 最重要，插件开发的总规矩
  references/ui-plugin.md
  references/host-plugin.md
  templates/decoration/        ← 客户端模板（含 client.js 写法）
```

## 上一版踩过的坑（别再踩）

| 坑 | 现象 | 原因 |
|---|---|---|
| 用 iframe | 深色模式下界面还是白的 | iframe 拿不到父窗口的 CSS 变量 |
| 样式写死颜色 | 主题一切换就瞎 | 应该只用 `--dsw-alias-*` |
| 组件抛错没有边界 | **整个设置页那一块变空白** | 官方说 "a throwing component blanks your slot entry" |
| 改了宿主 JS 不重启 | 改完没反应 | 只有 `dev/ui.html` 是热读的，`src/*.js` 必须重启 |
| 页面加载后先渲染空 state | 出现一闪而过的空白 | 先 `render()` 再 `loadAll()`，数据回来再 `render()` |
| **factory 里用 `exports.apply = ...`** | **设置页里根本没有这一栏**，宿主日志也没有明显报错 | `module` / `exports` 是打包产物才有的变量；手写 bundle 里一求值就 `ReferenceError`，插槽注册整段不执行 |

### 关于最后那条（真实踩过）

`_ModuleLoader__.load({ id, factory })` 的 `factory` 必须**返回模块命名空间**：

```js
factory(require) {
  const React = require('react');
  // ...
  return { inject, apply };      // ← 官方模板写法，手写 bundle 只能用这个
}
```

带构建步骤的插件（surfcore、官方 `dsh-client-ui-*`）代码里写的是
`exports.apply = apply; return module.exports;`，因为打包器会注入
`module` / `exports`。**手写 bundle 照抄这段会静默失败**：浏览器只报一个
`ReferenceError: exports is not defined`，而宿主侧（工具、路由、数据库）一切正常，
所以极难定位。

**排查方法**：打开浏览器 DevTools 控制台，看有没有 `ReferenceError`。
宿主日志里不会有任何提示。

## 改了 CSS / 布局怎么验证

`dev/ui.html` 是早期设计稿，**早就和真实组件不同步了**，别拿它当参考。

用 `scripts/render-preview.mjs`：它用最小的假 React 跑 `lib/client.js`，
把 `__tabs` 里的组件渲染成静态 HTML（CSS 也是从 client.js 里抠出来的真样式），
再配无头浏览器截图：

```bash
node scripts/render-preview.mjs tmp/preview
# 然后用 Edge/Chrome --headless --screenshot 截 tmp/preview/*.html
```

注意两点：
- HTML 里的 `<select value="x">` **不会生效**（需要 `<option selected>`），
  所以截图里下拉永远显示第一项。这是截图的局限，不是 bug。
- 假数据在脚本里改，能覆盖窄面板（460px）和正常宽度两档。

0.4.7 那两个布局 bug（会话行挤成一团、关键词页下拉撑满）就是靠这个发现的。
