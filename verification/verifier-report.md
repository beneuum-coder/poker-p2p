# poker-p2p 独立验收报告

- **验收方**：独立验收方（acceptance-verifier），只做验证，不修改交付实现。
- **共享任务**：`task-1`（先 claim，完成后 complete）。
- **工作目录**：`D:\文档\deepseek-harness\default-workspace\poker-p2p`
- **验收时间**：2026-11-12 18:35–18:55（Asia/Shanghai）
- **验证基线**：
  - Git HEAD：`aa4064e35a2e8797e845c5b81255d75fb1073c26`（commit 时间 2026-11-12 18:36:25 +08:00）
  - 工作区含 Lead 在本轮验收期间对 3 个 src 文件的未提交调整（`HostSession` 的 `unavailable-id` 重试、房主 `idle` 状态按钮、窄屏座位尺寸），涉及 `src/main.js`、`src/net/peer.js`、`src/styles.css`。按 Lead 要求，在最新工作区上**重新执行了 `npm test` 与 `npm run test:e2e`**，E2E 会重建 `docs/`（允许操作）。
  - 关键文件哈希（`git hash-object`）：`src/main.js d999021a…`、`src/net/peer.js f86d9ba6…`、`src/styles.css cb1c4189…`、`docs/app.js d8d4d651…`、`docs/styles.css cb1c4189…`；`npm run build` 前后 `docs/app.js`/`docs/styles.css` 哈希一致，构建可复现。
- **环境**：Node `v20.18.0`、npm `10.8.2`、Chromium `C:\Users\vanta\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe`（由 `test/helpers/browser.mjs` 自动定位）。

## 结论

**通过（PASS）**。用户验收清单 5 项全部 PASS，2–6 人容量、盲注 10/20、初始 1000、边池/筹码守恒、下一手庄家移动、GitHub Pages 相对路径与 `.nojekyll` 均通过独立验证；未发现阻断验收的缺陷。

发现的均为非阻断性问题/风险：P2 断线玩家无踢人入口、P3 开牌前座位变更日志会被清空、P3 同一浏览器普通多标签共享 session token、P3 README 中 E2E 耗时快照轻微漂移，详见第 4 节。

---

## 1. 必做命令与结果

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npm test` | 0 | 9/9 通过，0 failed，duration 约 318ms |
| `npm run test:e2e`（Lead 改动后重跑） | 0 | 2/2 场景通过；场景 1 `18441ms`，场景 2 `6196ms`；`acceptance-report.json` 中 `ok: true` |
| `npm run build` | 0 | `docs/app.js` 445510 bytes（435 KB）；与 E2E 重建结果哈希一致 |
| `npm ci --dry-run` | 0 | lockfile 可解析，CI `npm ci` 前置检查通过 |
| `npm run serve` | 0 | `http://127.0.0.1:8080/` 返回 HTTP 200，页面含“联机德州” |

E2E 原始证据：

- `test/.artifacts/acceptance-report.json`（也复制为 [e2e-acceptance-report.json](artifacts/e2e-acceptance-report.json)）
- 截图：[e2e-01-hand2-host.png](artifacts/e2e-01-hand2-host.png)、[e2e-01-hand2-guest.png](artifacts/e2e-01-hand2-guest.png)、[e2e-02-sidepot-host.png](artifacts/e2e-02-sidepot-host.png)、[e2e-02-sidepot-loser.png](artifacts/e2e-02-sidepot-loser.png)

> 说明：本轮先跑过一次 E2E 也通过；Lead 中途做了 3 处健壮性/移动端调整后，已在最新工作区重跑，上表为**重跑结果**。`docs/app.js` 的重新构建结果与当前 `src/` 一致。

---

## 2. 用户验收清单逐项结论

### 2.1 联机建立：PASS ✅

**要求**：房主创建房间后，另一设备/浏览器输入房间码，数秒内互相看到对方加入。

**证据**：

1. **E2E 场景 1**：房主 + 独立 BrowserContext 玩家，双方 `.room-meta` 均显示 `2/6 人在座`，且互相能看到昵称（`test/e2e/run-e2e.mjs:113-123`）。
2. **独立 wire 测试**（`verification/wire-privacy.mjs`）：2 个真实 BrowserContext + 真实 PeerJS/WebRTC，welcome 消息带玩家 id，双方 UI 显示 `2/6 人在座`；共捕获 15 条 DataConnection 消息（3×welcome + 12×state）。
3. **独立加入延迟测试**（`verification/join-latency.mjs`，3 次真实建房/加入）：

| 轮次 | 玩家进入房间 | 房主看到 2 人 |
|---|---:|---:|
| 1 | 2647ms | 2654ms |
| 2 | 2533ms | 2538ms |
| 3 | 2509ms | 2517ms |

最大 2654ms，满足“数秒内”。

**结论**：PASS。房间码 6 位且来自 `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`（2000 次抽样全部合法），邀请链接 `?r=CODE` 可预填。

### 2.2 完整一手牌：PASS ✅

**要求**：盲注正确扣除；房主操作后对方公共牌和底池同步更新；打到摊牌自动判胜负并分池。

**证据**：

1. **盲注/初始筹码**（`verification/privacy-and-rules-audit.mjs`，2–6 人逐个人数验证）：每家初始 `1000`；开手后底池 `30`，实际下注额 `[10, 20]`；`chips + pot = n × 1000`。单挑时按钮位兼任小盲（`role=btn, bet=10`），这是正常规则，不视为缺陷。
2. **真实 6 人桌**（`verification/net-capacity-limits.mjs`）：6 家入座、盲注 10/20、开手后底池 `30`，房主看到 5 名对手共 10 张牌背，最后加入的玩家也看到 10 张牌背。
3. **房主操作 → 对方同步**：E2E 场景 1 中，房主/玩家跟注、过牌后双方 `.stage-label` 从“翻牌前”同步到“翻牌”；底池同步为 `40`；刷新后仍一致。
4. **摊牌/分池**：E2E 场景 1 打到摊牌后 `.award` 总和等于底池（40），双方筹码总和 2000；`verification` 独立验证 `awards` 总和 == `result.potTotal`，公共牌 5 张。
5. **下一手**：E2E 场景 1 验证“开始下一手”后公共牌清空、底池重置为 30、庄家移动；独立脚本在 2/3/6 人桌各验证庄家移动与筹码守恒；3 人桌连续 5 手庄家序列 `[3,1,2,3,1]`。
6. **平分底池**（独立）：公共牌皇家同花顺，二人各 `+20`，最终各 1000。
7. **全下跑马**（独立）：单挑翻前双方全下，自动发完 5 张公共牌并摊牌，底池 2000 全部派出，筹码守恒；E2E 场景 2 另覆盖三人不等额全下。

**结论**：PASS。

### 2.3 底牌保密：PASS ✅（重点反证）

**要求**：摊牌前双方互不可见对方底牌，摊牌后才公开。

**证据 A：`PokerTable.getState(viewerId)` 投影递归扫描**（`verification/privacy-and-rules-audit.mjs`）

- 用固定发牌让 1/2/3 号分别拿到 `sq hq`、`sa ha`、`sk hk`，从 preflop/flop/turn/river 逐街扫描每个观战者的完整 state JSON（不仅 `players[].cards`，而是递归查找所有字符串字段）：
  - 他人底牌**出现次数为 0**；
  - 自己 `you.cards` 恰好 2 张且等于引擎底牌；
  - `players[].cards` 在摊牌前全部为 `undefined`。
- 翻牌圈玩家 2 弃牌后打到摊牌：
  - 只公开未弃牌的 1、3 号底牌（`revealed: [1,3]`）；
  - 弃牌玩家 2 的底牌 `sa ha` 在 1、3 号 state 中都不出现；
  - `players[2].cards` 保持 `undefined`；
  - `result.bestPokes` 只含赢家 3 的 `sk hk` + 公共牌，不含弃牌者底牌。
- **弃牌结束（fold_win）专项**：`result.bestPokes` 为 `[]`、`bestRankCategory` 为 `null`，不会通过结果字段泄漏赢家底牌。

**证据 B：真实 PeerJS DataConnection 消息拦截**（`verification/wire-privacy.mjs`）

在房主页面临时包装 `HostSession.prototype._send`（仅测试页内存，不修改交付代码），记录真实发给每个玩家的 payload：

- 摊牌前发给玩家（`pid=2`）的 playing state 中：
  - `players[].cards` 对所有非本人玩家均为缺失/undefined；
  - `you.cards` 仅为自己的 2 张；
  - 对**其他玩家底牌牌码的全字段递归查找 = 0**。
- 房主自己底牌 `dq dk`、玩家底牌 `sa ha`；玩家收到的 state 不含 `dq/dk`。
- 刷新重连后的新 state 仍不含他人底牌（`leaks: 0`）。
- 摊牌后：双方 state 公开未弃牌玩家底牌；各玩家 UI 中对手 2 张明牌与引擎底牌完全一致。
- 3 人真实联机、1 人弃牌后摊牌（`verification/fold-privacy-ui.mjs`）：房主和其他玩家 UI 都看不到弃牌玩家的 `c3 ha`，弃牌玩家自己的页面仍可看自己的底牌（合理）。

**证据 C：UI / 浏览器存储 / 全局对象**

- 房主、玩家页面 `.seat-cards .card` 的可见牌面只包含自己的底牌（+ 公共牌）；**整页 textContent 扫描**也不含对手底牌牌面。
- 玩家 `localStorage` 只有 `txp:name` 和 `txp:session:<code>`，不含底牌或牌局状态。
- 玩家页面 `window.__txpTable` / `window.__txpHost` 均为 `undefined`；这两个调试对象只存在于房主页（房主可信边界，README 已声明）。
- 关键代码：`src/game/table.js:575-657`（`getState`），`src/game/table.js:602`（`players[].cards` 仅在 reveal 时填写），`src/game/table.js:647`（`you.cards` 仅自己），`src/net/peer.js:251-257`（按连接分别 `getState(playerId)`）。

**结论**：PASS。

### 2.4 断线恢复：PASS ✅

**要求**：刷新或短暂断网重连后，座位和筹码不丢失，能继续当前手牌。

**证据**：

1. **E2E 场景 1**（真实浏览器 + 真实 PeerJS）：
   - 翻牌圈记录底池 40、自身筹码 980、底牌 2 张；
   - `guest.reload()` 后仍显示“翻牌”、底池 40、筹码 980、底牌相同；
   - `context.setOffline(true)` 3.5 秒再恢复，等待 `#net-pill` 显示“已连接”，仍在“翻牌”，筹码不变；随后继续打到摊牌。
2. **独立 wire 测试**：
   - 翻牌圈刷新：刷新前/后 `stage=翻牌, pot=40, chips=980, hole=A♠ A♥` 完全一致；
   - 2 秒断网再恢复：仍为翻牌，筹码 980，状态条恢复“已连接”；
   - 刷新后重连收到的 state 仍不泄漏他人底牌。
3. **token 机制**：玩家 token 存 `localStorage["txp:session:<房间码>"]`，刷新后 `hello(token)` 命中同一 meta 记录，不新建玩家（`src/game/table.js:254-261`、`src/net/peer.js:199-233`；`src/main.js:55-72,638`）。

**注意（已知边界，非验收失败）**：刷新**房主**页面会丢失整个房间。独立测试确认：房主刷新后回到 landing，`window.__txpTable` 消失；玩家页面保留旧状态但显示“重连中/连接中”，20 秒内未自动恢复。这与 README 第 194 行声明一致。

**结论**：PASS。玩家刷新/短时断网恢复符合要求；房主刷新丢房间属于已声明限制。

### 2.5 边池：PASS ✅

**要求**：多人不等额全下时，边池分配正确。

**证据**：

1. **E2E 场景 2**（真实 3 人联机）：短码 100（AAA）赢主池 300、300 的 KK 赢边池 400、QQ 0；最终筹码 300/400/0，总和 700；UI 显示“主池 300 · 边池 1 400”。
2. **独立 3 人复算**（`verification/privacy-and-rules-audit.mjs`）：投入 100/300/300，awards `{1:300, 2:400}`，`sidePots` 金额 `[300,400]`，eligible 分别 `[1,2,3]`、`[2,3]`，筹码守恒 700。
3. **独立 4 人不等额**：投入 50/100/200/300，awards `{2:200, 3:150, 4:200, 1:100}`；展示侧池 `[200,150,200,100]`，与独立 `computeSidePots` 复算一致；总和 650 守恒。
4. **弃牌玩家 eligibility**：三人桌 2 号弃牌后，sidePots 金额 `[60,80]`，两个池的 `eligible` 都排除 2 号；金额仍包含弃牌者的 dead money，符合规则。
5. **实现依据**：结算以引擎 `PotAwarded.allocations` 为准（`src/game/table.js:376-389`），`computeSidePots` 仅展示用（`src/game/table.js:112-138,612-614`）。

**结论**：PASS。

### 2.6 2–6 人、盲注、筹码、庄家、Pages：PASS ✅

| 检查项 | 结果 | 证据 |
|---|---|---|
| 2–6 人 | PASS | 独立脚本 2/3/4/5/6 人全部发牌、打到摊牌、筹码守恒；真实 6 人满房 |
| 第 7 人拒绝 | PASS | 真实浏览器第 7 人收到“房间已满”，未进入房间；房主仍 6 人；引擎单测亦拒绝 |
| 盲注 10/20 | PASS | 2–6 人开手底池均为 30；实际下注额 10/20；单挑按钮位兼任小盲 |
| 初始 1000 | PASS | 2–6 人入座均 1000；6 人真实桌 player-list 均显示 1,000 |
| 筹码守恒 | PASS | 每手 `players.chips` 总和 == 初始总额；摊牌/边池/多手/全下均验证 |
| 下一手庄家移动 | PASS | 2/3/6 人桌庄家均变化；连续 5 手序列正确；公共牌清空、底池 30 |
| Pages 静态产物 | PASS | `docs/index.html` 1236B、`app.js` 445510B、`styles.css` 22912B、`.nojekyll` 0B |
| 相对路径 | PASS | `index.html` 仅 `./styles.css`、`./app.js`；无绝对 `/` 引用 |
| 子路径部署 | PASS | 内存服务器模拟 `/poker-p2p/`，请求 `/poker-p2p/`、`/poker-p2p/styles.css`、`/poker-p2p/app.js` 全部 200，样式表加载，可创建房间 |
| GitHub Actions | PASS | `.github/workflows/pages.yml`：main、`npm ci`、`npm test`、`npm run build`、`path: docs`、`deploy-pages@v4`、`pages: write`、`id-token: write` |
| `.nojekyll` | PASS | `docs/.nojekyll` 为空文件；`scripts/build.mjs:28` 每次构建写入 |

---

## 3. 补充反证/独立验证汇总

所有脚本都在 `verification/`，只读 `src/`，不修改交付文件；数据产物在 `verification/artifacts/`。

| 脚本 | 检查项 | 结果 | 产物 |
|---|---:|---:|---|
| `verification/privacy-and-rules-audit.mjs` | 17 | **17/17 PASS** | `privacy-rules-audit.json` |
| `verification/wire-privacy.mjs` | 11 | **11/11 PASS** | `wire-privacy.json` + 3 张截图 |
| `verification/net-capacity-limits.mjs` | 5 | **5/5 PASS** | `net-capacity-limits.json` + 5 张截图 |
| `verification/pages-readme-audit.mjs` | 13 | **13/13 PASS** | `pages-readme-audit.json` |
| `verification/edge-cases.mjs` | 4 | **4/4 PASS** + 1 风险观察 | `edge-cases.json` |
| `verification/fold-privacy-ui.mjs` | 1 | **PASS** | `fold-privacy-ui.json` + 3 张截图 |
| `verification/join-latency.mjs` | 3 轮延迟 | **PASS**（max 2654ms） | `join-latency.json` |

关键截图：

- 摊牌前玩家视角（仅自己底牌、对手牌背）：[wire-01-preflop-guest.png](artifacts/wire-01-preflop-guest.png)
- 摊牌后玩家视角（对手明牌）：[wire-03-showdown-guest.png](artifacts/wire-03-showdown-guest.png)
- 真实 6 人满房：[capacity-01-six-players-host.png](artifacts/capacity-01-six-players-host.png)
- 第 7 人被拒：[capacity-03-seventh-rejected.png](artifacts/capacity-03-seventh-rejected.png)
- 房主刷新后 landing：[host-refresh-01-landing.png](artifacts/host-refresh-01-landing.png)
- 3 人弃牌摊牌（弃牌者无明牌）：[fold-01-showdown-host.png](artifacts/fold-01-showdown-host.png)
- E2E 截图：[e2e-01-hand2-host.png](artifacts/e2e-01-hand2-host.png)、[e2e-02-sidepot-host.png](artifacts/e2e-02-sidepot-host.png)

### 3.1 隐私反证的具体字段证据

真实 wire 捕获（摊牌前发往 guest 的 playing state）：

- `players[].cards`：除自己外全部缺失（`undefined`）；
- `you.cards`：仅本人 2 张；
- 递归扫描他人底牌牌码：0 命中；
- `welcome` / 刷新后 `state`：同样无他人底牌；
- 摊牌后：未弃牌玩家 `players[].cards` 各有 2 张，且与引擎 `getHoleCardsForPlayer` 完全一致；
- 弃牌者：即使摊牌后 `players[].cards` 仍为 `undefined`，UI 也隐藏其牌面。

### 3.2 真实联机/容量/断网反证

- 2 个 BrowserContext 加入、刷新、2 秒断网重连：通过（真实 PeerJS 公共信令 + WebRTC）。
- 6 个 BrowserContext（房主 + 5 玩家）满房：通过；第 7 人收到“房间已满”且不进入房间。
- 房主刷新：房主回 landing、`__txpTable` 消失；玩家显示重连中且无法恢复。
- 加入延迟：3 轮 2.5–2.7 秒。

---

## 4. 发现的 bug / 风险（按严重度）

### P0/P1：无

未发现阻断验收、数据错误、筹码错误或底牌泄漏的问题。

### P2（中）断线玩家永久占座，房主没有踢人入口

- **现象**：玩家关闭标签/断线后，房主只把 `connected` 标为 false，座位和筹码继续保留；房间成员数仍占 6 人名额。第 7 人仍被“房间已满”拒绝。UI 只有“结束房间”“补码”，没有移除/踢人。
- **证据**：`verification/edge-cases.mjs` 的风险观察；`verification/net-capacity-limits.mjs` 的 6 人满房 + 第 7 人被拒。代码上 `src/main.js` 无 kick/removePlayer 动作；`src/game/table.js:303-307` 仅更新 `connected`。
- **最小复现**：
  1. 开 6 个 BrowserContext 加入同一房间，达到 `6/6`；
  2. 关闭其中一个玩家标签（不通知房主）；
  3. 房主仍显示 `6/6`，该玩家标记“离线”；
  4. 第 7 个浏览器输入房间码 → 提示“房间已满”，且房主 UI 无踢人按钮。
- **影响**：6 人局有人临时离开/关页后，空位无法被新玩家使用，只能结束整间房重开。README 的“已知边界”未明确列出“无踢人/断线占座”。
- **建议**：增加房主“移除离线玩家”或超时自动释放座位；至少在 README 已知限制中写明。

### P3（低）开牌前座位变更日志会被清空

- **现象**：`_seatPending()` 的“入座”和 `_unseatBrokePlayers()` 的“筹码耗尽，暂时离座”写入 `this.log` 后，`startHand()` 在稍后又执行 `this.log = []`，导致这两类日志在新一手开始时消失；玩家只看到“第 N 手开始 / 盲注”。
- **证据**：`src/game/table.js:333-334` 先调用 `_seatPending` / `_unseatBrokePlayers`，`src/game/table.js:344` 才 `this.log = []`；日志写入在 `src/game/table.js:226,244`。实测 3 人桌把 2 号筹码设为 0 后 `startHand()`，`getState(1).log` 只有“第 2 手开始 / 小盲 / 大盲”，没有“筹码耗尽”。
- **最小复现**（Node）：
  ```js
  const t = new PokerTable({ hostName: 'H' });
  t.addPlayer({ name: 'B' }); t.addPlayer({ name: 'C' });
  t.startHand(); /* 打到 between_hands */ t.__setChips(2, 0);
  const st = t.startHand();
  console.log(st.log.map(l => l.text)); // 无“筹码耗尽”
  ```
- **影响**：仅日志可读性/可解释性，不影响规则与筹码；低。

### P3（低）同一浏览器普通多标签共享 session token，可能互相顶号

- **现象**：session token 按房间码存在同一 origin 的 `localStorage`（`src/main.js:55-72`）。同一浏览器 profile 的两个普通标签加入同一房间时，后加入者覆盖前者的 `txp:session:<code>`；刷新任一标签都可能用最后写入的 token 自动回座，表现为两个标签争同一玩家（房主会把同 playerId 的旧连接关闭，`src/net/peer.js:217-220`）。
- **证据**：代码审查推断（未单独构造双标签实测）+ README 第 95 行建议“两个浏览器窗口 / 无痕窗口”；普通窗口共享同一 profile 的 localStorage，无痕/独立 context 才隔离。本轮所有 E2E 使用独立 BrowserContext，因此未触发。
- **影响**：本机模拟多玩家时可能“顶号”；真实多设备用户不受影响。建议 README 改成“两个无痕窗口 / 两个浏览器 / 两台设备”，或在 token key 中加入随机 tab 标识。
- **说明**：是否算缺陷取决于使用方式；不作为验收失败。

### P3（低）README 的“最近一次 E2E 结果”耗时快照已漂移

- README 第 179-186 行写 `18287ms` / `6237ms`；本轮最新工作区重跑为 `18441ms` / `6196ms`。场景数、结果、覆盖项均一致，只是耗时快照不同，属于文档轻微漂移。
- 建议改为“示例结果”或避免写死具体毫秒。

### 交付状态提示（非代码缺陷）

- 当前工作区 `git status`：`src/main.js`、`src/net/peer.js`、`src/styles.css` 有 Lead 的未提交改动；`docs/app.js`、`docs/styles.css` 是 E2E/build 重建后的产物；`verification/` 是本次验收新增。HEAD 仍是 `aa4064e`。
- 若用 **Deploy from a branch → /docs**，提交时请把 `src/` 与重建后的 `docs/` 一起提交；若用 **GitHub Actions**，workflow 会 `npm run build` 自动重建，需确保工作区改动已提交到 main。
- 这不是验收失败，但属于交付落地前需要处理的 git 状态。

### 已确认的已知边界（符合 README）

| 边界 | 验证结果 |
|---|---|
| 房主可信/可作弊 | 合理：房主页面暴露 `window.__txpTable`，玩家页面不暴露；README 已声明 |
| PeerJS 公共信令 / 复杂 NAT / 无 TURN | 代码仅配置 STUN（`src/net/peer.js:9-18`），README 已声明；真实跨 NAT 未在本机验证 |
| 刷新房主丢房间 | 已实测：房主回 landing，玩家无法恢复 |
| 无自动超时弃牌/托管 | 代码中无超时逻辑；玩家轮到行动时断线不返回会卡住本手，README 已声明 |
| 无账号/聊天/旁观/历史持久化等 | README 已声明；本轮未发现相反实现 |

### 未覆盖/无法在本环境验证

- **真正两台物理设备、企业 NAT/防火墙、不同网络运营商**：本机只能用多个 BrowserContext + 公共 PeerJS 模拟；复杂 NAT 失败风险仍存在（README 已声明）。
- **长时间断网（>45s 心跳阈值）**：本轮验证 2s/3.5s；45s 心跳与指数退避逻辑只读代码确认，未做长时测试。
- **房主信令断开后的 `unavailable-id` 重试路径**：Lead 本轮新增（`src/net/peer.js`），未构造真实 id 占用场景；只确认未破坏 E2E。
- **移动端 6 人座位布局**：Lead 本轮调整了窄屏座位尺寸（`src/main.js:366-381`、`src/styles.css`），本轮 E2E 在桌面 headless 下运行，未做真机/多尺寸截图验收。

---

## 5. README 与实际行为一致性

| README 声明 | 实测 | 结论 |
|---|---|---|
| Pages 静态站点、PeerJS 公共信令、房主权威 | 静态 `docs/` 可部署；真实 PeerJS E2E 通过；房主 `HostSession` 持有牌桌 | 一致 |
| 2–6 人、6 位房间码、初始 1000、盲注 10/20 | 2–6 人独立脚本 + 真实 6 人；2000 次房间码抽样 | 一致 |
| 邀请链接 `?r=房间码` | 浏览器预填 `ABC234`，自动切到“加入房间” | 一致 |
| 完整一手牌、四轮、摊牌、分池 | E2E + 独立脚本 | 一致 |
| 边池多人不等额全下 | 3 人 300/400、4 人 200/150/200/100 | 一致 |
| 底牌仅私发、摊牌后公开未弃牌玩家 | wire 消息 + DOM + localStorage + 全局对象检查 | 一致 |
| 玩家刷新/短时断网恢复 | 刷新、2s/3.5s 断网均通过 | 一致 |
| 刷新房主丢房间 | 已复现 | 一致 |
| 0 筹码下一手离座、局间补码 | 已复现；补码后下一手 3 人继续 | 一致 |
| 无账号/聊天/旁观/历史/自动超时等 | 代码检查未发现 | 一致 |
| “最近一次 E2E 结果”耗时 | 18287/6237ms vs 重跑 18441/6196ms | 仅耗时快照轻微漂移，场景与结论一致 |
| `test/.artifacts` 默认不入库 | `.gitignore` 含 `test/.artifacts/` | 一致 |
| `docs/.nojekyll` 存在 | 空文件存在且上传路径为 docs | 一致 |

**README 行为不一致项**：未发现会影响验收的实质性不一致；仅有上述耗时快照漂移，以及“两个浏览器窗口”在多标签共享 token 场景下的表述不够精确。

---

## 6. 最终结论

- 用户验收清单 **5/5 PASS**：
  1. 联机建立 ✅（2.5–2.7s，双方 2/6 可见）
  2. 完整一手牌 ✅（盲注、底池同步、摊牌判胜、分池）
  3. 底牌保密 ✅（wire + state 递归 + UI + 弃牌玩家专项）
  4. 断线恢复 ✅（刷新 + 2s/3.5s 断网；房主刷新丢房间为已知边界）
  5. 边池 ✅（3 人/4 人不等额全下，筹码守恒）
- 2–6 人、盲注 10/20、初始 1000、下一手庄家移动、Pages 相对路径/`.nojekyll`/Actions 配置均通过。
- **无 P0/P1 阻断问题**；仅有 P2 断线占座无踢人、P3 日志清空/多标签 token/README 耗时漂移等风险，详见第 4 节。
- **最终判定：通过。**

---

## 附录：复现命令

```bash
# 必做
npm test
npm run test:e2e        # 会重建 docs/（允许）

# 独立反证（在项目根运行）
node verification/privacy-and-rules-audit.mjs
node verification/wire-privacy.mjs
node verification/net-capacity-limits.mjs
node verification/pages-readme-audit.mjs
node verification/edge-cases.mjs
node verification/fold-privacy-ui.mjs
node verification/join-latency.mjs
```

> `verification/` 下脚本只读 `src/`、`docs/`、`README.md` 等交付文件；唯一的写入是各自 `verification/artifacts/` 下的 JSON/截图。

---

## 7. 复核补记（d6a4601）

- **复核时间**：2026-11-12 18:51–18:58（Asia/Shanghai）
- **基线**：HEAD `d6a460153eca886b4293b3d2e7205818b475635d`（commit `test: independent acceptance report; fix reconnect banner and hand log`），复核开始时 `git status --porcelain` 为空。
- **改动范围核对**：`src/game/table.js` 将 `this.log = []` 提前到 `_seatPending/_unseatBrokePlayers` 之前；`src/main.js` 的 `setNet()` 在 `room/connecting` 时无条件 `render()`；README 补充无踢人限制、修正多标签说明并移除 E2E 耗时快照；上一轮的 3 处调整已包含在 HEAD。

### 7.1 必做命令（HEAD d6a4601）

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npm test` | 0 | 9/9 通过，0 failed（duration 295.46ms） |
| `npm run test:e2e` | 0 | 2/2 场景通过；场景 1 `18512ms`，场景 2 `6263ms`；`acceptance-report.json` `ok: true` |
| `npm run build`（由 E2E 触发） | 0 | `docs/app.js` 8ad6acf6…、`docs/styles.css` cb1c4189…；构建前后哈希一致 |
| `node verification/recheck-log.mjs` | 0 | 2/2 通过（日志修复确认） |
| `node verification/recheck-banner.mjs` | 0 | 通过（banner 出现，横幅后无误报已连接） |

`npm run test:e2e` 重建 `docs/` 前后哈希一致；复核后 `git status` 仅显示本轮新增/修改的 `verification/` 文件，无 `src/`、`docs/`、`README` 变更。原始 E2E 报告已更新为 [e2e-acceptance-report.json](artifacts/e2e-acceptance-report.json)。

### 7.2 banner 复核（房主页面消失/关闭）

测试脚本：[recheck-banner.mjs](recheck-banner.mjs)，证据：[recheck-banner.json](artifacts/recheck-banner.json)、截图 [recheck-banner-host-gone.png](artifacts/recheck-banner-host-gone.png)。

- 正常连接时：`#conn-banner` 不存在，玩家 `#net-pill` 显示“已连接”。
- 房主页 `host.close()`（硬关闭，模拟页面消失）后：
  - `#conn-banner` 在 **58186ms** 出现；文案：
    `网络连接中断，正在自动重连… · 找不到房间，正在重试…（房主可能暂时离线） 座位与筹码会保留 立即重连`
  - 出现时 pill 为“重连中”；随后 12 秒持续观察，**没有**出现“已连接”误报；结束时 pill 为“连接中”，牌桌画面保留。
- 对照（`probe-banner-variants.mjs` 诊断，证据 [recheck-banner-variants.json](artifacts/recheck-banner-variants.json)）：
  - 房主页面 `reload()`：4ms 出现 banner；
  - 房主端 `window.__txpHost.destroy()`（应用层优雅销毁）：2ms 出现 banner；
  - 硬关闭（page.close）：58.2s 才出现，原因是 `GuestSession` 的心跳检测每 15s 一次、且 `lastMessageAt > 45s` 才主动重连（`src/net/peer.js:322,493-495`），不是本次 `setNet()` 修复失效。

**结论**：`setNet()` 修复有效（`src/main.js:88-92`：`room/connecting` 时无条件 `render()`）——只要状态进入 `reconnecting/connecting`，`.conn-banner` 就会渲染；优雅关闭/房主刷新场景 2–4ms 出现。**残余风险**：硬关闭/进程消失/网络黑洞场景下，玩家在最长约 45–60 秒内仍显示“已连接”，之后才出现横幅；横幅出现后的重连阶段不再误报“已连接”。若产品要求“房主一消失就提示”，需缩短心跳阈值（如 10–15s）或增加主机在线探测；这不影响首版既有验收项。

### 7.3 局间日志复核

测试脚本：[recheck-log.mjs](recheck-log.mjs)，证据：[recheck-log.json](artifacts/recheck-log.json)。

- **3 人局 + 本手加入的等待玩家**：下一手 `startHand()` 后 `getState(1).log` 完整保留：
  ```text
  迟到玩家 入座
  玩家2 筹码耗尽，暂时离座
  第 2 手开始
  迟到玩家 小盲 10
  房主 大盲 20
  ```
  同时确认 0 筹码玩家已离座、等待玩家已入座。
- **2 人局**：把 2 号筹码置 0 后 `startHand()` 抛“至少需要 2 名已入座玩家”，但 `getState(1).log` 仍保留：
  ```text
  玩家2 筹码耗尽，暂时离座
  ```
- 结论：日志清空顺序修复有效，P3 已解决。

### 7.4 README 更新核对

- 已确认 `README.md` 第 95 行改为“两个独立浏览器 / 两个无痕窗口 / 两台设备”，并说明普通多标签共享 session token 可能顶号。
- 已确认第 201 行新增“断线玩家会保留座位与筹码；首版没有移除/踢人入口，6 人满房时需结束房间重开”。
- 已确认第 179 行改为“最近一次 E2E 结果（耗时随机器变化）”，不再写死 18287/6237ms。
- 上述描述与第 4 节的风险观察一致，README 更新正确。

### 7.5 复核结论

**d6a4601 复核通过（PASS）**：

- `npm test` 9/9、`npm run test:e2e` 2/2，`docs/` 重建后无差异；
- banner 渲染修复确认：状态变化后 `.conn-banner` 正常出现，横幅出现后的重连阶段没有误报“已连接”；
- 局间日志修复确认：2 人/3 人场景都保留“筹码耗尽”（以及“入座”）提示；
- README 的 P2/P3 说明已同步；
- 唯一残余风险是硬关闭/网络黑洞下的检测延迟（约 45–60s，属于心跳阈值而非本次修复回归），建议后续缩短心跳或增加主机在线探测；
- 未修改 `src/`、`docs/`、`README`；本轮仅新增 `verification/` 复核脚本与证据。

