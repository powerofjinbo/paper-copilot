# paper-copilot

一个在你自己电脑上运行的物理论文 LaTeX 编辑器。写作、审阅和来源记录都以**句子**为单位。AI 先读你的分析代码仓库和参考文献，再陪你一句一句地写：用你自己的文风，遵守你自己的写作 skill，并且绝不编造数字或引用。

[English](README.md) · [设计文档](docs/design.md) · [实施计划与验收测试](docs/plan.md) · [架构决策](docs/adr/)

## 为什么做这个

AI 的英文已经很流畅，但它写出来的东西千篇一律，还会随手编出数字、cut 和参考文献。非母语作者吃两次亏：更容易接受 AI 的建议；而在 AI 初稿上改出来的文字，会留下作者自己察觉不到的 AI 腔。paper-copilot 不去改模型，而是改变人和 AI 协作的方式：

- **有据可查。** 一个确定性的提取器把分析仓库里的 `results/*.json`、`results/*.csv` 和 `docs/definitions.md` 变成事实库（数值、误差、文件路径、JSON 指针或 CSV 单元格、SHA-256）。AI 写出的每个数字都必须对应一条事实；每个 `\cite` 都必须在 INSPIRE-HEP 上解析成功或由你确认。其余的一律变成看得见的占位符，比如 `[fact?: ...]` 或 `[ref]`。
- **是你的文字。** 你的 `hep-paper-writing` skill 原样从磁盘加载，约束每一句 AI 文字。文风层会加入你自己独立写的句子作为示例、你写作的实测指标，以及从你修改 AI 文字的记录中学到的偏好备忘（纯语法修改不参与学习）。文风仪表会显示某一节离你本人的风格有多远。
- **可以逐句审阅。** AI 写的句子在你接受、修改、给指令或拒绝之前，会一直以“还不是你的”样子显示。每个版本都有记录（模型、提示词哈希、指令、编辑距离），所以期刊要求的 AI 使用声明可以自动生成。
- **和合作者协作时安全。** `.tex` 文件始终是唯一的真相来源，通过 Overleaf 的 git bridge 同步。所有元数据都放在旁边的 `.paper/` 目录里。只要还有未审阅的 AI 文字、占位符或中文意图行，推送就会被拒绝。

## 两种写法

**灰字预测模式。** 你打字；停顿、一句话结束，或按 Ctrl+Space / Alt+/ 时，下一句会以浅灰色出现，内容来自你的事实库。Tab 接受，Ctrl/Cmd+→ 接受一个词，Esc 放弃。按 `?` 查看全部快捷键。在最需要你本人声音的部分（摘要、引言、结论），AI 只会补完你已经开头的句子。在单独一行用中文写下你的想法，按 Ctrl/Cmd+Enter，它会变成一句你文风的英文，中文原意一直挂在这句话上。

**先起草，再审阅。** 先填大纲（skill 的 Step 0 五项：一句话故事、gap 和 enabler、由易到难的案例阶梯、每个结论对应的图、带基线和条件的核心数字）。只有你自己写完这五项之后，起草功能才会解锁，避免 AI 的思路先入为主。然后让 AI 起草一节。段落先以“任务卡片”出现，可以调整顺序；之后每句话以灰色进入正文。Alt+↓ 跳到下一句。Ctrl/Cmd+Enter 接受；直接打字就是修改；Ctrl/Cmd+I 给出修改指令（可以用中文），会显示逐词对比和“含义漂移”检查；Ctrl/Cmd+G 只改语法；`l` 看其他写法；`r` 自己重写；`x` 拒绝，句子变成 `[claim: ...?]` 占位符，保证不会悄悄丢掉一个结论。

## 第一步

1. **先在浏览器里试，不用装别的：** 运行 `pnpm install`，再运行 `pnpm --filter @paper-copilot/web dev`，打开
   `http://127.0.0.1:5173/?mock=1`。第一次打开时会提示一个 8 步的新手引导（之后可在 **?** → “新手引导”里重新开始），
   在示例论文上每步亲手做一件事：打开句子卡片、用中文给 AI 下指令并接受、把一行中文想法变成英文句子、接受灰色补全、
   改一个数字看它被标为“没有来源”、起草一段再到 ③ 待办里审阅、运行投稿检查。**?** → “重置示例论文”可以从头再来。
   演示模式没有 LaTeX：“编译”显示的是一份示例 PDF，不会随你的修改更新。
2. **安装 TeX，才能编译真正的 PDF。** Mac：`brew install --cask mactex-no-gui`（或装 BasicTeX，再运行
   `sudo tlmgr install latexmk revtex`），装完新开一个终端。Linux：
   `sudo apt install latexmk texlive-latex-extra texlive-publishers`。用 `pnpm paper doctor` 检查。
3. **写你自己的论文：** 按下面的“快速开始”操作。

## 快速开始

需要：Node ≥ 22.13 和 pnpm、Python ≥ 3.11、带 `latexmk` 和 `synctex` 的 TeX Live、git。要用真正的 AI，需要 Anthropic API key；没有 key 时会以明确标注的“模拟 AI”模式运行。

```bash
git clone https://github.com/powerofjinbo/hep-writing-skill.git ~/.claude/skills/hep-paper-writing
```

```bash
git clone https://github.com/powerofjinbo/paper-copilot.git && cd paper-copilot && pnpm install && pnpm build
```

从你的 Overleaf 项目（git bridge 地址在 Overleaf 菜单 → Git）和分析仓库创建项目：

```bash
pnpm paper import https://git@git.overleaf.com/<project-id> --to ~/papers/canto
```

```bash
pnpm paper init ~/papers/canto --repo ~/code/Displaced_tracks_GNN --sync git --remote https://git@git.overleaf.com/<project-id> --branch master --venue aps --notes zh
```

请使用绝对路径。可选：`pnpm paper semantic-lines ~/papers/canto` 把每句话放到单独一行（可用 `--undo` 撤销），这样和 Overleaf 上的修改合并时以句子为单位，冲突更少；使用前请先和合作者商量。

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # 或者存进系统钥匙串，服务名 "paper-copilot"
pnpm paper open ~/papers/canto
```

`paper doctor ~/papers/canto` 会检查 Node、Python、TeX、skill、API key 和 git 远端。

## 当前状态

[实施计划](docs/plan.md) 的 Phase 0 工具、Phase 1a 和 1b 已经实现，Phase 2 也完成了一部分：重新规划、起草、文献解析、文风备忘学习、文风仪表和同步面板都已就绪。在这个环境里（模拟 AI、本地 git 远端、TeX Live 2023）运行并通过的测试：

| 测试 | 结果 |
|---|---|
| `packages/core`（句子切分、带随机模糊测试的句子锚定、忠实性检查、提示词、披露声明等） | 642 个通过 |
| `packages/client-core`（灰字预测状态机、审阅队列） | 102 个通过 |
| `apps/server`（各项服务、路由、安全、SDK 请求格式、进程内端到端） | 530 个通过 |
| `apps/web`（同步、装饰、灰字、面板、API 客户端、新手引导、演示 PDF） | 242 个通过 |
| `sidecar`（以常驻进程运行你的 `style_check.py`） | 25 个通过 |
| `node e2e/fullstack.mjs`（真实服务器 + 构建后的网页，在 Chromium 中走完 Phase 1a 验收流程：编译、双向 SyncTeX、起草与审阅、推送先被拒后放行、合作者修改后拉取保留 29/29 个句子 ID、kill -9 后重启；投稿检查、摘要与正文数字不一致的检出、恢复历史版本、经忠实性检查放行的推导数字“2.5 倍”、分析结果 JSON 更新后事实被标为过期、多文件论文的文件切换、四步布局在中文/浅色/深色下的显示） | 28/28 |
| 浏览器测试脚本（`apps/web/harness/*.mjs`：演示模式整体、编辑器、PDF、UX 审查；演示模式脚本包含中文/浅色与英文/深色下的新手引导） | 32/32、14/14、17/17、18/18 |

在测试论文上，句子切分与 skill 的 `style_check.py` 100% 一致。从五个角度（科研诚信、句子锚定、安全、SDK 正确性、易用性）做的对抗式审查发现了 36 个问题，每个都先用失败的测试复现再修复，这些测试保留为回归测试。

**还没验证、需要在你电脑上做的：** 真实的 Claude API 调用和 Agent SDK（请先运行 `scripts/bench/ttft.ts` 和 `scripts/bench/prewarm-format.ts`，见 [scripts/bench/README.md](scripts/bench/README.md)）、真实的 Overleaf 远端、macOS 的按键和钥匙串、真实的 Canto 稿件。没有 API key 时，界面会标明“模拟 AI”，所有 AI 输出都是确定性的替身。

不做任何配置也可以先试界面：运行 `pnpm --filter @paper-copilot/web dev`，打开 `http://127.0.0.1:5173/?mock=1`（整个服务器在浏览器里模拟，用的是测试论文）。

## 许可

MIT
