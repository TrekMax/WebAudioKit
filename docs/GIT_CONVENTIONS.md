# Git Conventions

本规范适用于 WebAudioKit 的分支、提交和 Pull Request。目标是让历史可回溯、改动可独立验证、回滚成本可控。

## 分支

- 主分支保持可构建、可测试，不直接在主分支上开发。
- 从最新主分支创建短生命周期分支；一项任务对应一个分支。
- 推荐命名：

  - `feat/<topic>`：新功能，例如 `feat/spectrogram-view`
  - `fix/<topic>`：缺陷修复，例如 `fix/wav-frame-count`
  - `perf/<topic>`：性能改进，例如 `perf/fft-transfer-buffer`
  - `refactor/<topic>`：不改变行为的重构
  - `docs/<topic>`、`test/<topic>`、`chore/<topic>`：文档、测试和维护

- 使用小写 kebab-case，不放个人姓名或含糊名称（如 `changes`、`work`、`temp`）。
- 合并前同步主分支并解决冲突。不要强推共享分支；确需改写已公开历史时先协调。

## Conventional Commits

提交标题格式：

```text
<type>(<scope>): <imperative summary>
```

允许的常用 `type`：

- `feat`：新增用户可见能力
- `fix`：修复缺陷
- `perf`：可测量的性能优化
- `refactor`：不改变外部行为的代码调整
- `test`：仅测试或 fixture 变更
- `docs`：仅文档变更
- `build`：构建系统或依赖变更
- `ci`：CI 配置变更
- `chore`：不属于以上类别的维护工作
- `revert`：回滚已有提交

`scope` 应使用稳定模块名，例如 `audio`、`playback`、`fft`、`waveform`、`spectrogram`、`3d`、`worker`、`export`、`ui`、`docs` 或 `ci`。范围不明确时可省略，不要发明过细 scope。

标题使用祈使语气，简洁说明结果，不加句号，建议不超过 72 个字符：

```text
feat(waveform): add selection zoom controls
fix(export): preserve exact selected frame count
perf(worker): transfer spectrogram buffers without cloning
docs: document WebGL fallback behavior
```

提交正文解释“为什么”和关键取舍，不复述 diff。关联 issue 时在 footer 使用 `Refs: #123` 或 `Closes: #123`。破坏性变更使用 `!`，并在 footer 说明迁移方式：

```text
feat(analysis)!: normalize FFT output to dBFS

BREAKING CHANGE: consumers must interpret magnitudes as dBFS instead of linear gain.
```

## 原子提交

- 每个提交只表达一个完整意图，并且能够独立构建、测试和回滚。
- 实现与直接对应的测试、类型和必要文档应放在同一提交中。
- 不要把无关格式化、依赖升级、重命名和功能开发混在一起。
- 不要提交“WIP”“fix again”“misc changes”等中间历史。发 PR 前整理为有意义的提交，但不得未经协调改写他人共享历史。
- 提交前审阅 `git diff --staged`，确保没有调试日志、临时文件、秘密、用户数据或越界改动。

## 禁止提交的内容

- `node_modules/`、`dist/`、`coverage/`、临时缓存、编辑器本地状态和运行日志。
- API key、token、证书、私钥、真实用户音频、个人信息或本机绝对路径。
- 大型音频 fixture 或手工导出的分析结果。默认不得提交超过 1 MiB 的音频二进制；任何例外都必须事先评审，并优先考虑 Git LFS 或外部可校验下载。
- 可由测试确定性生成的 WAV/PCM fixture。优先使用代码生成静音、脉冲、正弦、扫频和噪声信号。
- 未经评审的自动生成产物。依赖锁文件属于应提交内容，但仓库只能保留与所选包管理器匹配的一种锁文件。

提交前使用 `git status --short` 检查未跟踪文件，并确保 `.gitignore` 覆盖本地/构建产物。不要仅依赖 `.gitignore` 阻止敏感信息泄漏。

## 质量门禁

合并前必须通过仓库实际提供的以下检查：

```bash
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
```

- 改变 DSP/FFT/STFT：增加已知信号、数值容差、边界与不同采样率测试。
- 改变播放或线程协议：覆盖状态转换、取消、过期消息和资源清理。
- 改变 UI/可视化：覆盖关键交互、空/错误状态与能力降级；适用时提供截图。
- 改变导入导出：验证格式、长度、声道、位深，以及导出后的重新解码。
- 改变性能关键路径：提供基准输入、环境、前后数据，确认没有明显内存或主线程回退。

不得通过删除/跳过测试、放宽合理阈值或关闭规则来让门禁变绿。检查因环境原因无法运行时，在 PR 中注明命令、原因、风险和替代验证，由评审者决定是否可合并。

## Pull Request

PR 应保持小而聚焦，标题遵循 Conventional Commits。描述至少包含：

- 背景/问题与明确范围
- 方案和重要设计取舍
- 用户可见变化；UI 改动附截图或短录屏
- 已执行的测试命令与结果
- 性能、兼容性、线程安全或数据迁移风险
- 未完成项与关联 issue

PR 作者先完成自审，尤其检查音频资源生命周期、跨线程 buffer 所有权、大文件内存和浏览器降级。至少获得一位维护者批准并通过全部必需检查后合并。优先 squash merge，以 PR 标题作为最终 Conventional Commit；若保留多提交历史，每个提交也必须满足本规范。

## 紧急修复与回滚

紧急修复同样需要最小复现、测试和 PR，不以“紧急”为由绕过门禁。回滚使用 `git revert` 形成可审计的新提交；禁止用重置或强推删除主分支历史。
