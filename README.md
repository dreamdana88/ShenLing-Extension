# 蜃灵助手

蜃灵助手是一个 SillyTavern 第三方插件，用于长篇剧情游玩中的总结、归档、通讯日志、副 API 管理、词汇替换与角色状态辅助。

当前版本：`0.11.4`

GitHub 仓库：

```text
https://github.com/dreamdana88/ShenLing-Extension
```

## 当前已接入

- 独立弹出式主面板
- 浅色/深色插件主题
- 手机端适配
- 可拖动悬浮球入口
- 全局设置与聊天专属 metadata 分离保存
- 副 API Profile 管理
- 支持 OpenAI-compatible 地址与 `/v1` 兼容
- 支持拉取模型列表
- 支持使用酒馆主 API 模式
- 插件通讯日志
- 自动小总结 `<memory>`
- 0 楼小总结手动生成
- 指定楼层小总结重写与编辑
- 自动大总结 `<grand_memory>`
- 大总结归档楼、隐藏区间、重新生成
- 旧聊天分批归档第一版
- 词汇替换
- 情感档案第一版：随小总结同次判断、写入 metadata，并在主生成前注入最新版

## 施工中模块

以下模块已有入口或方向规划，但还没有完整接入真实功能：

- 回忆录世界书
- 七日程
- 日记本
- 平行事件
- 剧情规划
- 逆攻略
- 灵感工具
- 向量记忆预研

## 安装

在 SillyTavern 中打开：

```text
Extensions -> Install Extension
```

填入仓库地址：

```text
https://github.com/dreamdana88/ShenLing-Extension
```

安装后可在扩展设置中看到“蜃灵助手”。

## 更新

如果是通过 GitHub 安装的第三方插件，可以在 SillyTavern 扩展管理中更新插件。

开发时常用流程：

```text
修改插件文件
↓
GitHub Desktop 查看 changed files
↓
填写 Summary
↓
Commit to main
↓
Push origin
↓
回 SillyTavern 更新插件并刷新页面
```

## 副 API 说明

副 API 配置位于插件设置页。

目前支持：

- 多 Profile 保存与切换
- API 地址
- API Key
- 模型名
- 拉取模型
- 使用主 API / 独立副 API 切换

插件已移除“测试连接”功能，因为部分公益站不允许超轻量测试请求，可能导致账号被限制。
