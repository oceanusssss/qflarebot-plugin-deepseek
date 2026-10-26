# QQ 群聊天 Agent（QFlareBot + DeepSeek）

第一版目标：群成员直接 `@机器人 你好`，即可连续聊天。上下文按“机器人 + 群 + 用户”分别保存到 Cloudflare D1；换 Worker 实例仍保留。它目前提供文字聊天与上下文能力。

本项目使用 GitHub 账号 `oceanusssss`：[框架部署仓库](https://github.com/oceanusssss/QFlareBot)、[本插件仓库](https://github.com/oceanusssss/qflarebot-plugin-deepseek)。在 QFlareBot 面板安装插件时，填写本插件仓库链接即可。

## 已实现

- 直接 @ 提问，或 `@机器人 /ai 问题`。
- `@机器人 /清空`（或 `/clear`）清除本人在当前群的上下文。
- `@机器人 /aihelp` 查看说明。
- 默认最近 6 轮上下文；24 小时不用后不再送入模型，每天清理过期记录。
- 每机器人每天最多 100 次 API 尝试，UTC 零点重置；失败尝试也计数，不自动重试付费请求。可在面板修改。
- 默认 `deepseek-flash`，关闭思考模式，每次最多生成 600 Token；不调用搜索或其他付费工具。
- 提问最多 3,000 字符；回复最多约 3,000 字符；20 秒超时。
- D1 原子会话锁防止同一成员并发提问导致上下文乱序；锁 60 秒自动失效。
- API Key 在面板标记为 `writeOnly`，不写进源码，不回显到群里；仅请求官方 API。

QQ Webhook 验签、事件去重、获取 Access Token、消息发送和后台 ACK 由 QFlareBot 负责。插件使用其当前 SDK；实际群内可用性仍须上线联调。

## 部署顺序

1. Fork [QFlareBot](https://github.com/QFlareBot/QFlareBot)，启用 Actions，运行 `Bootstrap`。保留 D1；R2 参数填 `none`，本插件不需要 R2。
2. 按向导部署到 Cloudflare Workers Free，并设置自己保存的 `ADMIN_TOKEN`。任何 API Token、AppSecret、密钥都不要提交到仓库。
3. 绑定已托管在同一 Cloudflare 账号下的域名。`workers.dev` 可用来访问管理面板，但根据 QFlareBot 的实测文档不能用作 QQ 回调。
4. 在面板“设置”扫码创建 QQ 官方机器人；保存凭证，再去 QQ 开放平台配置 `https://你的域名/webhook`。
5. 把机器人加入你是群主的测试群；先发 `@机器人 /sid`，验证官方收发链路。
6. 在“插件 → 添加插件”粘贴本插件公开 GitHub 仓库地址。预检后安装，等构建成功。
7. 插件设置里填 DeepSeek API Key。选择 `deepseek-flash`，首次测试可把每日上限调成 10。
8. 插件详情页“生效的群”选择测试群，完成以下验收后再扩大范围。

初次建 QQ 机器人、手机扫码、验证码、注册身份资料及账号协议需账号本人操作。

## 群内验收

1. `@机器人 请记住我喜欢苹果`，再 `@机器人 我刚才说喜欢什么？`。
2. 换一个群成员提问，确认不会读到前一位的上下文。
3. `@机器人 /清空`，再次提问，确认上下文已清空。
4. 不 @ 的普通群消息不应触发 API。
5. 检查面板事件、QQ 回复、DeepSeek 用量三方记录。只有这些通过，才算上线完成。

## 费用说明（2026-10-26 查阅）

Workers Free 每天 100,000 请求，单次 CPU 10 ms；D1 Free 每天读 500 万行、写 10 万行、总存储 5 GB。低流量群聊可先用免费额度，仍须以部署后的 CPU 和用量实测为准。

DeepSeek Flash：每百万 Token，非缓存输入 $0.15–$0.30、输出 $0.60–$1.20，取决于峰谷时段。按每次**包含历史的总输入** 2,000 Token、输出 500 Token，30 天估算：

| 日聊天次数 | 月模型费 |
| --- | --- |
| 20 次 | $0.36–$0.72 |
| 100 次 | $1.80–$3.60 |
| 500 次 | $9.00–$18.00 |

这不是账单上限。上下文更长、输出更多、输入缓存命中、时段分布和价格变动都会改变费用。默认每天 100 次是**次数上限**，不是美元预算上限。

域名：DigitalPlat 官网提供免费公共名称并支持外部 NS，但当前账号是否有免费注册名额，需要登录后核对。备选是 6–9 位纯数字 `.xyz`，注册局宣传价每年 $0.99；注册商最终价格和续费价应在订单中确认。不要把普通 `.xyz` 首年促销价当长期续费价。

同等 API 用量下，免费 Workers 比另租 VPS 少一笔固定月费。以 DigitalOcean 最小实例为对照，VPS 本身 $4/月起，另加域名及模型费用；这里没有实际购买 VPS，也未对不同平台跑性能对比。

来源：[Workers/D1 定价](https://developers.cloudflare.com/workers/platform/pricing/)、[DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing/)、[DigitalPlat](https://domain.digitalplat.org/)、[数字 xyz 规则](https://gen.xyz/1111b)、[VPS 对照价](https://www.digitalocean.com/pricing/droplets)。

## 本地构建

需要 Node.js 24+、npm、Git。把此仓库与名为 `QFlareBot` 的源码目录并排放：

```text
parent/
  QFlareBot/
  qflarebot-plugin-deepseek/
```

在 parent 下执行：

```powershell
git clone https://github.com/QFlareBot/QFlareBot
Set-Location QFlareBot
git checkout 6ded6f11b7bbbfb29448ade32ab12044bca2e897
npx --yes pnpm@10.34.5 install --filter '@qqbot/plugin-cli...' --frozen-lockfile
npx --yes pnpm@10.34.5 --filter '@qqbot/plugin-cli...' build
Set-Location ../qflarebot-plugin-deepseek
npm install
npm run typecheck
npm test
npm run sync
```

`manifest.json` 必须与源码一起提交，QFlareBot 在线安装会匿名读取它。本插件没有生产第三方依赖；SDK 和 CLI 仅用于开发/构建。

上下文原文存放在你自己的 Cloudflare D1，调用模型时会把当前问题、最近上下文和角色设定发给 DeepSeek；不会额外发送 QQ 用户 ID 或群 ID。QQ 发消息前需确保群成员了解机器人及其数据用途。

本地已通过 TypeScript 类型检查、构建和 14 项测试。测试使用 SDK 会话替身、真实 SQLite 和模拟 DeepSeek 响应；没有伪称已经通过真实 QQ/Cloudflare/DeepSeek 联调。
