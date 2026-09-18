# dsh-mysql-studio

> 专门服务于 MySQL 的 DSH 插件：DataGrip 风格的连接管理、库表浏览与数据网格，直接开在 DSH 的右侧栏里。

**当前版本 0.6.0。** 已跑通：安装 → 连接（TCP / SSL）→ 浏览库/表/结构 → 分页读数据 → **编辑并提交行改动** → **SQL 控制台（读立即执行，写先预览原文）** → **新建库 / 新建表**，
以及 **agent 可以直接查库**（三个只读模型工具，见 [模型工具](#模型工具让-agent-直接查库)）。

0.6.0 砍掉了 SSH 隧道、Unix socket / 命名管道、TLS 的 `preferred` / `verify-identity` / 客户端证书，以及 `mysql_query` 的快照游标：插件作为 DSH 侧边栏已经够用，那些路径的重量配不上使用频率。

## 能力

| 能力 | 状态 |
| :-- | :-- |
| 多连接管理（保存 / 编辑 / 删除 / 连通性测试） | ✅ |
| 传输：基础 TCP（host/port/user/password/database/charset） | ✅ |
| 传输：SSL/TLS（disabled / required / verify-ca，可选 CA） | ✅ |
| 传输：连接 URL 粘贴解析（`mysql://`、`jdbc:mysql://`、裸 `host:port/db`） | ✅ |
| 传输：SSH 隧道 / Unix socket / 命名管道 | ⛔ 0.6.0 砍掉 |
| 对象浏览：库 → 表/视图 → 列结构 | ✅ |
| 表数据分页展示（主键稳定排序、`hasMore` 探测、无主键提示、行列分割线） | ✅ |
| **行改动提交**：单元格编辑、删除行、新增行、事务提交、冲突检测 | ✅ |
| **改动预览**：提交前显示将要执行的真实 SQL | ✅ |
| **新建库 / 新建表**：表单主路径 + 高级 SQL，执行前预览原文 | ✅ |
| SQL 控制台（Ctrl+Enter；读立即执行，写弹出原文确认；导出 INSERT） | ✅ |
| 右侧栏打开：自动适配 `dsh-better-sidebar` 与 DSH 原生右侧栏 | ✅ |
| **模型工具**：agent 可列连接、看结构、跑只读查询（`mysql_connections` / `mysql_schema` / `mysql_query`） | ✅ |
| 模型工具写库 | ⛔ 不做（见[安全边界](#安全边界)） |
| 导入 `dsh-sql` 已有连接配置 | 🚧 未实现 |
| 从剪贴板批量粘贴 / 复制为 UPDATE / CSV 导出 | 🚧 未实现 |
| 界面多语言（目前仅中文） | 🚧 未实现 |

## 安装

插件装在 DSH 的 web profile 里。本仓库用 `link:` 方式挂载本地源码：

```powershell
# 在 <本仓库> 目录下执行（会把依赖写进 profile 并建立链接）
pwsh -File scripts\install-profile.ps1
```

脚本做的事（幂等，可重复执行）：

1. 在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 加 `"dsh-mysql-studio": "link:<本仓库绝对路径>"`；
2. 把 `dsh-mysql-studio` 加进该 profile 的 `dsh.profile.bundles`；
3. 在 profile 目录执行 `pnpm install`。

装完**重启一次 `dsh web`**：Host 半（路由 + mysql2 连接池）与 Client 半（浏览器 bundle）都在启动时组装，
重启后硬刷新浏览器（Ctrl+Shift+R）即可在右侧栏看到 **MySQL Studio**。

重启前可以先跑一次自检，它会说清「还差什么」而不必让重启来发现问题：

```powershell
node scripts\verify-install.mjs
```

19 项检查，覆盖两个半各自的装载契约：

- **Host 半**：profile 声明与 bundle 层顺序、按包名解析、导入并注册路由、路由真答一个 `health` 请求、
  mysql2 能被插件自己的解析链找到；
- **Client 半**：`dsh.client.platform === "web"`（否则这一行会被**静默跳过**，没有 bundle、没有 UI）、
  `exports["./client"]` 存在且目标在盘上（声明了却缺这个导出会让**整个 boot 抛错**）、
  `external` 不自指、bundle 是 loader 格式且 id 等于包名。

如果能把 DSH 自己的 `@deepseek-ai/dsh-client-modules` 路径给它，它还会用**真实**的组合器函数验证：

```powershell
$env:DSH_CLIENT_MODULES = "<checkout>\node_modules\@deepseek-ai\dsh-client-modules"
node scripts\verify-install.mjs
```

这时会额外跑 `orderByModuleGraph`（真实图校验器接受这一行）与 `bootInjections`
（确认这个 bundle 真的会被塞进页面 payload）。本机实测这两项都通过。

**重启之后**，再跑一次针对**运行中部署**的端到端自检：

```powershell
node scripts\verify-live.mjs
node scripts\verify-live.mjs http://127.0.0.1:3080 "mysql://root:root@192.168.100.128:3307"
```

它与 `test/` 的区别是：`test/` 验证**源码**，它验证**装好并真的在跑的那个进程**——走浏览器同一条
HTTP 接口、打真实 MySQL。**23 项检查**覆盖：Host 半是否已挂载（未挂载时该路径是 404，挂载后才有插件
自己的 JSON 信封，这是两者唯一可区分之处）、非 POST 是否被插件自己拒绝、真实库能否连通、库表清单、
**复合主键下的翻页**、只读语句的字面量是否保留、只读闸门是否拦截写入（含 data-modifying CTE）、
`query.exec` 与建库是否只预览不执行、dry-run 是否不落盘、一批 update+insert+delete 是否提交、
陈旧原值是否被判为 conflict，以及**失败的那一批是否让表逐字节回到原状**。它创建一张临时表并在
`finally` 里删掉，也删掉自己保存的连接配置，跑完不留痕迹。

其中两条是**版本探针**：`a leftover Socket profile names the removed transport` 与
`the removed pk-row mode degrades to pk-changed instead of failing`。它们只在当前这版代码下才会通过，
所以对着「改了但没重启」的旧进程跑会红——**这是判断该不该重启的判据，比看进程号可靠**。

卸载：从 profile 的 `package.json` 里删掉这两处，再 `pnpm install`。

### 关于依赖：插件自带驱动

`package.json` 声明了 `mysql2`，**并且必须在插件目录里真的装出来**：

```powershell
cd <本仓库>
pnpm install
```

这不是可选项，是一次真实故障换来的规矩。`link:` 安装**不会**拉取被链接包自己的依赖，所以插件一度是靠
另一个插件（`dsh-sql`）的依赖树才拿到 mysql2 的——当那个插件被重装掉之后 mysql2 就消失了，本插件之所以
还能跑，只是因为**运行中的进程早就把模块缓存住了**，下一次重启就会全线失败。

现在 `loadMysql()` 的第一顺位锚点就是插件自己的依赖树（profile 下的锚点只作为源码检出的兜底），
而 `scripts/verify-install.mjs` 会**硬性**检查这件事——之前那条检查在成功和失败两个分支都报 `ok`，
所以它没能拦住这次故障，现在改掉了。

### 关于 mysql2 版本

`mysql2` 钉在 `3.24.4`。驱动在 TLS 上的行为跨版本会变——3.11.0 会把 IP 直接塞进 `servername`（触发
RFC 6066 警告）。钉住版本是为了让「这里验证过的行为」就是「你那里运行的行为」。

## 使用

侧边栏里通过「新建标签页」的引导页选择 **MySQL Studio**，或调用：

```js
ctx.get('mysqlStudio').open()      // 打开工作台
ctx.get('mysqlStudio').call('conn.list')   // 直接打接口
```

首次使用点右上角 **新建连接**，三种录入方式：

- **基础**：主机 / 端口 / 用户名 / 密码 / 默认库 / 字符集；
- **SSL/TLS**：TLS 模式 + 可选 CA（PEM 文本或文件绝对路径）；
- **URL 粘贴**：粘一条就自动拆字段，可再回「基础」页微调。

| 粘贴形式 | 说明 |
| :-- | :-- |
| `mysql://root:root@192.168.100.128:3307/case_prod?charset=utf8mb4&ssl-mode=required` | 原生 MySQL URI |
| `jdbc:mysql://h:3306/db?user=root&password=root&useSSL=true&connectTimeout=5000` | JDBC；`connectTimeout` 单位毫秒 |
| `192.168.100.128:3307/case_prod` | 裸地址，账号密码手填 |

### SSL/TLS 模式

| 模式 | 加密 | 校验证书链 |
| :-- | :-- | :-- |
| `disabled` | — | — |
| `required` | 必须 | — |
| `verify-ca` | 必须 | ✅ |

旧文档里的 `preferred` 读入时当成 `required`，`verify-identity` 当成 `verify-ca`。客户端证书不再携带。

### 旧连接文档怎么迁移

0.6.0 删掉了「传输方式」这个概念，所以老文档里可能还留着 `transport` / `ssh` / `socketPath` 字段。
处理方式是**折进直连 TCP**，而不是当成第二套连接方式留着：

| 老文档里的东西 | 读入后 |
| :-- | :-- |
| `transport: 'ssh'` + `ssh: {...}` | 丢弃；`host` 还在，照常作 TCP 直连 |
| `transport: 'socket'` + `socketPath` | 丢弃；**但没有 host，见下** |
| TLS 的 `preferred` / `verify-identity` | 折成 `required` / `verify-ca` |
| TLS 客户端证书 `cert` / `key` / `passphrase` | 丢弃（CA 保留） |

⚠️ **Socket 连接的文档里没有 host 键**——当时那个传输方式不需要主机。折掉传输方式之后它就成了一条没有主机的连接，
而**插件一律拒绝没有主机的连接**（`mysql2` 会把缺失的主机当成 `localhost`，那是另一台机器）。所以这里有两条防线：

- 连接路径上有一条通用不变量：**没有主机的 profile 一律不交给驱动**，直接报错说明原因；
- 编辑/保存这样一条连接时，报的是「这条连接用的是已移除的 Socket 传输……请编辑它并填写主机与端口」，
  而不只是「主机不能为空」——后者虽然也对，但会让人以为自己漏填了，而这条连接从来就没有主机可填。

它仍然会出现在连接列表里（一条坏记录不该让整个列表不可用），编辑补上主机即可恢复。

这些语义是**对着真实服务端实测过**的（见 `test/tls.test.mjs`）：
`disabled` 连接后服务端报告的 `Ssl_cipher` 为空，`required` 报 `TLS_AES_256_GCM_SHA384`，
`verify-ca` 会以 `HANDSHAKE_SSL_ERROR: self-signed certificate` 拒绝自签证书，
而把服务端自己的 CA 喂给 `verify-ca` 后连接成功。

### 编辑与提交

选中一张表后，在「数据」页：

- **双击单元格**进入编辑，`Enter` 提交该格、`Esc` 取消；留空后点 `∅` 显式写入 `NULL`。
  把值改回原样会自动取消该格的改动（不计入待提交）。
- 行尾 `✕` **删除整行**（提交后才生效，`↺` 可撤销）。
- 「**新增行**」在表格顶部插入一行草稿，填好后「加入」。**留空的列不进入 INSERT**，
  因此数据库默认值（含 `AUTO_INCREMENT`）会正常生效。
- 底部「待提交」条出现后，可以选择并发校验强度、**查看 SQL**、提交或放弃。

**提交前一定会显示将要执行的真实 SQL**，由 mysql2 自己的 `format` 渲染 —— 与真正执行的语句
出自同一个构造函数，所以预览不可能和执行漂移。

编辑只对**当前已加载的这一页**生效；唯一的行身份是主键。

#### 并发校验（丢更新检测）

提交时 WHERE 子句包含多少「原值」，决定能多早发现别人先改了同一行：

| 模式 | WHERE 包含 | 含义 |
| :-- | :-- | :-- |
| `pk` | 仅主键 | 最宽松：后写覆盖其他列 |
| `pk-changed`（默认） | 主键 + **本次要写的列**的原值 | 只保护你真正改动的格 |

> 0.6.0 砍掉了第三档 `pk-row`（主键 + 整行其他所有列的原值）。它的实际效果是**误报率高**：
> 别人动了这一行任意一格，你的提交就失败，而你只能刷新重来。`pk-changed` 保护的是真正有风险的那些格。
> 旧客户端若仍发 `pk-row`，会落到默认档而不是报错（客户端 bundle 与 Host 半各自重启的窗口里会出现这种情况）。

一条语句影响行数必须是 **1**：`0` 表示这一行已被他人改动或已不存在（返回 `conflict`，
提示刷新重试）；`> 1` 表示该条件不足以唯一定位单行，直接回滚。

一批改动**在同一个事务里**执行：任意一条失败，整批回滚，前面成功的写入不会留下。

## 模型工具（让 agent 直接查库）

除了给人用的侧边栏，插件还向模型注册三个**只读**工具。它们走的是同一个连接 store、同一批连接池、
同一道只读闸门——所以你在界面里配好的连接，就是 agent 查的那个连接。

| 工具 | 参数 | 作用 |
| :-- | :-- | :-- |
| `mysql_connections` | 无 | 列出已配置的连接（id、名称、地址、用户）。**永不返回任何密钥。** |
| `mysql_schema` | `connection`、`database?`、`table?` | 逐层看结构：不给 `database` 列库；给了列表/视图；再给 `table` 列字段（类型、可空、键、默认值、注释）。 |
| `mysql_query` | `connection`、`sql`、`database?`、`limit?` | 跑**一条**只读语句。默认 50 行、上限 500 行。超出上限报 `truncated`，请收窄 SQL 或在库内聚合，没有下一页。 |

`connection` 既接受 id 也接受连接名（大小写不敏感）；名字重复时会要求改用 id，并把候选 id 列出来。
找不到连接时，报错本身就带上所有可用的 id 和名字，好让 agent 下一次调用能直接成功，不必回头问你。

**没有游标。** 一次调用就是一次查询；要更多行就把 `limit` 调高（仍封顶 500），或者改 SQL。
没有 `ORDER BY` 的语句自己用 `LIMIT`/`OFFSET` 重跑会静默重复或漏行，所以这个工具不假装能翻页。

**为什么只有三个**：每个对模型可见的工具都在每次请求里占 prompt token，所以浏览结构做成了一个渐进式工具，
而不是三个平级工具。

**为什么没有写工具**：见下节。这是刻意的边界，不是没做完。

工具是**可选依赖**：`tools` 服务经 `ctx.inject` 取得，而不是写在插件的 `inject` 列表里。
于是一个没有装 `dsh-tools` 的 profile 仍然能正常加载这个插件（侧边栏照常工作），只是没有工具。
代价是「工具没上线」这件事是静默的，所以 `health` 接口会回报注册结果：

```powershell
# registryMounted 为 false 说明这个 profile 里没有工具注册表；names 为空说明进程是旧代码
(curl -s -X POST http://127.0.0.1:3080/mysql-studio/api/health | ConvertFrom-Json).result.modelTools
```

`verify-live.mjs` 会检查这一项，所以「改完代码忘了重启」不会悄悄过关。

## 安全边界

- **模型工具是只读的，且没有写入口**：注册给模型的三个工具里没有任何一个能改数据——
  `mysql_query` 与 `query.run` 共用同一道词法级只读闸门，而结构化写入（`data.mutate`）和
  带确认的 SQL 写（`query.exec` / `schema.create*`）**根本没有暴露给模型**。
  这条边界是针对 prompt 注入的：会话里读到的文本不该能变成一条 UPDATE。
- **模型看不到密钥**：`mysql_connections` 用的是一份显式字段白名单（不是 `publicProfile` 的顺带产物），
  测试逐字断言了返回的键集合，所以以后给 profile 加字段也不会连带泄给模型。
- **接口有信任围栏**：`/mysql-studio/api` 只服务 Host 头为回环、或属于 web runtime `trustedHosts` 的请求，
  其余一律 403。否则任意同源页面都能借你的进程读你的库。
- **密码不回传页面**：读接口一律返回 `hasPassword`，永不返回密码字段；页面留空表示「沿用已存密码」。
- **密码可完全落盘之外**：profile 支持 `passwordEnv`，连接时优先从该环境变量取密码。
- **只读闸门仍在 `query.run` 上**：先剥字符串与注释，再要求单条语句且以 SELECT/SHOW/DESCRIBE/EXPLAIN/WITH 开头，
  并拒绝 `INTO OUTFILE`、`FOR UPDATE`、`LOCK IN SHARE MODE`、多语句。模型工具只走这条路。
- **SQL 控制台的写走 `query.exec`**：读立即执行；写返回预览，只有 `confirmSql` 与预览原文逐字相同时才执行。
  改了输入框再点确认，发的仍是预览里那一条，不会把新编辑偷运过去。`LOAD DATA` / `INTO OUTFILE` 即使确认也不允许。
- **闸门看的是「真正会执行的语句」，不是开头那个词**。两种把写藏在读的动词后面的写法被显式处理：
  `WITH … DELETE / UPDATE / INSERT`（合法的 MySQL 8，以 `WITH` 开头，**曾实测可穿过闸门真的删掉一行**）
  与 `EXPLAIN ANALYZE`（与普通 `EXPLAIN` 不同，**会真正执行**被分析的语句）。
  CTE 列表按 `name [(列)] AS ( body )` 解析，识别不了就 fail closed；解析与守卫都有对照测试，
  既有「必须被拒」也有「必须放行」（后者包括 `WITH RECURSIVE t(n) AS … SELECT`——
  列清单里也有括号，朴素扫描会把它误判成写语句，而 fail closed 的闸门一旦误拒，代价是正常查询不能用）。
- **网格写入是参数化的**：所有值都作为绑定参数下发，从不拼进 SQL；库名/表名必须是纯标识符
  （字母数字下划线），列名先用反引号转义、并与 `information_schema` 的真实列清单核对。
- **网格写入是白名单制的**：`data.mutate` 只接受 `update` / `insert` / `delete` 三种结构化改动，
  不接受的列（二进制列、生成列、不存在的列）一律拒绝。
- **建库建表的表单路径也是白名单**：列类型只允许名字 + 精度 / UNSIGNED / CHARSET / COLLATE，
  `ENUM(...)` 之类带引号的声明走高级 SQL 页。高级 SQL 分别只允许 `CREATE DATABASE` / `CREATE TABLE`。
- **无主键即只读（网格）**：没有主键的表无法安全定位唯一一行，因此拒绝编辑与删除，并明确告知原因。
- **数值无损**：启用 `supportBigNumbers`，超出 JS 安全整数的 BIGINT/DECIMAL 以字符串返回；
  `dateStrings` 让日期以服务端原文本到达，避免时区漂移；二进制列以 base64 传输、按声明类型渲染成 `<BINARY n bytes>`。

连接配置存在 `~/.dsh/mysql-studio/connections.json`（原子写入）。

## 架构

```
lib/index.js   Host 半：/mysql-studio/api 路由、信任围栏、方法分派
lib/store.js   连接 profile：校验、归一化、URL 解析、TLS 映射、JSON 文档读写
lib/db.js      mysql2 解析、连接池注册表、目录内省、分页读取、只读闸门、SQL 控制台、建库建表、改动构造函数
lib/tools.js   Agent 半：三个只读模型工具，复用同一套 store / 池 / 闸门
lib/client.js  Client 半：手写浏览器 bundle（DSH __ModuleLoader__ 格式），全部 UI
```

几个刻意的选择：

- **Client 半不经过打包器**。它按 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 格式手写，
  只 `require('react')`（基线模块），不引入任何 UI 库依赖 —— 于是「改源码 = 改产物」，没有构建步骤会漂移。
- **走 HTTP 而不是 Remote Service**。客户端与 Host 之间是一条 `fetch` JSON 接口，
  和 `dsh-better-sidebar` 的做法一致：没有 Typert 代码生成，也没有跨端生命周期耦合。
- **模型工具是手写的原始 `ToolDefinition`**。DSH 第一方工具从 `@deepseek-ai/dsh-tools` 引入 `defineTool`，
  由它把一套作者友好的 DSL 编译成 JSON Schema 并替你校验参数。本插件引不到它：包在磁盘上是有的
  （dsh CLI 自己的安装目录里），但 Node 默认把软链解析成真实路径，于是本插件的模块身份是 checkout 所在盘，
  向上找 `node_modules` 走不到 DSH 的安装处——`link:` 装法的老问题，和「插件必须自带驱动」同一个根因。
  加上没有构建步骤（第一方那套是把 `defineTool` 打包内联进产物的），所以这里直接写编译后的形状——
  `defineTool` 做的正是 `parameterSchemaSpecToJsonSchema`，两者等价，而且手写的这份不依赖插件怎么摆放。
  代价是**校验义务归自己**：官方文档明确写了「a raw `ToolDefinition` validates its own input」，
  所以 `lib/tools.js` 里的 `checkArgs` / `requireString` 是契约的一部分，不是样板代码；
  而 `test/tools.test.mjs` 复刻了 DSH 强制的 JSON Schema 子集来校验这些手写 schema，
  因为写错的 schema 不会在写代码时报错，只会在 `ctx.tools.register()`（即插件加载）时炸。
- **SQL 构造是 Host 的纯函数**。`buildMutationPlan` 不碰连接，只吃「表结构 + 改动」返回语句与参数。
  于是校验、无操作过滤、NULL 安全定位、值绑定这整套安全面都能在没有数据库的情况下被逐个钉死，
  而浏览器里的 `buildMutations` 只是它的薄对应物。
- **侧边栏自动适配**（见 `lib/client.js` 的 `install`）：`ctx.betterSidebar` 存在就用它注册
  （dsh-better-sidebar 会把它再提升成原生 tab 类型，并附赠引导页条目与设置页开关）；
  不存在则回退到 DSH 原生 `ctx.sidebarRightTabs` + `ctx.sidebarRight`。
  决策会短暂延后：客户端 bundle 按组装顺序实例化，而 `betterSidebar` 是 dsh-better-sidebar 在自己的
  `apply` 里发布的 —— 一看到 `sidebarRightTabs` 就锁定原生路径，会偶发地丢掉更完整的那个集成。

## 测试

```bash
node --test "test/**/*.test.mjs"
```

测试覆盖 Host 半、Client 半、TLS、写入、HTTP 和模型工具。**165 个用例全绿。** 连不上数据库的用例跳过而不是失败。

- `test/host.test.mjs` —— URL 解析、profile 归一化、TLS 模式映射、只读闸门
  （含三条回归：「守卫返回的必须是调用方原句」、「data-modifying CTE 与 `EXPLAIN ANALYZE` 必须被拒」、
  「合法 CTE 读取不能被误拒」）、建库建表 SQL 构造、INSERT 导出、旧文档残留密钥的脱敏、连接池重建、
  **带确认的 SQL 写与建库建表在真库上跑通**；
- `test/transport.test.mjs` —— TCP 直连的 profile 形状；旧 `ssh` / `socket` / `preferred` / `verify-identity`
  字段必须被丢掉或折进仍支持的模式；
- `test/tls.test.mjs` —— 针对真实服务端的 TLS 实测：各模式实际协商出的 cipher、
  自签证书被 `verify-ca` 拒绝、信任服务端 CA 后成功；
- `test/mutation.test.mjs` —— 改动构造函数的全部安全面；
- `test/write.test.mjs` —— 真实 MySQL 写入路径：dry-run、增改删、冲突、整批回滚；
- `test/client.test.mjs` —— 桩 loader + 桩 React 加载真实 bundle：侧边栏适配、列分割线、INSERT 导出、连接表单；
- `test/api.test.mjs` —— 真实插件 + 真实 HTTP：围栏、密码不回传、提交/冲突/回滚、`query.exec` / 建库建表确认闸门；
- `test/tools.test.mjs` —— 模型工具 schema 子集、返回值反校验、单次上限 + `truncated`、CTE 写在建连前被拒。

写入类用例全部跑在自动创建并**在 `finally` 里删除**的临时表 `__dsh_mysql_studio_probe` 上，
优先选 `case_test` 库；连不上数据库时**跳过**而不是失败。可用环境变量指向别的实例：

```powershell
$env:DSH_MYSQL_STUDIO_TEST_URL = "mysql://user:pass@host:3306/db"
```

> 在受限沙箱里跑：Node 的测试运行器会用管道 spawn 子进程，被拒时改用
> `node --test --test-isolation=none "test/**/*.test.mjs"`（进程内运行，同样断言完整）。

## 路线图

已完成：连接管理（TCP / SSL / URL）、对象浏览、分页数据、
**行改动提交与冲突检测**、SQL 控制台（读立即 / 写确认 / 导出 INSERT）、新建库表、侧边栏接入、**只读模型工具**。

0.6.0 已砍：SSH 隧道、Unix socket / 命名管道、TLS `preferred` / `verify-identity` / 客户端证书、`mysql_query` 快照游标。

下一步按此顺序推进：

1. **编辑体验**：从剪贴板批量粘贴成一列、多行选中、复制为 UPDATE、CSV 导出。
2. **界面多语言**：接入 `ctx.locale` 词典，跟随 DSH 语言切换（目前仅中文）。
3. **模型工具的下一步**（如果实测下来确实需要）：把表数据分页读取也做成工具。写入不在计划内。

已作废：导入 `dsh-sql` 连接配置——`dsh-sql` 已被移除。

## License

MIT
