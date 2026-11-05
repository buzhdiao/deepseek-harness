# DeepSeek Harness（根 README 中文翻译 · 校订版）

> **校订说明**：仓库根目录已存在官方中文版 `README.zh.md`（v0.2.2-rc.1）。本文以当前英文 `README.md`（77 行）为底本逐段翻译，并以官方 `README.zh.md`（96 行）为对照进行了校订。已核对的差异点在文末「与官方中文版的差异对照」列出；本文不改动官方文件，仅供 `doc_zh/` 学习文档体系内部使用。

[English](../../README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**（everything-is-a-plugin）的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动；其设计描述见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：<https://deepseek-harness.github.io/deepseek-harness/>

## 开发者预览

DeepSeek Harness 处于 _developer preview_（开发者预览）阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前请先阅读[安全说明](../../SAFETY.zh.md)。

## 运行

### 通过 `npm` 运行

安装 Node.js，然后执行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认在 `http://127.0.0.1:3080` 启动 Web UI；本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅启动服务器而不打开浏览器。详见 [Web UI 指南](https://deepseek-harness.github.io/deepseek-harness/)。

### 从源码运行

如需从仓库检出运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 负责准备仓库产物；`pnpm dsh web` 直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题（GitHub topic），便于被发现。
- 加入 <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord 社区</a>。

## 参与贡献

参见 [CONTRIBUTING.md](../../CONTRIBUTING.zh.md)。

## 开发

从[开发指南](https://deepseek-harness.github.io/deepseek-harness/)与[架构文档](../translations/architecture.zh.md)入手。

`pnpm run dev:web` 在一个终端里完成构建、启动，并在源码修改时重建客户端 bundle；`make help` 列出 Web 与 Desktop 对应的 Make 目标，完整表格以开发指南的「应用命令」一节为准。

面向 agent：请遵循 [AGENTS.md](../../AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](../../LICENSE)

第三方依赖及其许可证在 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) 披露。

---

## 与官方中文版（README.zh.md）的差异对照

1. **社区入口**：官方中文版把英文版的「Discord 社区」一段替换为「企微入群问卷 + 微信公众号」二维码（README.zh.md:51-66）；本文按英文底本保留 Discord 段落，中文读者请以根目录官方 `README.zh.md` 为准。
2. **锚点结构**：官方中文版插入 `<a id="run">`、`<a id="run-from-source">` 等跳转锚点（README.zh.md:17、:31），英文版没有；本文不复制锚点。
3. **链接口径**：官方中文版的 `docs/user/guide/index.zh.md`、`CONTRIBUTING.zh.md`、`docs/development.zh.md`、`docs/architecture.zh.md` 都指向仓库内的 `*.zh.md` 官方译文；本文位于 `doc_zh/translations/`，为避免相对路径歧义，外部文档改用官网链接、仓库内文档改用自本目录出发的相对路径。
4. **措辞校订**：英文 "Review the safety notice before running the project" 官方译为「运行本项目前，请阅读安全说明」；"Third-party dependencies and their licenses are disclosed in" 译为「第三方依赖及其许可证见」。语义一致，本文沿用官方译法。
5. **版本一致性**：截至 v0.2.2-rc.1，英文版与官方中文版其余段落（开发者预览、运行、引用、许可证）内容一致，无需要修订的语义漂移。
