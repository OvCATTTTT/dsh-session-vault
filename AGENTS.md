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

## 三之二、每个版本必须提交 git

**一个版本 = 一个提交。** 不要把几个版本攒成一个提交。

### 为什么单独列一条

0.3.0 到 0.4.18 十几个版本**一条提交记录都没有** —— 全部被裹进 11-26 那次
「开源发布准备」的初始快照里。那十几个版本改了什么、为什么改，git 里查不到，
只能翻 CHANGELOG。0.5.1 / 0.5.2 / 0.5.3 也挤在同一个提交里。

根因不是「忘了」，是上面这份检查清单里**压根没写 git 这一步**。所以补上。

### git 在哪

这台机器上 git 是**便携版 MinGit，不在 PATH 里**，`where git` 找不到。
它放在本仓库的**同级目录** `.tools/mingit/` 下：

```
<仓库所在目录的父级>\.tools\mingit\cmd\git.exe
```

具体路径按你的机器实际位置填。每次都写全路径，或者先 `$git = "..."` 存起来。

### 提交流程

```powershell
$git = "<你的 minGit 路径>\cmd\git.exe"
cd dsh-session-vault
& $git add -A
& $git status --short          # 确认没把 *.tgz / tmp/ 加进去
& $git commit -F <说明文件>     # 用 -F 而不是 -m，避免 PowerShell 转义踩坑
```

### 提交说明写什么

和 CHANGELOG 同源，但**短一些**：这一版改了什么、为什么改；修 bug 写根因。
标题格式 `feat:` / `fix:` / `docs:` / `test:` + 一句话 + `(版本号)`。

### 提交前必须自查三件事

1. **`.tgz` 和 `tmp/` 没被加进去** —— 它们在 `.gitignore` 里，但 `add -A` 之后
   还是要看一眼 `git status`
2. **提交说明里没有本机绝对路径** —— 曾经把开发机的绝对路径和真实用户名写进
   公开仓库的 commit message，后来只能重写历史强推
3. **没有 token / 密钥** —— GitHub token 曾经在命令里明文出现过

### 推送

默认**不推**。仓库是公开的，推送等于发布。想推之前先问，
而且要先处理与远程的分叉（`git log HEAD..origin/main` 看远程有没有新提交）。

#### GitHub 直连会被掐断，必须走代理

这台机器上 **GitHub 直连不通**，表现很有迷惑性：

| 检查 | 结果 |
|---|---|
| 百度 / DeepSeek | ✅ 通（说明没断网） |
| DNS 解析 github.com | ✅ 有结果 |
| TCP 443 握手 | ✅ 通 |
| HTTPS 请求 | ❌ `Connection was reset`，连接耗时 0 |

TCP 能连、TLS 被重置 —— 这是 TLS 层干扰，不是网络故障。
本机有 Clash 在 **7890** 端口跑着，git 默认不走它，所以必须显式加代理：

```powershell
$proxy = "http://127.0.0.1:7890"
& $git -c http.proxy=$proxy fetch <url>
& $git -c http.proxy=$proxy push  <url> main:main
& $git -c http.proxy=$proxy ls-remote <url> HEAD
```

**用 `-c` 临时传，不要写进 git config** —— 别把这个仓库的代理设置带到其他项目。

排查顺序（下次又连不上时按这个走）：
1. `curl -sI https://www.baidu.com` 通不通 → 排除整体断网
2. `Resolve-DnsName github.com` 有没有结果 → 排除 DNS
3. 前面都正常但 HTTPS 失败 → 就是 TLS 被干扰，走代理
4. 代理端口用 `Get-NetTCPConnection -LocalPort 7890 -State Listen` 确认在监听

### 发 Release

README 里的下载链接指向 `releases/latest`，所以**推完代码还要发 release**，
否则用户点进去下到的是上一个版本。

三步（`gh` 没装，全走 API + curl，同样要带代理）：

```powershell
# 1. 打 tag 并推上去
& $git tag -a v0.6.3 -m "v0.6.3"
& $git -c http.proxy=$proxy push <url> v0.6.3

# 2. 建 release（拿返回里的 upload_url）
curl -s --proxy $proxy -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" `
  -d '{"tag_name":"v0.6.3","name":"v0.6.3","body":"..."}' `
  https://api.github.com/repos/<owner>/<repo>/releases

# 3. 上传 .tgz 资产（upload_url 要把 {?name,label} 去掉）
curl -s --proxy $proxy -H "Authorization: Bearer $token" `
  -H "Content-Type: application/octet-stream" `
  --data-binary "@dsh-session-vault-0.6.3.tgz" `
  "<upload_url>?name=dsh-session-vault-0.6.3.tgz"
```

**发完必须验证匿名下载**（不带 token）：302 → 200、大小和 SHA256 和本地一致。

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
