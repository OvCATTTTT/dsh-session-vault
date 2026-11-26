# 给开发者 / AI 助手的约定

在这个仓库里改动代码时必须遵守的规则。进仓库先读这份。

---

## 一、改代码必须同步两份文档

**任何对插件行为的改动**（新功能、改默认值、修 bug、改接口、改配置项），都要在同一个改动里同步更新：

| 文件 | 改什么 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | 新增一条版本记录：改了什么、**为什么改**。修 bug 要写清根因 |
| [docs/usage.md](docs/usage.md) | 如果用户能看到/用到这个改动，就更新对应章节（页面说明、常见任务、配置项、工具表、排障） |

**判断标准**：用户会不会因为这个改动而需要改变使用方式？
- 会 → 两份都要改
- 不会（纯内部重构、性能优化且行为不变）→ CHANGELOG 要写一条，usage 可以不改

过时的文档比没有文档更糟 —— 比如 README 曾长期写着"第一次使用会自动导入"，而实际上 0.3.4 起默认就不导入了。

## 二、版本号

`0.x.y`：
- `x` —— 加功能
- `y` —— 修 bug、调默认值、改文档

改完版本号记得 `pnpm pack` 验证包内容（`files` 白名单是否漏了文件）。

## 三、改完必须跑的检查

```bash
node --test "test/*.test.js"     # 全绿才算完
```

**改过 `src/index.js` 就必须盯着 boot 测试。** `node --check` 只验语法，抓不到「用了但没定义」的标识符 —— 0.4.12 就是这么挂的：入口调了一个没 import 的函数，语法全对、124 个单测全绿、安装也成功，但插件启动即自我禁用（这个设计保证不阻塞 DSH），结果设置页所有接口 404。

`test/boot.test.js` 用 `@deepseek-ai/*` 的桩模块**真的把入口跑一遍**，是唯一能兜住这类问题的东西。它还顺带验证：14 个工具、25 条路由、提示词 section、inbox 钩子全都注册上了。

涉及界面的改动，还要确认这几个静态断言没被破坏（`test/ui.test.js` 里）：
- `client.js` 里不许出现 `style: '`（字符串会崩 tab）
- `Sel` 的 options 只认 `[值, 标签]` 元组
- tab 组件里不许用 hooks（它们是被当普通函数调用的）
- 工厂函数必须 `return { inject, apply }`，不能用 `exports.x =`

## 四、打包安装（有坑）

**不要** `dsh plugin add <本地目录>` —— 会建 pnpm `link:` 依赖，之后 `remove` 会把源目录删掉。

正确做法和另外两个坑（`bundles` 会被重写、客户端 bundle 写错会让应用起不来）见 [docs/packaging.md](docs/packaging.md)。

装完必须核对 `dsh.profile.bundles` 条目数没变少。

## 五、写文档的风格

- 说人话，不写营销腔
- 数据要真实（"76 MB → 27 MB"而不是"显著减小"）
- 修了 bug 就写**根因**，不要只说"已修复"
- 做不到的事直说，别粉饰

## 六、目录速查

| 路径 | 内容 |
|---|---|
| `src/index.js` | 插件入口、工具与钩子注册；import `schemastery` 与 `dsh-home-paths` |
| `src/core.js` | `SessionVault` 门面（不依赖 DSH，可脱离宿主单独跑） |
| `src/db.js` | schema、补列 |
| `src/datadir.js` | 数据目录解析：显式配置 > 位置指针 > 自动探测（首次探测完写指针固化） |
| `src/ingest.js` | 会话日志解析、入库、摘要生成 |
| `src/indexer.js` | 关键词挖掘、倒排、共现边、排序 |
| `src/recall.js` | 检索（关键词层 + 扩散）、原文展开 |
| `src/policy.js` | 存/读策略三级解析、标签 |
| `src/pins.js` | 置顶（三种来源、三种模式、预算） |
| `src/routes.js` | 设置页 API（25 条） |
| `src/surfcore.js` | surfcore 记忆卡的**只读**适配器（不 import 它的模块，自己解析文件） |
| `src/surfcore-store.js` | surfcore 镜像层（只写自己的 `sc_records` 表） |
| `src/tools.js` | 模型工具（14 个 `memory_*`）；import `dsh-tools` 的 `defineTool` |
| `src/ui-data.js` | 设置页数据整形（纯函数，可单测） |
| `lib/client.js` | 设置页的 React 组件（手写 `h()`，不用 JSX） |
| `dev/ui.html` | 界面调试用的独立页面（不随包发布） |

## 七、这个项目的核心取舍（改代码前先理解）

1. **两层分离**：记忆层（摘要+关键词）只收 user/assistant 对话；归档层（events）保留工具内容。改摘要生成逻辑时不要破坏这个边界。
2. **默认全关**：不存、不读。任何"顺手打开"的默认值改动都要慎重。
3. **不遗忘**：events 只增不删（除了用户显式触发的「按内容范围重建」）。
4. **绝不拖垮宿主**：所有钩子、注入、界面注册都必须能失败而不影响 DSH 运行。
5. **surfcore 只读**：`src/surfcore.js` 里不许出现任何写操作。surfcore 的衰减/合并/落盘归它自己管，我们只旁观；写只写自己的 `sc_records`。
6. **默认值 ≠ 用户指定**：`defaults()` 填进去的值不代表用户选过。判断「用户有没有指定」必须看 `rawConfig`，不能看归一化后的 `cfg` —— 0.4.11 那个「改了数据位置、重启后还在 C 盘」的 bug 就是这么来的，两次"改默认位置"都没真正生效过。
