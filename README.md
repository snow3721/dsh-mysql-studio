# dsh-mysql-studio

> 专门服务于 MySQL 的 DSH 插件：DataGrip 风格的连接管理、库表浏览与数据网格，直接开在 DSH 的右侧栏里。

在 DSH（DeepSeek Harness）的 web 界面里开一个 MySQL 工作台：连库、看结构、翻数据、**改行并提交**、
跑 SQL、建库建表。同一套连接对 agent 也开放——插件注册了三个**只读**模型工具，agent 能列连接、
看结构、跑查询，而没有任何一条路径能让它改数据。

```
安装 → 连接（TCP / SSL / URL）→ 浏览库/表/结构 → 分页读数据 → 编辑并提交行改动
     → SQL 控制台（读立即执行，写先预览原文）→ 新建库 / 新建表
     → agent 直接查库（三个只读模型工具）
```

## 能力

| 能力 |
| :-- |
| 多连接管理（保存 / 编辑 / 删除 / 连通性测试） |
| 传输：基础 TCP（host / port / user / password / database / charset） |
| 传输：SSL/TLS（`disabled` / `required` / `verify-ca`，可选 CA） |
| 传输：连接 URL 粘贴解析（`mysql://`、`jdbc:mysql://`、裸 `host:port/db`） |
| 对象浏览：库 → 表/视图 → 列结构 |
| 表数据分页展示（主键稳定排序、`hasMore` 探测、无主键提示、行列分割线） |
| **行改动提交**：单元格编辑、删除行、新增行、事务提交、冲突检测 |
| **改动预览**：提交前显示将要执行的真实 SQL |
| **新建库 / 新建表**：表单主路径 + 高级 SQL，执行前预览原文 |
| SQL 控制台：读立即执行，写弹出原文确认，结果可导出 INSERT |
| 右侧栏打开：自动适配 `dsh-better-sidebar` 与 DSH 原生右侧栏 |
| **模型工具**：agent 可列连接、看结构、跑只读查询 |

## 安装

插件挂在 DSH 的 web profile 里。本仓库以 `link:` 方式挂载本地源码：

```powershell
# 在本仓库目录下执行
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-profile.ps1
```

脚本是幂等的，做三件事：

1. 往 `~/.dsh/profiles/web/package.json` 的 `dependencies` 里加 `"dsh-mysql-studio": "link:<本仓库绝对路径>"`；
2. 把 `dsh-mysql-studio` 加进该 profile 的 `dsh.profile.bundles`；
3. 在 profile 目录执行 `pnpm install`。

装完**重启一次 `dsh web`**，然后硬刷新浏览器（Ctrl+Shift+R）。Host 半（路由 + 连接池）与
Client 半（浏览器 bundle）都在启动时组装，只刷新页面不会加载新的 Host 代码。

### 依赖必须装在插件目录里

`package.json` 声明了 `mysql2`，**并且必须在插件目录里真的装出来**：

```powershell
pnpm install
```

这不是可选项。`link:` 挂载**不会**代拉被链接包自己的依赖，所以漏掉这一步的典型症状是：
插件此前一切正常（mysql2 碰巧由别的包带进了模块缓存），某次重启后全线失败。
`lib/db.js` 的第一顺位解析锚点就是插件自己的依赖树，`scripts/verify-install.mjs` 会**硬性**检查它是否真在。

`mysql2` 钉在 `3.24.4`：驱动在 TLS 上的行为跨版本会变（3.11.0 会把 IP 直接塞进 `servername`，
触发 RFC 6066 警告）。钉住版本是为了让「这里验证过的行为」就是「你那里运行的行为」。

### 卸载

从 profile 的 `package.json` 里删掉 `dependencies` 与 `dsh.profile.bundles` 两处的 `dsh-mysql-studio`，
再在该目录 `pnpm install`。

## 使用

在侧边栏「新建标签页」的引导页里选择 **MySQL Studio**；也可以在插件上下文里直接调用：

```js
ctx.get('mysqlStudio').open()              // 打开工作台
ctx.get('mysqlStudio').call('conn.list')   // 直接打接口
```

首次使用点右上角 **新建连接**，三种录入方式：

- **基础**：主机 / 端口 / 用户名 / 密码 / 默认库 / 字符集；
- **SSL/TLS**：TLS 模式 + 可选 CA（PEM 文本，或一个 CA 文件的绝对路径）；
- **URL 粘贴**：粘一条就自动拆字段，之后可以回「基础」页微调。

| 粘贴形式 | 说明 |
| :-- | :-- |
| `mysql://user:pass@db.internal:3306/app?charset=utf8mb4&ssl-mode=required` | 原生 MySQL URI |
| `jdbc:mysql://db.internal:3306/app?user=root&password=secret&useSSL=true&connectTimeout=5000` | JDBC；`connectTimeout` 单位毫秒 |
| `db.internal:3306/app` | 裸地址，账号密码手填 |

连接配置存在 `~/.dsh/mysql-studio/connections.json`（原子写入）。

### SSL/TLS

| 模式 | 加密 | 校验证书链 |
| :-- | :-- | :-- |
| `disabled` | — | — |
| `required` | 必须 | — |
| `verify-ca` | 必须 | ✅ |

这三个模式的语义是**对着真实服务端实测过**的（见 `test/tls.test.mjs`）：`disabled` 连接后服务端报告的
`Ssl_cipher` 为空，`required` 报 `TLS_AES_256_GCM_SHA384`，`verify-ca` 会以
`HANDSHAKE_SSL_ERROR: self-signed certificate` 拒绝自签证书，而把服务端自己的 CA 喂给 `verify-ca`
之后连接成功。

### 数据网格与提交

选中一张表后，在「数据」页：

- **双击单元格**进入编辑，`Enter` 提交该格、`Esc` 取消；清空后点 `∅` 显式写入 `NULL`。
  把值改回原样会自动取消这一格的改动（不计入待提交）。
- 行尾 `✕` **删除整行**（提交后才生效，`↺` 可撤销）。
- 「**新增行**」在表格顶部插入一行草稿，填好后「加入」。**留空的列不进入 INSERT**，
  因此数据库默认值（含 `AUTO_INCREMENT`）会正常生效。
- 底部「待提交」条出现后，可以选择并发校验强度、**查看 SQL**、提交或放弃。

**提交前一定会显示将要执行的真实 SQL**，由 mysql2 自己的 `format` 渲染——与真正执行的语句出自同一个
构造函数，所以预览不可能和执行漂移。

编辑只对**当前已加载的这一页**生效；唯一的行身份是主键。

#### 并发校验（丢更新检测）

提交时 WHERE 子句里包含多少「原值」，决定能多早发现别人先改了同一行：

| 模式 | WHERE 包含 | 含义 |
| :-- | :-- | :-- |
| `pk` | 仅主键 | 最宽松：后写覆盖其他列 |
| `pk-changed`（默认） | 主键 + **本次要写的列**的原值 | 只保护你真正改动的那些格 |

一条语句影响的行数必须是 **1**：`0` 表示这一行已被他人改动或已不存在（返回 `conflict`，提示刷新重试）；
`> 1` 表示该条件不足以唯一定位单行，直接回滚。

一批改动**在同一个事务里**执行：任意一条失败，整批回滚，前面成功的写入不会留下。

### SQL 控制台

`Ctrl+Enter` 执行。**读立即执行；写返回预览**，只有确认时发回的原文与预览逐字相同时才真正执行——
改了输入框再点确认，发的仍是预览里那一条，不会把新编辑偷运过去。`LOAD DATA` / `INTO OUTFILE`
即使确认也不允许。结果集可以导出成 INSERT 语句。

### 新建库 / 新建表

表单是主路径：列类型只允许「类型名 + 精度 / UNSIGNED / CHARSET / COLLATE」，`ENUM(...)` 之类带引号的
声明走高级 SQL 页。两条路径都在执行前预览原文。

## 模型工具

除了给人用的侧边栏，插件还向模型注册三个**只读**工具。它们走的是同一个连接 store、同一批连接池、
同一道只读闸门——所以你在界面里配好的连接，就是 agent 查的那个连接。

| 工具 | 参数 | 作用 |
| :-- | :-- | :-- |
| `mysql_connections` | 无 | 列出已配置的连接（id、名称、地址、用户）。**永不返回任何密钥。** |
| `mysql_schema` | `connection`、`database?`、`table?` | 逐层看结构：不给 `database` 列库；给了列表/视图；再给 `table` 列字段（类型、可空、键、默认值、注释）。 |
| `mysql_query` | `connection`、`sql`、`database?`、`limit?` | 跑**一条**只读语句。默认 50 行、上限 500 行。超出上限报 `truncated`，请收窄 SQL 或在库内聚合。 |

`connection` 既接受 id 也接受连接名（大小写不敏感）；名字重复时会要求改用 id，并把候选 id 列出来。
找不到连接时，报错本身就带上所有可用的 id 和名字，好让 agent 的下一次调用能直接成功。

**没有游标。** 一次调用就是一次查询；要更多行就把 `limit` 调高（仍封顶 500），或者改 SQL。
没有 `ORDER BY` 的语句自己用 `LIMIT`/`OFFSET` 重跑会静默重复或漏行，所以这个工具不假装能翻页。

**为什么只有三个**：每个对模型可见的工具都在每次请求里占 prompt token，所以「浏览结构」做成了一个
渐进式工具，而不是三个平级工具。

工具是**可选依赖**：`tools` 服务经 `ctx.inject` 取得，而不是写在插件的 `inject` 列表里。于是一个没装
工具注册表的 profile 仍然能正常加载这个插件（侧边栏照常工作），只是没有工具。代价是「工具没上线」
这件事是静默的，所以 `health` 接口会回报注册结果：

```powershell
# registryMounted 为 false 说明这个 profile 里没有工具注册表；names 为空说明进程是旧代码
(curl -s -X POST http://127.0.0.1:3080/mysql-studio/api/health | ConvertFrom-Json).result.modelTools
```

## 安全边界

- **模型工具是只读的，且没有写入口**。注册给模型的三个工具里没有任何一个能改数据：`mysql_query` 与
  `query.run` 共用同一道词法级只读闸门，而结构化写入（`data.mutate`）和带确认的 SQL 写
  （`query.exec` / `schema.create*`）**根本没有暴露给模型**。这条边界是针对 prompt 注入的：
  会话里读到的文本不该能变成一条 UPDATE。
- **闸门看的是「真正会执行的语句」，不是开头那个词**。两种把写藏在读的动词后面的写法被显式处理：
  `WITH … DELETE / UPDATE / INSERT`（合法的 MySQL 8，以 `WITH` 开头）与 `EXPLAIN ANALYZE`
  （与普通 `EXPLAIN` 不同，**会真正执行**被分析的语句）。CTE 列表按 `name [(列)] AS ( body )` 解析，
  识别不了就 fail closed；解析与守卫都有对照测试，既有「必须被拒」也有「必须放行」——
  后者包括 `WITH RECURSIVE t(n) AS … SELECT`，它的列清单里也有括号，朴素扫描会误判成写语句，
  而 fail closed 的闸门一旦误拒，代价是正常查询不能用。
- **模型看不到密钥**。`mysql_connections` 用的是一份显式字段白名单（不是 `publicProfile` 的顺带产物），
  测试逐字断言了返回的键集合，所以以后给 profile 加字段也不会连带泄给模型。
- **接口有信任围栏**。`/mysql-studio/api` 只服务 Host 头为回环、或属于 web runtime `trustedHosts`
  的请求，其余一律 403，否则任意同源页面都能借你的进程读你的库。
- **密码不回传页面**。读接口一律返回 `hasPassword`，永不返回密码字段；页面留空表示「沿用已存密码」。
  也可以给 profile 填 `passwordEnv`，让密码只从环境变量取。
- **网格写入是参数化的**。所有值都作为绑定参数下发，从不拼进 SQL；库名/表名必须是纯标识符
  （字母数字下划线），列名先用反引号转义、再与 `information_schema` 的真实列清单核对。
- **网格写入是白名单制的**。`data.mutate` 只接受 `update` / `insert` / `delete` 三种结构化改动，
  不接受的列（二进制列、生成列、不存在的列）一律拒绝。
- **无主键即只读**。没有主键的表无法安全定位唯一一行，因此拒绝编辑与删除并说明原因。
- **数值无损**。启用 `supportBigNumbers`，超出 JS 安全整数的 BIGINT/DECIMAL 以字符串返回；
  `dateStrings` 让日期以服务端原文本到达，避免时区漂移；二进制列以 base64 传输、按声明类型渲染成
  `<BINARY n bytes>`。

## 架构

```
lib/index.js   Host 半：/mysql-studio/api 路由、信任围栏、方法分派
lib/store.js   连接 profile：校验、归一化、URL 解析、TLS 映射、JSON 文档读写
lib/db.js      mysql2 解析、连接池注册表、目录内省、分页读取、只读闸门、SQL 控制台、建库建表、改动构造函数
lib/tools.js   Agent 半：三个只读模型工具，复用同一套 store / 池 / 闸门
lib/client.js  Client 半：手写浏览器 bundle（DSH __ModuleLoader__ 格式），全部 UI
```

## License

MIT
