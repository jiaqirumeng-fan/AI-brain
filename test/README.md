# 开发期自动化检查

这些脚本不是运行应用的必需品，只用于回归测试。  
九个脚本覆盖：MCP 协议、知识库、turn/end 钩子（纯函数 + 完整捕获路径）、`/api/add`、手机感官、局域网权限、脑图交互、添加/编辑/删除闭环。

## 1. MCP / 记忆服务

```powershell
node test/mcp-test.js
```

它会用临时数据（`test/mcp_brain.json`）在 `8131` 端口拉起 `dsh/mcp-hippocampus.js`，依次验证：

- `initialize` / `tools/list` / `tools/call`
- `memory_stats`、`memory_add`（含自动联想）、`memory_recall`（含强化）、`memory_link`
- HTTP `/api/health`、`/api/state`
- stdout 只有 JSON-RPC（没有多余日志）

脚本结束会关闭子进程；临时数据文件可以随时删除。

## 2. 知识库

```powershell
node test/kb-test.js
```

在 `test/tmp-kb` 下构造临时知识库，验证：

- md front matter（domain/tags/importance）与目录名 → 领域映射；
- docx 解析（用 DSH 自带 Python 现场生成）；
- 标题/段落切块，每块写成节点并带 `source`；
- 新增 / 修改 / 删除文件 → 节点增删；
- 上传接口与索引去重（`data/kb-index.json`）。

脚本结束会自动删除临时目录。

## 3. turn/end 钩子 / `/api/add`

```powershell
node test/hook-test.mjs
node test/hook-capture-test.mjs
node test/api-add-test.js
```

- `hook-test.mjs`：纯函数测试抽取规则（明确“记住”、学习问答、决策、寒暄跳过、领域/标签）。
- `hook-capture-test.mjs`：用假 session + 本地假 HTTP 服务，验证 turn/end 解析、user/assistant 提取、模型已保存/subagent/跨工作区/中断跳过，以及 `/api/add` 请求体。
- `api-add-test.js`：在 `8132` 拉起临时 MCP server（独立 `data` / `knowledge` / `kb-index`），验证 `/api/add` 写入、自动联想、重复检测，结束后清理。

真实钩子是否加载，看 `data/hook.log` 里的 `hook loaded` 和每轮 `captured / skip`。

## 4. 手机感官 / 局域网权限

```powershell
node test/phone-test.js
node test/phone-lan-test.js
```

- `phone-test.js`：在 `8134` 拉起临时 MCP server（独立 data / knowledge / kb-index / senses），验证 `/m` 页面、配对信息、文字/照片/录音上传、`/api/sense/recent`、`/api/sense/file` 与 Range、二维码。
- `phone-lan-test.js`：用本机局域网 IP 访问临时服务，验证 `/m` 可打开、`/api/state` 返回 403、`/api/sense/ping` 无 token 返回 401、带 token 返回 200、`/api/mobile-info` 从局域网返回 403。没有局域网 IPv4 时自动跳过。

HTTP 下手机页会自动走“选择录音文件”的降级路径；HTTPS/localhost 才直接开麦。

## 5. 脑图交互（CDP）

1. 启动独立静态服务（项目根目录）：

   ```powershell
   node server.js
   # 或 python -m http.server 8123 --bind 127.0.0.1
   ```

2. 用带调试端口的 Edge 打开页面。**加 `?local=1`**，避免测试写进 DSH 的真实记忆库：

   ```powershell
   & "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
     --headless=new --disable-gpu --no-first-run `
     --remote-debugging-port=9333 `
     --user-data-dir="$env:TEMP\edge-hippocampus-test" `
     --window-size=1600,1000 `
     "http://127.0.0.1:8123/index.html?local=1"
   ```

3. 运行：

   ```powershell
   $env:CDP_PORT="9333"
   node test/cdp-test.js      # 添加、回想、共激活、关联扫描、画布点击、详情、时间旅行、搜索、持久化
   node test/cdp-addflow.js   # 走 UI：添加 → 自动联想 → 建立 → 编辑 → 删除
   ```

脚本会打印每一步的结果，并在 `errors` 字段汇总控制台异常。  
两个脚本都使用独立的 `--user-data-dir`，不会影响你日常浏览器的本地数据。

> 如果 Edge 首次启动弹出“同步浏览数据”对话框，`cdp-*` 脚本会按 URL 过滤页面，只操作 `127.0.0.1` 的那个标签页。
