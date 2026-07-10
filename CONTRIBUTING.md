# Contributing to WebAudioKit

感谢参与 WebAudioKit。开始前请先阅读：

- [`docs/PRD.md`](docs/PRD.md)：产品范围与验收标准
- [`docs/TECHNICAL_DESIGN.md`](docs/TECHNICAL_DESIGN.md)：架构、数据流与性能约束
- [`AGENTS.md`](AGENTS.md)：自动化 Agent 的工作规则
- [`docs/GIT_CONVENTIONS.md`](docs/GIT_CONVENTIONS.md)：分支、提交和 PR 规范

## 开发流程

1. 从最新主分支创建短生命周期分支，例如 `feat/waveform-zoom` 或 `fix/export-frame-count`。
2. 安装锁定依赖并启动开发环境：`npm ci && npm run dev`。
3. 保持改动聚焦，新增行为同时补充相应测试；DSP 逻辑需使用可计算信号与明确误差容限验证。
4. 提交前运行项目已有的质量门禁：

   ```bash
   npm run lint
   npm run typecheck
   npm test
   npm run build
   git diff --check
   ```

5. 按 Conventional Commits 创建原子提交，并发起包含背景、改动、验证与风险说明的 PR。

不要提交 `node_modules/`、`dist/`、覆盖率文件、密钥或大型音频样本。音频测试优先在代码中确定性生成；确需新增小型 fixture 时，应说明来源、许可、大小及不可生成的理由。

若某项检查因环境限制无法执行，请在 PR 中明确记录命令、原因和影响，不要静默跳过。
