# Changelog

所有值得记录的改动都会写进这个文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [27.1.0] - 2026-11-01 · 正式版

### 新增
- **强制静音增强**：同时压制 `video` 与 `audio`；用 `MutationObserver` 监听播放器动态插入/替换媒体元素；在 `play`、`loadedmetadata`、`volumechange` 三次校正，解决“点了静音还突然出声”。
- 配置项：默认**强制静音开启**；播完最短等待默认 **3s**；非视频/空页跳过前等待默认 **2s**。
- 首次安装用 `ykt.endWait_default_written=27` 标记强写一次默认值，避免旧版 GM 值残留成 20s/15s。

### 优化
- 章节列表 `collectChapters()` 加缓存，URL 变化才失效；先定位列表容器再扫 `a[href]`，减少全页面遍历。
- 面板 DOM 引用启动时缓存，不再每次 `querySelector`；`update` 用 `requestAnimationFrame` 节流合并。
- 日志分级：`DEBUG=false` 时只输出启动 / 跳转 / ERROR，排错不刷屏。

### 稳定
- **视频流程 = v21 原样保留**：`videoId+1` + `node_id+1` 硬跳、播完/「已完成」立即 pause、60s 加载宽限、完成后等完成度达标才跳。
- **非视频跳转 = node_id 排序法**：收集章节链接的 `node_id` → 取比当前大的最小值 → 同 node 优先 video。彻底绕开 v22~v25 依赖 DOM class/层级的“当前项定位”死局，不再误点“讨论区”tab、不再跳回第一节。
- 兜底链：node 排序 → 列表顺序（仅能定位当前项时）→ 数字递增 + 已访问防重。

---

## [21.0.0] - 视频流程黄金基线
- 视频页硬跳（连续 `videoId` + `node_id` 实测可用）、SPA 导航后状态重置重启。
- 播完立即 pause 防循环；识别「已完成」直接进跳转。
- 静音双保险（`muted=true` + `volume=0`）。
- 此后版本视频逻辑一律以此为准，不再改动。

## [17.0.0] ~ [20.0.0] · 完成度驱动 + 卡住判定
- 完成度达标才跳，兼容「已完成」文字。
- 无有效视频 12s / 进度为 0 满 30s 自动跳过。
- v20 引入三段式判定（无 video / 加载中 / 有效视频），但加载宽限被后续版本误用。

## [14.0.0] ~ [16.0.0] · 倍速折腾与回退
- v14 倍速档位导致回第一节 + 卡死；v15 加 URL 保护；v16 **删除全部倍速控制**得到稳定基线。
- 结论：倍速交给播放器自带按钮，脚本不碰。

## [6.3.0] ~ [13.0.0] · 上报与清理机制定型
- v6.3 确认“持续上报到 95% 才能统计完成度”。
- v7 全程每 1.5s 上报；v12 发现清理 = 有效；v13 定为**每视频前轻量清理一次**（只清 session + Cache，不动 localStorage）。

## [1.0.0] ~ [5.3.0] · 探索期
- 本地倍速 → 心跳上报 → 抓包定位 `study_stat` GET 轮询 → 持久面板抗 SPA。
- 确立认知：完成度靠服务端聚合，客户端只能“播 + 等 + 清缓存”。

---

[27.1.0]: https://github.com/taisw/yuketang-autoplay/releases/tag/v27.1.0
[21.0.0]: https://github.com/taisw/yuketang-autoplay/releases/tag/v21.0.0
