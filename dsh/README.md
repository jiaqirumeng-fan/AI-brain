# 海马体 × DeepSeek Harness

把「海马体」接进 DSH：AI 在对话里**记东西、找东西、连东西**，脑图实时跟着亮。

当前状态：**已接入本机 desktop profile**，DSH 已自动加载 `memory_*` 工具；脑图由 MCP server 同时托管在 <http://127.0.0.1:8130/>。  
`turn/end` 兜底钩子也已安装，`data/hook.log` 里有 `hook loaded`；手机感官 `/m` + 局域网 token 已接上。

---

## 它是怎么连起来的

```
┌──────────────────────────── DSH ────────────────────────────┐
│  Agent（对话 / 工具调用）                                     │
│      │  stdio MCP                                            │
│      ▼                                                       │
│  dsh/mcp-hippocampus.js                                      │
│      ├─ memory_recall / add / link / stats / due / get       │
│      ├─ knowledge/ 监听 → 切块 → memory（memory_import）     │
│      ├─ 手机 /m + /api/sense → 拍照/录音/文字节点             │
│      ├─ turn/end 钩子（dsh/plugin）→ POST /api/add           │
│      ├─ 共享记忆服务（MemoryService）                         │
│      └─ 本地 HTTP API + SSE（127.0.0.1:8130）                 │
│                    │                                         │
│                    ├─ data/brain.json（唯一数据源）           │
│                    └─ 浏览器脑图（同一份状态，实时刷新）       │
└──────────────────────────────────────────────────────────────┘
```

- **一个进程、一份数据**：DSH 启动 MCP server 时，同时把脑图站点和 API 起在 8130；不会再出现两个进程各写一份状态。
- **AI 写入 → 脑图亮起**：`memory_add` / `memory_link` / `memory_recall` 提交后会通过 SSE 广播，浏览器无需刷新。
- **脑图操作 → AI 可见**：脑图里的添加、回想、连线会写回同一个 `data/brain.json`；AI 下次 `memory_recall` 就能看到。

---

## 安装

在项目根目录：

```powershell
node dsh/install.mjs desktop
# 或同时装到 desktop / web（存在哪个改哪个）
node dsh/install.mjs
# 卸载
node dsh/install.mjs --remove
```

脚本会：

1. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加一条 `@deepseek-ai/dsh-mcp-client`；
2. 备份原文件（`cordis.patch.yml.bak-hippocampus-*`）；
3. 不改 `package.json`、不装依赖（MCP client 是 DSH 内置插件）。

DSH 会监听 profile 补丁并热加载；如果工具没出现，**完全退出 DeepSeek Harness（托盘退出）再启动**即可。

兜底钩子单独安装：

```powershell
node dsh/install-hook.mjs desktop
# 卸载
node dsh/install-hook.mjs --remove
```

它把 `dsh/plugin` 链接进 profile 的 `node_modules`，再追加一条 `hippocampus-hook`；详情见下面「turn/end 兜底钩子」。

---

## 工具

| 工具 | 用途 |
| --- | --- |
| `memory_recall` | 按主题召回记忆；返回可提取度、标签、邻居；默认把命中的前几条记为一次真实调用（脑图变亮） |
| `memory_add` | 写入一条记忆；自动返回潜在关联；`auto_link: true` 可自动连最强的 1–2 条 |
| `memory_link` | 在两个记忆间建立突触；跨领域自动标成 bridge |
| `memory_stats` | 整张网的状态：节点、突触、跨域桥、平均可提取度、领域连通度、最该复习 |
| `memory_due` | 按“重要度 × 遗忘程度”列出该复习的记忆 |
| `memory_get` | 按 id 看完整内容与所有突触 |
| `memory_import` | 扫描 `knowledge/`，把新增/修改的资料切块入库 |
| `memory_import_file` | 导入一个本地文件（md/txt/docx/pdf/pptx/xlsx/图片） |
| `memory_kb_status` | 知识库文件数、生成节点数、最近扫描与错误 |
| `memory_sense_recent` | 最近从手机送来的照片/录音/文字；照片 `source.file` 可交给 `read_image` |

工具说明里已经写了使用时机，系统提示也会带上“海马体记忆协议”。可以直接这样用：

- “记住：今天我们把海马体接入了 DSH，用 MCP 暴露记忆工具，SSE 实时刷新脑图。”
- “我之前学过傅里叶变换吗？帮我回忆一下，再解释带通滤波。”
- “我的大脑现在什么状态？哪些快忘了？”
- “把‘傅里叶降噪’和‘课堂实时字幕’连起来，因为都在处理信号降噪。”

---

## 自动召回 / 自动抽取

两条指令来源：

1. MCP server 的 `initialize.instructions`（每次连接注入）；
2. 工作区根目录的 [AGENTS.md](../AGENTS.md)（DSH 的 agent-instructions 插件自动加载）。

协议是：

- **每轮回答前**：`memory_recall(query=用户这句话的主题)`。命中就自然使用，没命中就正常回答。
- **结束前自检**：本轮若产生新的、可复用的知识点/结论/项目决策，`memory_add` 保存 0–1 条；用户说“记住/记一下”时必须保存；寒暄、临时进度不保存。
- **发现关系**：`memory_link`，跨领域优先。

第一层是协议驱动：DSH 的 agent loop 会执行它，因此新会话也生效，但它依赖模型遵守。  
第二层是下面的硬钩子，专门兜住模型漏掉的情况。

### 第二层：turn/end 兜底钩子

[dsh/plugin](plugin) 是一个 DSH 宿主插件，监听 `session/event` 里的 `turn/end`。  
模型忘了调用 `memory_add` 时，它按规则兜底：

| 情况 | 行为 |
| --- | --- |
| 用户明确说“记住 / 记一下 / 保存” | 一定捕获（取指令后的内容） |
| 学习型问答，且 assistant 回答 ≥ 240 字 | 捕获一条“问题 + 回答摘要” |
| 用户消息含“决定 / 方案 / 结论 / 采用 / 实现 / 修复…” | 捕获一条决策 |
| 模型本轮已经调用过 `memory_add` | 跳过，不重复 |
| subagent / 其他工作区 / 异常中断的 turn | 跳过 |
| 寒暄、“继续”、工具操作、过短回答 | 跳过 |

- 只处理 `D:\软件创新大赛` 工作区（`session.header.cwd` 精确匹配）；
- 只处理 `reason.kind = completed / max-tokens`；
- 每轮最多一条，`POST http://127.0.0.1:8130/api/add`；
- 节点 `source.kind = conversation`，详情面板显示「来源：对话 · 自动捕获」；
- 不做 LLM 二次调用，所以是启发式兜底，不替代模型自己的语义判断。

安装 / 移除：

```powershell
node dsh/install-hook.mjs desktop
node dsh/install-hook.mjs --remove
```

它会把 `dsh/plugin` 链接进 profile 的 `node_modules`，并在 `cordis.patch.yml` 追加一条 `hippocampus-hook`。  
DSH 会热加载 profile 补丁；验证看：

```powershell
Get-Content data/hook.log -Tail 20
# 应出现 hook loaded；之后命中规则会有 captured，模型已保存会有 skip
```

如果一直没有 `hook loaded`，完全退出 DSH 再启动。  
钩子只写本地 `data/hook.log` 和记忆库，不联网。

---

## 知识库

```
knowledge/
├─ 高等数学/极限的严格定义.md
├─ 项目/答辩四段式.md
└─ 收件箱/                 ← 脑图上传的文件
```

- 子文件夹名自动映射领域；文件开头可写 `domain` / `tags` / `importance` front matter；
- 支持 `.md .txt .json .docx .pdf .pptx .xlsx` 与图片；
- 按标题/段落切块（约 1400 字/块，单文件最多 40 块），每块写成一个记忆节点，并自动连 1–2 条最强联想；
- 文件修改自动重新入库，删除文件移除对应节点；
- 图片暂不做 OCR，作为视觉资料收录。

解析依赖：

| 类型 | 依赖 |
| --- | --- |
| md/txt/json | 内置 |
| docx/pptx/xlsx | DSH 自带 Python（python-docx / python-pptx / openpyxl） |
| pdf | `dsh/vendor/python` 里的 `pypdf` |
| 图片 | 只记录文件与元数据，不做 OCR |

从脑图上传：顶栏「知识库」→ 拖拽文件 → 选择领域（或自动识别）→ 立即入库。

---

## 手机感官

手机页由 MCP server 直接托管：

```
http://<电脑局域网IP>:8130/m?token=<配对码>
```

- 配对码：`data/mobile-token.txt`（首次启动生成）；
- 二维码：脑图顶栏手机图标 → `/api/mobile-qr`（由 `make_qr.py` + vendor `qrcode` 生成 SVG）；
- 照片：`POST /api/sense/photo`，客户端压缩后 raw image；
- 音频：`POST /api/sense/audio`，raw audio + duration；
- 文字：`POST /api/sense/note`，JSON；
- 最近：`GET /api/sense/recent`；
- 文件：`GET /api/sense/file/<name>`，支持 Range，音频可拖动进度；
- 配对信息：`GET /api/mobile-info`（仅本机）。

写入的节点：

| `source.kind` | 来源 | UI |
| --- | --- | --- |
| `phone-photo` | 手机相机 | 详情显示照片 |
| `phone-audio` | 手机录音 / 文件 | 详情可播放 |
| `phone-note` | 手机文字 | 详情显示来源 |

照片的 `source.file` 是电脑上的绝对路径；DSH 用 `memory_sense_recent` 找到后，可以 `read_image` 读取。  
音频暂不做 ASR，先看备注/时长。

### 安全模型

- HTTP 监听 `0.0.0.0`，但**非本机只允许** `/m`、`/m/*`、`/api/sense/*`；
- `/api/state`、`/api/add`、知识库、脑图静态页在非本机请求下 403；
- `/api/sense/*` 需要 `X-Hippocampus-Token` 或 `?token=`；
- `/api/mobile-info`、`/api/mobile-qr` 仅本机；
- 局域网是明文 HTTP，敏感资料不要走不可信 Wi-Fi；直接开麦需要 HTTPS，HTTP 下走系统录音机/文件上传。

### 手机打不开

1. 同一 Wi-Fi，路由器未开 AP 隔离；
2. Windows 防火墙允许 8130（管理员）：

   ```powershell
   New-NetFirewallRule -DisplayName "Hippocampus Phone 8130" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8130 -Profile Private,Domain
   ```

3. 换手机热点通常最稳。

---

## 端口与数据

| 项 | 值 |
| --- | --- |
| 脑图 / API | `http://127.0.0.1:8130/` |
| MCP 传输 | stdio（由 DSH 拉起） |
| 数据文件 | `data/brain.json` |
| 知识库目录 | `knowledge/`（可用 `HIPPOCAMPUS_KB_DIR` 覆盖） |
| 知识库索引 | `data/kb-index.json`（可用 `HIPPOCAMPUS_KB_INDEX` 覆盖） |
| 钩子日志 | `data/hook.log` |
| 手机页 | `/m`（需配对 token） |
| 手机配对码 | `data/mobile-token.txt`（可用 `HIPPOCAMPUS_TOKEN_FILE` 覆盖） |
| 手机媒体 | `data/senses/`（可用 `HIPPOCAMPUS_SENSE_DIR` 覆盖） |
| 绑定地址 | `HIPPOCAMPUS_HOST`，默认 `0.0.0.0`；设为 `127.0.0.1` 可关闭手机访问 |
| 端口覆盖 | `HIPPOCAMPUS_HTTP_PORT` |
| 数据覆盖 | `HIPPOCAMPUS_DATA` |
| 数据目录覆盖 | `HIPPOCAMPUS_DATA_DIR` |
| Python 覆盖 | `HIPPOCAMPUS_PYTHON` |
| 仅 HTTP（调试 / 无 DSH） | `node dsh/mcp-hippocampus.js --http-only` |

浏览器从 `8123`（`启动海马体.cmd`）或 `file://` 打开时，也会自动尝试连接 `8130`；连上后页脚显示「DSH 已连接」，否则退回本地 localStorage 模式。

> **只跑一个服务**：DSH 启动后已经占用 8130 时，不要再手动跑 `--http-only`。两个进程会各持一份内存状态，容易互相覆盖。

---

## 调试

```powershell
# 1) 看 DSH 是否拉起了 MCP
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'mcp-hippocampus' }

# 2) 看 HTTP / 状态
Invoke-WebRequest http://127.0.0.1:8130/api/health | Select-Object -Expand Content

# 3) 独立跑一个 MCP 会话（不经过 DSH）
node test/mcp-test.js

# 4) 知识库：状态 / 回归
Invoke-WebRequest http://127.0.0.1:8130/api/kb/status | Select-Object -Expand Content
node test/kb-test.js

# 5) 钩子：日志 / 纯函数回归 / 完整捕获路径 / /api/add 回归
Get-Content data/hook.log -Tail 20
node test/hook-test.mjs
node test/hook-capture-test.mjs
node test/api-add-test.js

# 6) 手机感官：页面 / 上传 / token / 局域网权限
node test/phone-test.js
node test/phone-lan-test.js
```

MCP server 的所有日志都写 stderr；stdout 只允许 JSON-RPC，否则 DSH 会解析失败。

---

## 演示时怎么讲（30 秒）

1. 先打开 <http://127.0.0.1:8130/>，指一下亮/暗节点：“越久没调用越淡，但不会消失。”
2. 切到 DSH 对话，说：**“记住：用傅里叶变换给心电信号降噪，标签是傅里叶、降噪、信号。”**
3. 指脑图：新节点在「项目·竞赛」脑区亮起，并自动和「傅里叶变换」连出一条跨域桥。
4. 点顶栏「知识库」，把一份 pptx/pdf 拖进去：“它会被切块、入库，自动连到已有概念，不需要一条条录入。”
5. 点顶栏手机图标，手机扫码拍一张白板/笔记：“手机只是眼睛和耳朵，记忆长在电脑里；拍完就出现在同一张图上。”
6. 再问：**“我的大脑现在什么状态？哪些快忘了？”** DSH 调 `memory_stats / memory_due`，脑图侧同时更新。
7. 收尾：“AI 记住的东西，第一次不是一段看不见的向量，而是一张会褪色、会长突触的图。”

---

## 安全边界

- HTTP 监听 `0.0.0.0`（为了手机访问），但**非本机只开放** `/m`、`/m/*`、`/api/sense/*`；`/api/state`、`/api/add`、知识库、脑图静态页在非本机请求下 403。
- 手机上传需要配对 token（`X-Hippocampus-Token` 或 `?token=`）；`/api/mobile-info`、`/api/mobile-qr` 仅本机。
- 本机进程（127.0.0.1）无鉴权：能在这台机器上发请求的进程都能读写记忆。对比赛演示足够；多设备场景需要更细的 token / Tailscale。
- 知识库上传的文件会落到 `knowledge/收件箱/`；手机媒体落到 `data/senses/`；不要放入密码、令牌、身份证号等敏感资料。
- turn/end 钩子只读本工作区的会话事件，把摘要写进本地 `data/brain.json` 和 `data/hook.log`，不联网。
- 局域网是明文 HTTP；敏感照片/录音不要走不可信 Wi-Fi。直接开麦需要 HTTPS，HTTP 下用系统录音机/文件上传。
- 数据是明文 JSON；token 在 `data/mobile-token.txt`，删除并重启即可换新码。
