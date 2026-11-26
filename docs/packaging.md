# 打包与安装验证

## ⚠️ 不要用 `dsh plugin add <本地目录>`

`dsh plugin add` 只是转发给 pnpm。传一个**本地目录**时，pnpm 会建一个
`link:` 依赖（软链接到源码目录）。之后一旦执行：

```bash
dsh plugin --profile <p> remove <包名>
```

**pnpm 会把被链接的源目录一起删掉。** 这不是 DSH 的行为，是 `link:`
协议的语义——pnpm 认为自己拥有那个目录。

> 本仓库开发过程中真实踩过：一条 `remove` 把整个项目目录清空了。
> 靠会话日志重放才恢复（见下）。

`file:<目录>` 也不可靠：pnpm 会警告 "will not resolve the peer dependencies
from the target node_modules"，实际安装出空壳目录。

## ✅ 正确做法：先打包，再装 tarball

```bash
cd <插件目录>
pnpm pack                       # 产出 dsh-session-vault-0.3.0.tgz
dsh plugin --profile <p> add "file:<绝对路径>/dsh-session-vault-0.3.0.tgz"
```

好处有三个：

1. **走真实的 `files` 白名单**——能验证发布出去的东西是否完整（`dev/`、`test/`
   会不会被误打进去，一眼可见）
2. peer 依赖按正常规则解析，不会出现空壳目录
3. 不会因为 `remove` 删掉源码

`<p>` 用一个**临时 profile**，别动 `desktop`：

```bash
dsh plugin --profile svtest add "file:D:/.../dsh-session-vault-0.3.0.tgz"
dsh --profile svtest --dump-config            # 看插件有没有被正确插入
dsh --profile svtest --dump-config-schema     # 看 Config 有没有投影成表单字段
```

后两条是**零风险验证**：只解析配置、不启动宿主、不碰数据。
`--dump-config-schema` 里能看到自己插件的每个配置项（含 description 和 default），
就说明模块 import 成功、`Config` 导出正确、设置页会有这些字段。

## 灾难恢复：从会话日志重建

DSH 会话日志（`~/.dsh/sessions/**/session.v4.jsonl.zstd`）记录着每次工具调用的完整参数，
包括 `write` 的文件内容与 `edit` 的 old/new 字符串。

按 seq 顺序重放即可精确还原文件系统：

1. 解码多帧 zstd（见 `src/decode.js` 的 `decodeFrom`）
2. 顺序遍历 `tool/call` 记录，取 `name` 为 `write` / `edit` 的
3. `write` → 写文件；`edit` → 定位 `old_string` 并替换
4. 路径前缀重映射到恢复目录

注意点：

- **失败要跳过而不是中止**：有些 `edit` 当初就没成功（文件被别的操作改了），
  会被重试成新的调用；跳过即可，顺序重放自然会对上
- pwsh 里做的批量文本替换不会记成 `edit`，需要单独补
- 单纯的 `mv` / `ren` 不在日志里，要手工补

## ⚠️ `dsh plugin add` 会重写 `dsh.profile.bundles`

在 **desktop profile**（由 Electron 应用托管的那个）上实测过两次：

| 操作 | 后果 |
|---|---|
| 第一次 `add` | 只加了我们这一项，正常 |
| 第二次 `add`（升级版本） | **bundles 从 15 项被砍到 2 项**，其余 13 个插件全部掉出加载清单 |

`dependencies` 没丢，丢的是 `dsh.profile.bundles`——而插件是否加载**只看 bundles**。

所以每次在 desktop profile 上装/升级插件后，必须核对一次：

```powershell
(Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles
```

**装之前先备份 package.json**，出问题直接改回来：

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json" "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak"
```

## ⚠️ 客户端 bundle 里写错一个标识符，会让整个应用起不来

浏览器侧的报错会升级成宿主启动失败：

```
web boot: 1 entry did not activate
dsh-session-vault: import failed (see console for the import error)
```

排查要点：**看浏览器 DevTools 控制台**，宿主日志里只有这句摘要，没有根因。
实测遇到过的两个：

1. `_ModuleLoader__` 少一个下划线 —— 真实全局是 `window.__ModuleLoader__`
2. factory 里用了 `exports.apply = ...` —— `module` / `exports` 只有打包产物才有

所以客户端 bundle 里所有宿主提供的全局/变量都要**多路探测 + try/catch**，
宁可界面不出现，也不能让宿主启动失败。

## 遗留检查

- 临时 profile 用完可以删：`~/.dsh/profiles/<p>`
- `pnpm pack` 产出的 `.tgz` 别提交（加到 `.gitignore`）
