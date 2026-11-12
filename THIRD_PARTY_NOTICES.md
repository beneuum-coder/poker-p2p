# Third-party notices

本项目打包/依赖以下第三方软件：

## texas-poker-core 1.4.35

- 用途：德州扑克规则引擎（房间、盲注、发牌、行动、摊牌、奖池与边池分配）
- 许可证：ISC
- 来源：https://www.npmjs.com/package/texas-poker-core
- 该库的编译产物被 esbuild 打入 `docs/app.js`。

## PeerJS 1.5.5

- 用途：WebRTC DataConnection 封装，默认使用 PeerJS 公共信令服务
- 许可证：MIT
- 来源：https://peerjs.com/ / https://github.com/peers/peerjs

## esbuild 0.28.2

- 用途：构建工具（仅开发/部署构建期）
- 许可证：MIT
- 来源：https://esbuild.github.io/

## Playwright 1.65.0

- 用途：端到端浏览器测试（仅开发/测试期，不打入站点）
- 许可证：Apache-2.0
- 来源：https://playwright.dev/

## 公共 PeerJS Cloud

站点运行时默认连接 PeerJS 官方公共信令服务器 `0.peerjs.com`（HTTPS/WSS）。该服务由第三方提供，可用性、限流和隐私策略不属本仓库控制；首版不包含自建信令或 TURN 中继。
