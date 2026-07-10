# WebAudioKit Agent Guide

本文件约束所有在本仓库中工作的自动化 Agent。若用户的明确要求与本文冲突，以用户要求为准；若子目录存在更具体的 `AGENTS.md`，则该文件对其目录树优先。

## 开始工作前

1. 完整阅读 [`docs/PRD.md`](docs/PRD.md) 与 [`docs/TECHNICAL_DESIGN.md`](docs/TECHNICAL_DESIGN.md)，确认需求边界、性能目标和验收标准。
2. 阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md) 与 [`docs/GIT_CONVENTIONS.md`](docs/GIT_CONVENTIONS.md)。
3. 执行 `git status --short`，识别并保留用户或其他 Agent 已有的改动；不要覆盖、不回滚、不顺手整理无关文件。
4. 查看 `package.json` 和锁文件，以仓库实际脚本与包管理器为准。开始编码前先定位现有实现和测试。
5. 将任务拆成最小可验证范围。需求不清晰但可安全推断时记录假设；会改变产品范围、数据格式或公共 API 时先向用户确认。

## 产品边界

WebAudioKit 是浏览器端、本地优先、非破坏式音频分析平台。核心闭环是：

`导入/解码 -> 播放与选区 -> 波形 -> FFT/STFT -> 频谱/声谱/3D -> 音频或分析结果导出`

- 音频内容默认只在用户设备内处理；未经明确需求，不上传音频、不引入服务端依赖或遥测。
- MVP 聚焦单文件分析、可靠播放、视图联动、WAV 与分析数据导出。不要擅自扩展到 DAW、多轨编辑、云协作或账号系统。
- 原始音频数据保持不可变。裁剪、循环、归一化等都以选区或导出参数表示，不直接改写源 PCM。
- 不假设所有浏览器支持同一编解码器、WebGL2、AudioWorklet 或 WebCodecs。能力必须运行时检测，并保留文档定义的降级路径。
- 对大文件保持内存有界：优先分块、降采样、峰值金字塔和可取消任务，禁止为了实现方便复制整份多声道 PCM。

## 模块职责与依赖方向

目录尚未存在时可按技术设计创建；已有结构优先遵循现状。

- `src/audio/`：AudioContext、播放状态机、AudioBuffer/PCM 生命周期、选区与导出音频管线。不得依赖 React 组件。
- `src/analysis/`：窗函数、FFT/STFT、幅度与 dB 标定、分析参数及纯数据模型。算法应可在无 DOM 环境测试。
- `src/workers/`：离线 FFT、峰值构建、编码及协议。消息必须带任务 ID，支持取消并忽略过期结果。
- `src/visualization/`：Canvas/WebGL/Three.js 渲染、坐标映射、LOD 与 GPU 资源释放。只消费分析数据，不拥有播放真相。
- `src/components/` 或 `src/features/`：界面组合、交互和可访问性。通过稳定接口调用音频/分析层，不在组件渲染中执行 DSP。
- `src/state/`：项目、播放、选区和视图状态；明确临时 UI 状态与持久化项目状态的边界。
- `src/utils/`：无领域归属的少量通用工具。领域逻辑不要堆入 `utils`。
- `tests/`：跨模块与浏览器集成验证；模块旁可放纯单元测试。

依赖方向应保持为 `UI/visualization -> domain API -> audio/analysis/workers`。播放位置、选区与分析参数必须有单一事实来源，禁止三个视图各自维护一份可漂移的状态。

## 音频与实时线程安全

- `AudioWorkletProcessor.process()` 属于实时渲染路径：禁止网络/文件 I/O、DOM、日志、Promise、锁、动态导入、大对象分配、数组扩容和不可预测的长循环。
- 实时路径使用预分配缓冲区、固定上限和无阻塞算法。不要在每个 render quantum 中创建对象、闭包或临时 TypedArray。
- 重型 FFT/STFT、全文件峰值、图片/CSV/WAV 编码放入 Web Worker；UI 主线程只做调度和渲染。不要把离线分析塞进 AudioWorklet。
- 跨线程消息使用明确、可版本化的协议。大 TypedArray 优先 transfer，避免结构化克隆产生多份 PCM；高频进度消息应限流或批处理。
- 每个异步任务都要有任务 ID/版本号与取消策略。文件、选区或参数变化后，旧任务结果不得写回当前状态。
- Web Audio 节点的创建、连接、断开和销毁必须成对；关闭文件或卸载视图时 `disconnect()`、`terminate()`、`dispose()` 并释放引用。
- AudioContext 的创建/恢复遵循浏览器用户手势限制。切勿用循环重试掩盖 suspended 状态。
- 时间统一以秒或采样帧表达，并在类型/变量名中体现。通道布局、采样率、FFT size、hop size、窗函数、dB 参考值不可隐式假定。
- 算法变更必须用可计算信号验证，例如静音、脉冲、满幅正弦和非整 bin 正弦；同时覆盖 NaN、Infinity、零长度和尾帧补零。

## 常用命令

以 `package.json` 中实际脚本为准。npm 项目的标准工作流为：

```bash
npm ci                 # 按锁文件安装依赖
npm run dev            # 本地开发
npm run lint           # 静态检查
npm run typecheck      # TypeScript 检查
npm test               # 单元/集成测试
npm run build          # 生产构建
```

- 若锁文件指向 pnpm/yarn，使用对应工具，不要生成第二种锁文件。
- 不为执行单个命令全局安装工具；优先使用项目脚本或 `npm exec`。
- 不手工修改自动生成的构建产物、覆盖率目录或依赖目录。

## 测试与验证

按改动风险选择验证，不能只确认“页面能打开”。

- DSP/数值逻辑：单元测试必须包含已知输入、容差、边界尺寸和不同采样率。
- 播放状态机：验证播放/暂停/停止/seek/循环，以及快速切换文件和连续操作。
- Worker：验证成功、失败、取消、过期结果、transfer 后缓冲区状态和资源回收。
- 可视化：验证坐标映射、缩放范围、空数据、单/双声道和 WebGL 降级；必要时做浏览器截图或交互测试。
- 导出：检查格式头、采样数、声道交错、位深、选区边界和重新解码结果。
- 性能相关改动：记录音频时长、采样率、声道、浏览器与设备，并检查主线程卡顿、内存峰值和资源释放。

交付前至少运行受影响测试、类型检查与 `npm run build`；仓库提供 lint 时同时运行 lint。若环境原因无法执行，必须在交付说明中明确未验证项和原因。最后运行 `git diff --check` 和 `git status --short`。

## 文件编辑与提交纪律

- 只编辑当前任务需要的文件。优先小型、可审阅的补丁；保持现有风格，不做无关格式化或依赖升级。
- 使用 `apply_patch` 进行手工文件修改。代码生成器或格式化器可用于其明确负责的机械产物。
- 永远不要使用 `git reset --hard`、`git clean -fd`、`git checkout -- <file>` 等破坏性命令处理共享工作区。
- 不覆盖用户或其他 Agent 的未提交改动；发生重叠时先阅读差异并协调。
- 未经用户明确授权，不执行 commit、push、rebase、merge、创建 PR 或修改远端状态。
- 获得提交授权后，遵守 [`docs/GIT_CONVENTIONS.md`](docs/GIT_CONVENTIONS.md)：Conventional Commits、原子提交、测试门禁和清晰的提交范围。
- 禁止提交密钥、个人数据、`node_modules/`、`dist/`、覆盖率产物、浏览器缓存或大型音频 fixture。测试音频优先在测试中确定性生成。

## 完成交付

交付说明应简洁列出：实现结果、关键设计取舍、已执行的验证、未执行或失败的验证、已知限制，以及用户需要关注的文件。不要声称未运行的测试已经通过。
