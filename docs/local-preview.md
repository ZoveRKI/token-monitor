# 独立本地预览

本地预览用于在保留正式版的同时检查 Claude 额度问题。它使用独立应用身份和数据目录，初始没有凭据，也不扫描本机用量。启动后，在预览应用的 Claude 设置中手动填写自己的 Web `sessionKey`；这会向 Claude 发出真实请求。

预览运行当前工作区的代码，可用于验证 Issue #876 的组织选择修复及后续修改。当前策略按账号与组织分别显示多个订阅，隐藏明确 Free，以及套餐未知且成功返回空额度的组织。

## 离线模拟账号

没有真实账号时，在项目根目录运行 `npm run preview -- --mock` 启动 **Token Monitor Preview Mock**。若希望使用独立 `.app`，运行 `npm run pack:preview -- --mock`，再打开本次输出的 **Token Monitor Preview Mock.app**。

`--mock` 使用 `tmp/local-preview/mock-runtime/`，与真实 Cookie 预览的 `runtime/` 分开。模拟模式的 Claude transport 只返回内存数据，不会将任何输入的 key 发往真实网站，也不读取浏览器或真实预览中的 Cookie。正式应用和普通预览仍使用原来的真实请求。

在模拟预览的「设置 → AI 工具额度 → Claude Code 选项」中，复制下表右列的完整值，点击「保存 Cookie」，关闭设置后切换到「额度」视图。换一个值再保存即可切换场景，无需重新启动。每组数据都附带一个空额度 Free 组织，用来确认它不会出现。

| 模拟账号 | 场景 | 复制到 Cookie 输入框的内容 |
| --- | --- | --- |
| user1 | 两个 Team：Design Studio、Research Lab | `sessionKey=sk-ant-preview-user1` |
| user2 | Personal Pro + Company Team | `sessionKey=sk-ant-preview-user2` |
| user3 | Personal Max + 两个 Team；Max 另有 Fable 周额度 | `sessionKey=sk-ant-preview-user3` |
| user4 | 只有 Free：显示无付费额度提示 | `sessionKey=sk-ant-preview-user4` |
| user5 | Pro 正常、一个 Team 返回无权限 | `sessionKey=sk-ant-preview-user5` |
| user6 | Team 订阅存在，但接口没有额度窗口 | `sessionKey=sk-ant-preview-user6` |

这些是公开的测试字符串，不是真实登录凭据，仅供模拟模式使用。账号名是说明标签，输入框仍只接受 `sessionKey=…` 或裸 `sk-ant-…`，不要粘贴 `user1-sessionKey:` 前缀。未知的 key 会显示 Cookie 校验失败。

模拟额度的使用率固定，重置时间以本次模拟应用启动时间计算。user3 应显示：Personal Max 的 Session 剩余 88%、Weekly 剩余 66%、Fable 剩余 93%；Design Studio Team 剩余 55%／33%；Research Lab Team 剩余 10%／7%。测试数据位于 `src/electron/preview/claudeMock.js`。

## 启动与检查

需要 Node.js >=22.15.0，以及已经安装好的本项目依赖、Electron 框架。启动命令不会自动安装依赖；缺少内容时会明确停止。首次打包时 electron-builder 可能下载辅助工具到项目的构建缓存，后续会复用缓存。安装或补齐二进制应在允许联网后执行。

| 命令 | 用途和结果 |
|---|---|
| `npm run preview -- --check-only` | 只读检查本地依赖并显示隔离目录，不启动应用。 |
| `npm run preview -- --prepare` | 创建预览运行及缓存目录，再检查依赖，不启动应用。 |
| `npm run preview` | 使用本地 Electron 启动独立预览，随后手动配置 Claude Cookie。 |
| `npm run pack:preview -- --check-only` | 检查 macOS arm64 打包条件，包括项目锁定的 tokscale 二进制。 |
| `npm run pack:preview` | 在新的 `dist/preview/<构建标识>/` 中生成 `Token Monitor Preview.app`，完成后不自动打开。 |

`--check-only` 不创建目录；`--prepare` 仅准备目录，不会复制正式版设置或凭据。两者都会在依赖缺失时返回非零退出码。不要将它们同时使用。

在项目根目录运行上述命令。查看代码修改时，退出已有预览进程，再运行 `npm run preview`；当前没有热更新。若使用打包的 `.app`，每次修改后需重新运行 `npm run pack:preview`，再打开新输出目录中的应用。

手动配置入口：窗口右下角设置 → AI 工具额度 → Claude Code 选项。粘贴 Claude 网站 Cookies 中的 `sessionKey` 值并点击「保存 Cookie」，再关闭设置、切换到「额度」视图查看结果。Cookie 的格式错误会在保存时提示；保存成功后仍需检查选中组织的实际额度响应。

打包目前要求 macOS arm64。构建直接使用 `node_modules/electron/dist`，禁用依赖重建、公证和发布，不加入 macOS Widget 扩展。应用只做本机 ad-hoc 签名，不使用正式签名证书。打包前会离线核对 tokscale 的版本与 SHA-256；不匹配时，需要先单独执行项目已有的 `npm run ensure:tokscale`，该命令可能下载并替换项目依赖中的二进制。

## 数据隔离

所有路径均相对于本项目目录：

| 路径 | 内容 |
|---|---|
| `tmp/local-preview/runtime/user-data/` | 预览专用的 Electron 设置与凭据。 |
| `tmp/local-preview/runtime/session/` | 预览专用的 Chromium 会话数据。 |
| `tmp/local-preview/runtime/shared/` | 预览专用的 shared data，包括 collector anchor 和历史数据路径。 |
| `tmp/local-preview/runtime/tokscale/` | 预览专用的 tokscale 配置及缓存。 |
| `tmp/local-preview/runtime/logs/`、`crashes/` | 预览日志和崩溃数据；两者都位于 runtime 下。 |
| `tmp/local-preview/cache/npm/` | 预览子进程使用的 npm 缓存。 |
| `tmp/local-preview/cache/electron/` | 预览子进程使用的 Electron 缓存。 |
| `tmp/local-preview/cache/electron-builder/` | 预览构建工具缓存。 |
| `dist/preview/<构建标识>/` | 每次打包的新输出目录，避免覆盖先前产物。 |

这些目录已被项目 `.gitignore` 排除。Cookie 只在预览设置中手动录入，不会从正式版设置复制。预览目录仍可能包含真实凭据，不要把整个目录作为调试附件发送。

`npm run preview` 启动的源码版本与 `Token Monitor Preview.app` 共用本项目的同一份 runtime profile，包括 Cookie 和单实例锁。两种启动方式不各建一份账号数据；它们都与正式版的数据目录和锁独立。打包时将本项目运行目录的绝对路径写入预览应用元数据，方便从 Finder 启动时继续使用同一目录。因此该 `.app` 只用于本机，不应当作发布包分发；移动项目后应重新打包。

## 隔离范围

预览入口在获取单实例锁前设置独立的 Electron 路径，同时隔离 shared data 和 tokscale 配置。启动脚本在 Electron 加载前就按环境变量白名单清理已有 provider 凭据、Hub 配置和 Node 预加载选项；应用入口会再次清理。项目 `.env` 不会载入。构建子进程保留需要的构建环境，去除 Node 预加载、发布令牌和正式签名身份。

预览设置持续限制为 Local 模式、无用量扫描、无 Hub/iCloud 同步。没有 Cookie 时不启用任何额度 provider；录入 Cookie 后只启用 Claude Web，清除 Cookie 后也不会自动回退到系统 Claude OAuth/CLI。Cursor 等账号状态请求返回空结果；其他主进程调用按允许列表处理，拒绝未开放的操作。窗口显示、关闭和布局事件仍正常工作。

后台汇率刷新、tokscale npm 检查、应用更新检查、macOS Widget 注册与发布、启动项、Discord 和自动导出均关闭。正式版可以继续运行；预览不会替换或卸载它。

这是应用层的开发隔离，不是操作系统沙箱。应用仍以当前用户权限运行，后续代码修改可能改变隔离行为。普通预览手动录入 Cookie 后，额度读取和 Cookie 续期会向 Claude 发出真实请求。如果复制的是浏览器或正式版使用的同一个 Claude 会话，服务端的会话续期、轮换或失效仍可能影响其他使用者；本地目录隔离无法隔离这类服务端状态。`--mock` 的 Claude 请求只由内存 transport 响应，不产生这些真实请求。
