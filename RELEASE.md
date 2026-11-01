# 发布清单 · v27.1.0 正式版

本文件是给“打包上 GitHub + 发 Release”的操作手册，照着做即可。

## 仓库结构

```
yuketang-autoplay/
├── README.md                              # 首页说明（安装/功能/排错/演进表）
├── CHANGELOG.md                           # 版本演进，v1 → v27.1
├── LICENSE                                # MIT
├── RELEASE.md                             # 本文件
├── dist/
│   └── 雨课堂·学堂在线-自动连播-v27.1.0.user.js   # ✅ 发布物（Tampermonkey 直接装）
├── src/                                   # 留空，源码即发布物（单文件脚本）
└── docs/                                  # 后续可放截图
```

## 发布前检查

- [ ] 把 README / CHANGELOG / 脚本头里的 `taisw` 换成你的 GitHub 用户名
- [ ] 在课程页实测三项：视频能播完跳下一视频、图文页能跳到下一视频、静音不破音
- [ ] 面板「🔍 章节诊断」里 `node排序: ✓`
- [ ] `DEBUG` 保持 `false`（脚本内第 12 行）

## GitHub 发布步骤

1. **建仓库**
   GitHub → New repository → 名 `yuketang-autoplay` → Public → 勾 README（可跳过，本地已有）
2. **推代码**
   ```bash
   git init
   git add README.md CHANGELOG.md LICENSE RELEASE.md dist/
   git commit -m "Release v27.1.0 正式版：v21视频逻辑 + node_id排序跳非视频 + 强制静音增强"
   git tag -a v27.1.0 -m "v27.1.0 正式版"
   git remote add origin https://github.com/你的用户名/yuketang-autoplay.git
   git push -u origin main --tags
   ```
3. **发 Release**
   GitHub 仓库页 → Releases → Draft a new release
   - Tag：`v27.1.0`
   - Title：`雨课堂·学堂在线 自动连播 v27.1.0 正式版`
   - 描述：把下面“Release 文案”粘贴进去
   - **把 `dist/雨课堂·学堂在线-自动连播-v27.1.0.user.js` 拖进附件**（必须，这是用户点开就装的入口）
4. **更新安装链接**（可选）
   把 README 里「安装」第二条改成你的 Release 附件直链，例如：
   `https://github.com/你的用户名/yuketang-autoplay/releases/download/v27.1.0/雨课堂·学堂在线-自动连播-v27.1.0.user.js`

## Release 文案（直接复制）

```
## 雨课堂·学堂在线 自动连播 v27.1.0 正式版

视频流程回到**已验证最稳的 v21**：硬跳（videoId+1 / node_id+1）、播完或「已完成」立即暂停、
60s 加载宽限、完成度达标才跳。

非视频页（图文 / 讨论 / 作业）用全新的 **node_id 排序法**，彻底解决 v22~v25 一直搞不定的跳转问题：
收集章节 node_id → 取比当前大的最小者 → 同 node 优先跳视频，不再依赖 DOM class、不再误点“讨论区”、不再跳回第一节。

### 本次升级
- 🔇 **强制静音增强**：video + audio 全压 0，MutationObserver 盯住播放器换源重建，play / loadedmetadata / volumechange 三次校正，杜绝破音
- ⏱ 播完最短等待默认 **3s**；📄 跳过前等待默认 **2s**
- 章节列表缓存 + 面板 DOM 缓存 + RAF 节流，不卡页面
- 日志分级，`DEBUG=false` 只输出关键节点

### 安装
下载下方附件 `.user.js`，拖进 Tampermonkey / Violentmonkey 即可。

> 仅用于个人学习自动化，请遵守平台规定。

完整变更见 [CHANGELOG.md](https://github.com/你的用户名/yuketang-autoplay/blob/main/CHANGELOG.md)。
```

## 以后发新版

1. 脚本头 `@version` + 文件名版本号同步升（如 `27.2.0`）
2. `@downloadURL` / `@updateURL` 里的版本串一起改
3. 新文件放 `dist/`，旧版保留一份便于回滚
4. 补 CHANGELOG → commit → tag → GitHub Release 附件勾新文件
