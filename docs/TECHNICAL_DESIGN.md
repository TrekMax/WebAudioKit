# WebAudioKit 技术设计

> 状态：Draft（进入实现前的基线）  
> 版本：0.2.0
> 日期：2026-07-10  
> 适用范围：首个可交付版本（MVP）及其后续演进

## 1. 文档目的

本文定义 WebAudioKit 的工程边界、运行时架构、数据模型、音频与频谱算法约定、线程协议、性能目标和技术决策。实现、测试与评审均以本文为基线；若实现需要改变关键约定，应先补充 ADR，再修改代码。

### 1.1 设计目标

- 在浏览器中完成音频导入、解码、播放、选区、波形、实时频谱、离线声谱图、FFT 3D 预览和 WAV/CSV 导出。
- 默认本地处理，不上传用户音频；离线分析结果可缓存、可取消、可重建。
- 波形、2D 声谱图和 3D 视图共享同一时间轴、选区和 FFT 数学定义。
- 音频播放不因计算或绘制发生可感知卡顿；大型分析任务不阻塞主线程。
- 用整数采样点表达音频边界，避免跨视图累计浮点误差。
- 所有高成本资源都有明确的创建、取消、失效与释放路径。

### 1.2 非目标

MVP 暂不承诺：

- 无损编辑、多轨混音、插件宿主或 DAW 级撤销历史。
- 浏览器无法原生解码格式的统一兼容。
- MP3、AAC、FLAC 等压缩格式编码导出。
- 超长音频的真正流式解码与流式播放。
- 麦克风、系统音频或远程流的实时采集。
- 服务器端同步、多人协作或云端项目管理。

## 2. 技术栈与工程约束

| 领域 | 选择 | 用途与约束 |
| --- | --- | --- |
| 应用框架 | React + TypeScript + Vite | React 负责 UI 组合；TypeScript 开启严格模式；Vite 负责开发与构建 |
| 音频 | Web Audio API | `AudioContext`、`AudioBuffer`、`AudioBufferSourceNode`、`GainNode`；播放节点不进入 React state |
| 波形与降级绘制 | Canvas 2D | 波形、标尺、选择区、播放头，以及 WebGL2 不可用时的 2D 声谱图降级 |
| GPU 可视化 | WebGL2 + Three.js | 2D 声谱纹理与 FFT 3D 曲面/瀑布；必须处理 context lost 与资源释放 |
| 后台计算 | Web Worker | 峰值金字塔、FFT/STFT、数据量化、WAV/CSV 编码；主线程仅做调度与渲染 |
| 本地缓存 | IndexedDB | 项目状态、峰值层级、频谱瓦片和缓存索引；缓存永远可丢弃并重建 |
| 测试 | Vitest + React Testing Library + Playwright | 数值算法、状态机、组件交互和浏览器端集成测试 |

依赖版本写入 lockfile 并固定。核心算法不依赖未维护的黑盒 FFT 组件；若采用第三方 FFT 库，必须用本设计中的标定用例验证其归一化、bin 顺序和实数输入输出约定。

TypeScript 最低要求：

- `strict: true`，不使用无说明的 `any`。
- Worker 与主线程共享协议类型，禁止两端各自复制一份字符串常量。
- 时间边界使用 `SampleIndex` 语义类型，视图坐标转换集中实现。
- 可持久化状态与运行时对象分离，`AudioBuffer`、AudioNode、Worker、Three.js 对象不得进入序列化 store。

## 3. 总体架构

### 3.1 分层

```text
┌──────────────────────────────────────────────────────────────┐
│ Presentation                                                │
│ React Shell / Toolbar / Panels / Canvas2D / Three.js Views  │
└──────────────────────────────┬───────────────────────────────┘
                               │ commands + snapshots
┌──────────────────────────────▼───────────────────────────────┐
│ Application                                                 │
│ ImportCoordinator / PlaybackController / AnalysisCoordinator│
│ ExportCoordinator / ProjectStore / ViewportCoordinator      │
└───────────────┬──────────────────────────────┬───────────────┘
                │ domain values                │ ports
┌───────────────▼──────────────┐  ┌────────────▼───────────────┐
│ Domain                       │  │ Infrastructure              │
│ AudioAsset / Selection       │  │ WebAudioEngine / IDB Cache │
│ AnalysisConfig / State       │  │ WorkerClient / File Reader │
│ Pure FFT & mapping contracts │  │ WAV Sink / GPU Capability  │
└──────────────────────────────┘  └────────────┬───────────────┘
                                              │ transferable data
                                 ┌────────────▼───────────────┐
                                 │ Worker Runtime             │
                                 │ Peaks / FFT-STFT / Exports │
                                 └────────────────────────────┘
```

- **Presentation** 只消费不可变快照并发出用户意图，不直接管理 AudioNode 或 Worker 生命周期。
- **Application** 负责任务编排、状态机、取消、进度、缓存命中与结果失效。
- **Domain** 存放无浏览器副作用的类型、校验、数学约定和纯函数。
- **Infrastructure** 封装浏览器 API。上层通过端口接口访问，便于测试替换。
- **Worker Runtime** 只接受版本化消息，不读取 React 状态，不直接操作 DOM、AudioContext 或 WebGL。

### 3.2 核心数据流

```text
File
  ├─读取/签名检查─> ArrayBuffer ─decodeAudioData─> AudioBuffer ─> RuntimeBufferRegistry
  │                                                        │
  │                                                        ├─> WebAudioEngine ─> 扬声器
  │                                                        │          └─> playback snapshot
  │                                                        ├─PCM 分块─> Peak Worker ─> Peak Pyramid ─> Canvas2D
  │                                                        ├─PCM 窗口─> FFT Worker  ─> Spectrum Frame ─> 2D 曲线
  │                                                        └─PCM 分块─> STFT Worker ─> Tiles ─┬─> 2D WebGL
  │                                                                                            └─> 3D LOD
  └─元数据──────────────────────────────────────────────────────────> ProjectStore

Selection + ExportSpec ─> PCM 分块 ─> Export Worker ─> Blob / FileSystemWritableFileStream
```

数据只有一个权威方向：音频样本决定分析数据；播放快照决定播放头；应用 store 决定视图参数。视图不得反向修改分析缓存，修改参数时生成新的 `configHash` 并使旧结果变为不可展示。

### 3.3 运行时所有权

| 资源 | 所有者 | 释放时机 |
| --- | --- | --- |
| `AudioContext` | `WebAudioEngine`（应用级单例） | 应用卸载或明确关闭引擎 |
| `AudioBuffer` | `RuntimeBufferRegistry` | 资源关闭、替换或项目清空 |
| `AudioBufferSourceNode` | 当前 playback session | 暂停、停止、跳转、结束或新 session 建立 |
| `ChannelSplitterNode` / 每声道 `GainNode` / `ChannelMergerNode` | 当前活动资源的播放路由 | 资源切换、卸载或引擎释放 |
| Worker | `WorkerPool` | 应用卸载；任务取消只取消 job，不反复销毁 Worker |
| Three.js renderer/geometry/material/texture | 对应视图实例 | 视图卸载、数据替换、context lost |
| Object URL | 导出协调器 | 下载触发后或任务取消时 `URL.revokeObjectURL` |
| IndexedDB handle | Cache repository | 应用卸载；缓存条目按 LRU 淘汰 |

## 4. 领域模型

### 4.1 核心类型

以下定义表达语义，最终代码可以拆分，但字段含义不得悄然改变。

```ts
type AssetId = string;
type JobId = string;
type SampleIndex = number; // 非负安全整数，区间统一为 [start, end)

interface AudioAsset {
  id: AssetId;
  name: string;
  source: {
    sizeBytes: number;
    mimeType: string;
    lastModified: number;
    fingerprint: string;
  };
  pcm: PcmDescriptor;
  durationSeconds: number;
  createdAt: number;
}

interface PcmDescriptor {
  sampleRate: number;
  numberOfChannels: number;
  length: SampleIndex;
  format: "f32-planar"; // AudioBuffer 的逻辑格式
}

interface SampleRange {
  start: SampleIndex;
  end: SampleIndex; // exclusive
}

interface Selection {
  assetId: AssetId;
  range: SampleRange;
}

type ChannelMode =
  | { kind: "mix" }
  | { kind: "channel"; index: number };

interface AnalysisConfig {
  fftSize: 512 | 1024 | 2048 | 4096 | 8192 | 16384 | 32768;
  window: "hann" | "hamming" | "blackman";
  overlap: 0 | 0.5 | 0.75 | 0.875;
  channelMode: ChannelMode;
  minDb: number;
  maxDb: number;
  frequencyScale: "linear" | "log";
}

interface SpectrogramManifest {
  assetId: AssetId;
  configHash: string;
  sampleRange: SampleRange;
  hopSize: number;
  frameCount: number;
  binCount: number;
  tileFrames: number;
  tiles: SpectrogramTileRef[];
}

interface SpectrogramTileRef {
  tileIndex: number;
  firstFrame: number;
  frameCount: number;
  cacheKey: string;
  encoding: "u8-db" | "f32-db";
}
```

### 4.2 持久化状态与瞬态状态

可持久化：

- 音频资源的描述信息与 fingerprint；不默认持久化原始文件内容。
- 选择区、播放位置、循环开关、音量、倍速。
- FFT 参数、视图范围、色板、3D 相机参数。
- 当前分析声道、波形/对比频谱可见声道索引、每声道 Mute/Solo、语义声道布局和频谱对比开关；索引统一使用 0-based 存储。
- 峰值金字塔、声谱瓦片、缓存版本与最近访问时间。

仅运行时：

- `File`、`ArrayBuffer`、`AudioBuffer`、AudioNode、Worker、AbortController。
- Canvas context、Three.js renderer/scene/camera/geometry/material/texture。
- 正在进行的 job、临时 PCM 分块和下载 Object URL。

页面重载后，若没有可恢复的 File System Access handle，应把资源标为 `source-missing`，保留项目参数并提示用户重新选择原文件。重新关联必须校验 fingerprint，不能仅凭文件名匹配。

### 4.3 不变量

- 所有采样范围使用半开区间 `[start, end)`，并满足 `0 <= start <= end <= pcm.length`。
- `hopSize = fftSize * (1 - overlap)` 且必须为整数。
- `minDb < maxDb <= 0`；内部分析值可低于显示下限，但量化缓存会裁剪。
- 播放位置以采样点为权威值；秒数仅用于 AudioContext 调度和 UI 展示。
- 每个分析结果都携带 `assetId + fingerprint + configHash + sampleRange`。
- job 完成时若 generation 或 configHash 已过期，结果只可丢弃或缓存，不可覆盖当前 UI。

## 5. 建议目录结构

```text
WebAudioKit/
├── docs/
│   ├── PRD.md
│   ├── TECHNICAL_DESIGN.md
│   └── adr/
├── public/
├── src/
│   ├── app/
│   │   ├── App.tsx
│   │   ├── routes/
│   │   └── providers/
│   ├── domain/
│   │   ├── audio/
│   │   ├── analysis/
│   │   ├── playback/
│   │   └── export/
│   ├── application/
│   │   ├── import/
│   │   ├── playback/
│   │   ├── analysis/
│   │   ├── export/
│   │   └── project/
│   ├── infrastructure/
│   │   ├── web-audio/
│   │   ├── workers/
│   │   ├── cache/
│   │   ├── files/
│   │   └── capabilities/
│   ├── features/
│   │   ├── import-audio/
│   │   ├── transport/
│   │   ├── waveform/
│   │   ├── spectrum/
│   │   ├── spectrogram/
│   │   ├── fft-3d/
│   │   └── export-audio/
│   ├── renderers/
│   │   ├── canvas2d/
│   │   └── webgl/
│   ├── state/
│   ├── shared/
│   ├── workers/
│   │   ├── analysis.worker.ts
│   │   ├── peaks.worker.ts
│   │   └── export.worker.ts
│   ├── styles/
│   └── test/
├── e2e/
├── package.json
└── vite.config.ts
```

约束：

- `features` 可以依赖 `application` 和 `domain`，不能直接跨 feature 读取内部状态。
- `domain` 不依赖 React、DOM、Web Audio 或 Three.js。
- Worker 入口只从共享协议与纯算法模块导入，不从 UI 导入。
- renderer 接收标准化 viewport/data snapshot；绘制代码不负责业务状态变更。

## 6. 音频导入与解码

### 6.1 导入流程

1. 用户通过文件选择器或拖放提供单个音频文件。
2. 校验文件大小、扩展名、MIME（仅作提示）及文件头签名；不完全信任浏览器提供的 MIME。
3. 生成非权威快速 fingerprint：`SHA-256(size + lastModified + first64KiB + last64KiB)`，用于缓存查找。
4. 读取为 `ArrayBuffer`，更新可取消的读取进度。
5. 在已解锁或可创建的 `AudioContext` 中调用 `decodeAudioData`。解码阶段浏览器 API 本身通常不可中断；取消表示忽略结果并尽快释放引用。
6. 校验 `sampleRate`、`numberOfChannels`、`length` 和所有 channel data 的有限性；非有限样本在构建分析数据时归零并记录告警。
7. 将 `AudioBuffer` 放入 runtime registry，立即释放编码 `ArrayBuffer` 的应用引用。
8. 启动峰值金字塔任务；首屏所需低层级优先生成，其余层级后台完成。
9. 写入项目资源描述和缓存索引，状态进入 `ready`。

### 6.2 导入状态机

```text
idle
  └─SELECT_FILE─> validating
       ├─REJECT─> error
       └─ACCEPT─> reading
            ├─CANCEL─> cancelled
            ├─READ_FAIL─> error
            └─READ_DONE─> decoding
                 ├─CANCEL─> cancelled  (底层解码可能继续，结果必须丢弃)
                 ├─DECODE_FAIL─> error
                 └─DECODE_DONE─> preparing
                      ├─PREPARE_FAIL─> error
                      ├─CANCEL─> cancelled
                      └─MINIMUM_READY─> ready
                                           └─后台继续构建 peaks/cache
```

每次导入生成 `generationId`。异步回调必须同时匹配当前 `generationId` 和资产 ID，避免取消后迟到结果污染新资源。

### 6.3 格式与错误

- WAV 作为必须覆盖的基线格式；MP3、Ogg、AAC/M4A、FLAC 仅按运行时 `decodeAudioData` 能力提供，不从扩展名推断一定可用。
- 错误对用户分为：不支持格式、文件损坏、内存不足、浏览器音频不可用、读取失败、取消。
- 底层错误对象只进入诊断日志，UI 不显示本地路径或浏览器内部堆栈。

## 7. 播放引擎与状态机

### 7.1 音频图

```text
                                      ┌─> Channel Gain 0 ─┐              ┌─> Dry Gain ───────────────┐
AudioBufferSourceNode ─> Splitter ────┼─> Channel Gain … ─┼─> Merger ───┤                              ├─> Master Gain ─> destination
                                      └─> Channel Gain N ─┘              └─> Effect chain ─> Wet Gain ┘
```

`AudioBufferSourceNode` 是一次性节点。每次播放、跳转或倍速变更均创建新 source；停止后立即断开旧节点。Splitter/Gain/Merger 路由随活动资源创建并在卸载时成对断开，source 仅接入该稳定路由。Master Gain 继续承载全局音量与静音。

每声道增益的可听规则为 `!muted[c] && (!anySolo || solo[c])`，因此 Mute 优先于 Solo。增益变化使用短线性斜坡。路由保持源索引的身份顺序；5.1 标签顺序为 `FL, FR, FC, LFE, BL, BR`，7.1 作为显式扩展追加 `SL, SR`。语义布局是项目元数据和 UI 标识，不承诺浏览器、操作系统或物理设备提供相同数量的扬声器，也不执行任意硬件端口映射。

播放图不依赖 `AnalyserNode` 生成权威 FFT，以保证实时与离线频谱使用相同窗函数和幅度标定。Mute/Solo 不回写源 PCM，也不进入分析或导出管线。

滤波选项页可在 Merger 后编译一条有序监听效果链。基础滤波编译为 BiquadFilterNode；采样器编译为 AudioWorkletNode，在输出上下文固定采样率内模拟目标采样率：下采样先以有界一阶低通抗混叠再抽取/保持，上采样依赖 Web Audio 对输入源的上下文采样率转换且不虚构超过上下文 Nyquist 的信息。Worklet 构造时预分配最多 32 声道的状态，`process()` 不执行 I/O、日志、Promise、动态导入或数组扩容；能力缺失或模块加载失败时以透明 GainNode 旁路。

干声与湿声分支同时连接到 Master Gain，A/B 试听仅对两条分支的 GainNode 做短斜坡切换，不重建 AudioBufferSourceNode。节点增删、排序、类型或参数变化时在主线程控制路径创建新链，切换连接后断开并释放旧节点；只有采样器的固定成本逐采样内核进入实时渲染回调。效果链只属于监听图，不进入原始 PCM、权威 FFT/STFT、峰值和导出管线。双声轨预览共享源时间轮廓；频谱模式对 A 使用当前位置源 STFT，对 B 叠加 BiquadFilterNode 的实际幅频响应与采样器抗混叠响应。二维声谱模式复用有界降采样后的离线源 STFT，并将相同响应逐频率 bin 叠加到 B 轨；两种 B 视图均为监听预测，不将其冒充为效果后权威 STFT。

### 7.2 播放状态

```ts
type PlaybackState =
  | { kind: "empty" }
  | { kind: "locked"; assetId: AssetId; position: SampleIndex }
  | { kind: "ready"; assetId: AssetId; position: SampleIndex }
  | {
      kind: "playing";
      assetId: AssetId;
      sessionId: string;
      anchorContextTime: number;
      anchorSample: SampleIndex;
      rate: number;
    }
  | { kind: "paused"; assetId: AssetId; position: SampleIndex }
  | { kind: "ended"; assetId: AssetId; position: SampleIndex }
  | { kind: "error"; assetId?: AssetId; message: string };
```

关键转换：

- `LOAD`：`empty -> locked|ready`，取决于 AudioContext 是否需要用户手势恢复。
- `PLAY`：`ready|paused|ended -> playing`；ended 从选区起点或 0 开始。
- `PAUSE`：计算当前采样位置，停止 source，`playing -> paused`。
- `SEEK`：任意有资源状态更新 position；若正在播放，销毁旧 source 并建立新 session。
- `STOP`：停止 source，位置回到有效选区起点，否则回到 0，进入 ready。
- `SOURCE_ENDED`：仅当 `sessionId` 匹配当前 session 时生效；循环开启则从循环起点建立新 session，否则进入 ended。
- `CONTEXT_SUSPENDED`：保留位置，进入 locked/paused；下一次用户手势调用 `resume()`。
- `UNLOAD`：停止并断开所有节点，删除 runtime buffer，进入 empty。

### 7.3 播放位置计算

播放时不靠 `setInterval` 累加位置，使用 AudioContext 单调时钟：

```text
elapsed = max(0, audioContext.currentTime - anchorContextTime)
sample = anchorSample + round(elapsed * sampleRate * playbackRate)
```

结果裁剪到播放范围。UI 通过 `requestAnimationFrame` 读取轻量 snapshot；仅播放头所在的覆盖层重绘，不让每帧位置更新触发整棵 React 树 render。

选区、跳转与循环边界最终均对齐采样点。调用 `source.start(when, offsetSeconds, durationSeconds)` 时才转换为秒；循环首版由 session 重建实现，避免浏览器 loop 边界差异影响状态机。音量由 `GainNode.gain` 在短时间内平滑过渡，避免突变爆音。

## 8. FFT/STFT 数学约定

### 8.1 输入与声道

- 输入 PCM 为 `Float32`，满刻度约定为 `[-1, 1]`，超过范围的解码样本在分析时保留、导出整数 PCM 时裁剪。
- `channel` 模式分析任意指定源声道，索引必须满足 `0 <= index < numberOfChannels`。
- `mix` 模式按声道算术平均：`x[n] = sum(x_c[n]) / C`。该策略可能因反相抵消；UI 必须明确标注“混合”，并允许切换声道。
- 波形可见声道集合只控制 Canvas 轨道，不进入 FFT 配置，也不得改变 Web Audio 播放图或 WAV 编码输入。
- 同一集合在多声道实时对比模式下选择叠加曲线；它不等同于播放 Mute/Solo。分析始终读取原始声道 PCM。

### 8.2 分帧

设 FFT 大小为 `N`，重叠率为 `r`，hop 为：

```text
H = N * (1 - r)
```

第 `m` 帧从绝对采样点 `s + mH` 开始：

```text
x_m[n] = x[s + mH + n], 0 <= n < N
```

超出分析区间或音频末尾的部分补零。只要帧起点仍小于选区终点就生成，因此非空范围帧数为：

```text
M = ceil((end - start) / H)
```

帧显示时间取窗中心：

```text
t_m = (start + mH + N/2) / sampleRate
```

在视图边界处允许中心时间略超出选区，交互命中时裁剪到有效音频范围。这样可保持分块分析和全量分析帧索引完全一致。

### 8.3 窗函数

统一采用周期型定义（分母为 `N`），`0 <= n < N`：

```text
Hann:     w[n] = 0.5 - 0.5 cos(2πn/N)
Hamming:  w[n] = 0.54 - 0.46 cos(2πn/N)
Blackman: w[n] = 0.42 - 0.5 cos(2πn/N) + 0.08 cos(4πn/N)
```

窗系数按 `(window, N)` 缓存在 Worker 中。若将来增加其他窗，必须同时记录 coherent gain、测试幅值标定，并升级分析缓存 schema。

### 8.4 DFT、频率与幅值

窗后实数 DFT：

```text
X_m[k] = Σ(n=0..N-1) x_m[n] w[n] exp(-j2πkn/N)
```

仅保留单边频谱 `0 <= k <= N/2`，bin 数为 `N/2 + 1`，频率为：

```text
f_k = k * sampleRate / N
```

定义窗 coherent gain：

```text
Cw = (1/N) Σ(n=0..N-1) w[n]
```

满刻度正弦的峰值幅度标定：

```text
A[k] = |X[k]| / (N*Cw),                k = 0 或 k = N/2
A[k] = 2|X[k]| / (N*Cw),               其他单边 bin
dBFS[k] = 20 log10(max(A[k], 1e-12))
```

显示/缓存时裁剪到配置的 `[minDb, maxDb]`。算法内部保留 `Float32 dBFS`；2D 瓦片可量化为 `Uint8`：

```text
q = round(255 * clamp((dBFS - minDb) / (maxDb - minDb), 0, 1))
```

量化缓存 key 必须包含 dB 范围。若分析库的 FFT 输出自带归一化，适配层必须还原到上述约定，不能重复缩放。

### 8.5 参数默认值

| 参数 | 默认值 |
| --- | --- |
| FFT size | 2048 |
| 窗 | Hann |
| overlap | 75%（hop = 512） |
| 频率范围 | 0 至 Nyquist |
| 频率轴 | 对数（0 Hz 单独处理，显示下限建议 20 Hz） |
| dB 范围 | -100 至 0 dBFS |
| 声道 | 默认 mix，可切换到当前资源任意 `Channel 1…N` |

## 9. 波形峰值金字塔

### 9.1 数据结构

直接逐像素扫描原始 PCM 会随缩放范围线性变慢。导入后为每声道构建 min/max 金字塔：

- Level 0：每 256 个样本记录一个 `{min, max}`。
- Level `L+1`：合并 Level `L` 相邻两个 block，`min = min(a.min,b.min)`，`max = max(a.max,b.max)`。
- 每层 block 覆盖 `256 * 2^L` 个原始样本。
- 尾块不足时按实际样本聚合，不补零，避免波形边缘被错误拉到 0。

```ts
interface PeakLevel {
  samplesPerBlock: number;
  channels: Array<{
    mins: Float32Array;
    maxs: Float32Array;
  }>;
}

interface WaveformPyramid {
  assetId: AssetId;
  sourceLength: number;
  baseBlockSize: 256;
  levels: PeakLevel[];
}
```

### 9.2 构建与查询

- Worker 分块读取 PCM，优先返回能覆盖全长的粗层级，使长文件尽快出现概览；最终缓存完整层级。
- viewport 查询选择“每个屏幕像素约 1 个 block”的最细层，绘制点数控制在 `0.5W` 至 `2W`。
- 极度放大到小于 256 samples/pixel 时直接从原始 PCM 取当前可见区绘制折线。
- min/max 不能取平均下采样，否则会丢失瞬态峰值。
- 10 分钟、48 kHz、双声道音频的 Float32 min/max 金字塔约数 MiB，远小于原始 PCM；持久化时可选择 Int16 量化，但首版优先保证精度与实现简单。

## 10. 实时与离线分析

### 10.1 实时频谱

文件播放场景的实时 FFT 不在音频渲染线程执行。播放控制器以 15–30 Hz 发布当前采样位置，分析协调器：

1. 以当前位置为窗中心计算所需 `[start, start + N)`。
2. 从 `AudioBuffer` 复制最多 `N * channels` 个样本到可转移的小型 `Float32Array`。
3. 单曲线模式向 FFT Worker 提交一个 frame；多声道对比模式在同一 `analyze-channels` job 中提交可见源声道索引，不为每条曲线创建独立 Worker。
4. Worker 对所选声道复用同一窗位置、FFT 参数、时间轴与频率轴，按请求顺序返回 `{ channelIndex, preview }`；声道间和 STFT batch 间检查取消。
5. Worker 返回 dBFS frame；generation 已变化或迟于新播放位置的结果不展示。单声道与多声道请求共享同一 analysis generation，模式切换会使前一请求失效。
6. 暂停时保留最后一帧；seek 后立即请求新帧。

这种“最新值优先”背压会主动丢帧，但不会堆积任务，也不会阻塞播放。后续接入麦克风时再使用 AudioWorklet 将小块 PCM 写入 ring buffer；不得在 AudioWorklet 中做大型 FFT、分配大量对象或访问 IndexedDB。

### 10.2 离线 STFT

- 协调器按固定 frame tile 拆分，例如每 tile 256 帧。
- 对 tile `i`，明确传入 `firstFrame`、`frameCount` 和覆盖这些窗所需的 PCM 范围；Worker 按绝对帧号计算，避免 chunk 边界重复或缺帧。
- 每完成一个 tile 就返回量化矩阵与统计信息，UI 可渐进展示，缓存可逐 tile 写入。
- 调度并发数默认为 `max(1, min(2, hardwareConcurrency - 1))`；在低内存设备上固定为 1。
- 任务支持取消。Worker 在每帧或小批帧边界检查 cancelled set；主线程不再发送后续 tile。
- 完成顺序可以乱序，manifest 按 `tileIndex` 排列。只有全部必需 tile 完成时 job 状态才为 complete。

### 10.3 配置散列

`configHash` 由规范化 JSON 计算，至少包含：算法 schema、FFT size、hop、窗、声道策略、采样率、dB 量化范围和分析区间对齐规则。对象 key 必须稳定排序。纯显示参数（如色板、相机角度）不进入 STFT hash；会改变数据抽样的参数必须进入对应 LOD hash。

## 11. 2D 渲染

### 11.1 波形 Canvas 2D

- 背景/网格、波形主体、选择区、播放头分层绘制；静态层缓存到离屏 canvas，播放时只重绘覆盖层。
- 导入时为全部源声道生成峰值层；渲染时仅遍历 `visibleChannels`，默认 `[0, 1]`（单声道为 `[0]`）。
- 每条可见轨道保留最小高度；总高度超出宿主时使用纵向滚动，轨道标签显示源声道编号而非可见顺序。
- Canvas backing size 为 CSS 尺寸乘 DPR，DPR 默认封顶 2，防止 4K 高 DPR 设备产生过大缓冲。
- 时间到像素的变换集中为 `ViewportTransform`；鼠标事件先从 CSS pixel 转到时间，再对齐采样点。
- wheel 缩放以指针时间为锚点；拖动平移；选择区 handle 有最小命中宽度。
- 绘制由 dirty flag 驱动，不在每次 React render 中无条件清空 canvas。

### 11.2 声谱图

首选 WebGL2：

- 每个 STFT tile 上传为单通道 8-bit 纹理，fragment shader 查色板纹理得到颜色。
- 时间轴映射到纹理列；线性频率直接映射行，对数频率在 shader 中反算 bin。
- 多 tile 只上传/保留当前 viewport 附近数据，使用 LRU 释放 GPU texture。
- 纹理尺寸受 `MAX_TEXTURE_SIZE` 限制；任何实现都不能假定完整声谱可放进一张纹理。
- 时间缩小时使用预计算或 shader 聚合的 LOD，避免大量列映射到同一像素造成闪烁。

Canvas 2D 降级：

- 把 `Uint8` tile 经色板映射为 `ImageData`，缓存成 `ImageBitmap`（可用时）或离屏 canvas。
- 不支持平滑插值时按最近邻绘制；坐标轴、游标与选择区仍由 Canvas 覆盖层负责。
- WebGL2 不可用时保留声谱图浏览，但隐藏 3D 入口并解释原因。

## 12. FFT 3D 渲染

Three.js 视图使用同一 SpectrogramManifest 的 LOD 数据：

- X：时间，归一化到当前分析范围。
- Z：频率；线性或对数映射与 2D 视图一致。
- Y：`clamp((dBFS - minDb)/(maxDb - minDb), 0, 1)`，再乘用户可调高度比例。
- 颜色：复用 2D 色板，依据 dBFS 查色。

质量档位建议：

| 档位 | 最大时间采样 | 最大频率采样 | 目标用途 |
| --- | ---: | ---: | --- |
| 低 | 128 | 128 | 集显、拖动相机 |
| 中 | 256 | 256 | 默认预览 |
| 高 | 384 | 384 | 静止观察，设备能力允许时 |

曲面模式使用 indexed `BufferGeometry`，线框和瀑布模式复用抽样结果，避免生成每个原始 STFT 点的对象。相机交互时可临时降到低档，停止交互后恢复目标档位。

必须实现：

- ResizeObserver 驱动画布与相机宽高比更新。
- `webglcontextlost` 时停止绘制并提示，`webglcontextrestored` 后从缓存重建 GPU 资源。
- 替换数据和卸载时显式调用 geometry、material、texture、renderer 的 `dispose()`。
- 帧循环仅在播放、相机交互、数据更新或动画进行时运行；静止时按需渲染。
- 自动降级：连续帧率低于 24 FPS 时降低 LOD/DPR；恢复需滞后阈值，避免档位抖动。

## 13. Worker 协议

### 13.1 消息信封

```ts
const WORKER_PROTOCOL_VERSION = 2;

interface WorkerRequest<TType extends string, TPayload> {
  protocolVersion: 2;
  requestId: string;
  jobId: JobId;
  type: TType;
  payload: TPayload;
}

type WorkerResponse<T> =
  | { protocolVersion: 2; requestId: string; jobId: JobId; type: "accepted" }
  | { protocolVersion: 2; requestId: string; jobId: JobId; type: "progress"; completed: number; total: number }
  | { protocolVersion: 2; requestId: string; jobId: JobId; type: "result"; payload: T }
  | { protocolVersion: 2; requestId: string; jobId: JobId; type: "cancelled" }
  | {
      protocolVersion: 2;
      requestId: string;
      jobId: JobId;
      type: "error";
      error: { code: string; message: string; retryable: boolean };
    };
```

### 13.2 命令集合

| 命令 | 主要 payload | 结果 |
| --- | --- | --- |
| `peaks/build` | asset、绝对 chunk 起点、channel buffers、base block size | 一个或多个 peak level chunk |
| `fft/frame` | sampleRate、FFT config、窗口 PCM | `Float32Array` dBFS bins |
| `analyze-channels` | 同步窗口 PCM、源声道索引数组、共享 FFT config | 有序 `{ channelIndex, preview }[]` |
| `stft/tile` | firstFrame、frameCount、绝对范围 PCM、FFT config | `Uint8Array`/`Float32Array` tile |
| `lod/build` | tile refs 或矩阵、目标 time/frequency size、聚合策略 | 3D LOD 矩阵 |
| `wav/encode-chunk` | format、channels、sample range、PCM chunk、dither seed | WAV data chunk/统计 |
| `csv/encode-chunk` | frame offset、频率 bins、dB matrix | UTF-8 CSV bytes |
| `job/cancel` | target jobId | cancelled acknowledgement |

协议要求：

- 大数组通过 Transferable `ArrayBuffer` 传递；发送方在 transfer 后不得继续读取。
- 一个 request 恰好一个终态：result、cancelled 或 error。progress 不算终态。
- 错误必须是可结构化克隆的普通对象，不直接发送 `Error` 实例。
- Worker 校验 protocolVersion、数组长度、FFT 参数和内存上限；错误输入不能使 Worker 无限循环或分配无界内存。
- 主线程维护超时与 Worker 崩溃恢复；幂等 tile 可以重试一次，导出写入类任务默认不自动重试。
- 取消采用协作式检查；即使 Worker 返回 result，主线程仍以 generation/configHash 做最终防线。

## 14. 导出

### 14.1 WAV

MVP 支持：全文件或选区、PCM16、PCM24、IEEE Float32，保持源采样率和声道数。选择边界直接使用 `[startSample, endSample)`，期望导出帧数严格等于 `end - start`。

编码规则：

- RIFF/WAVE、小端序；PCM16/24 使用 format tag 1，Float32 使用 tag 3。
- 多声道按 sample frame 交错写入。
- 整数 PCM 对输入裁剪到 `[-1, 1]`，正负端点映射需避免 `+1` 溢出。
- PCM16/24 默认可启用 TPDF dither；随机种子写入 job 参数，使测试可复现。
- “归一化”需要先扫描选区峰值，再进行第二遍编码；峰值为 0 时增益保持 1。
- RIFF data chunk 超过 4 GiB 时首版拒绝并给出明确错误；后续以 RF64 或流式外部编码扩展。
- 先按参数估算输出大小并检查资源预算，不能编码完成后才发现超限。

支持 File System Access API 时可选择分块写入用户文件；否则收集适度大小的 Blob parts 并创建下载。两条路径输出字节必须由同一 encoder 生成。

### 14.2 CSV

频谱 CSV 每行表示一个时间/频率点：

```csv
time_seconds,frame_index,frequency_hz,bin_index,magnitude_dbfs
0.021333333,0,0,0,-87.231
```

- UTF-8、逗号分隔、小数点固定为 `.`、换行固定为 `\n`。
- 数字精度：时间 9 位小数、频率 6 位小数、dB 3 位小数；避免无意义的完整浮点字符串膨胀。
- CSV 可能远大于声谱缓存，导出前显示估算行数与大小；超过阈值建议缩小选区或降低时间/频率采样。
- Worker 分 tile 生成 UTF-8 bytes，协调器按 frame 顺序写出；乱序计算结果需先排序。
- 文件名、资源名等文本元数据不进入数值行，避免表格公式注入；未来若增加 metadata，必须按 RFC 风格引用并对 `= + - @` 起始值做安全处理。

## 15. 缓存与项目恢复

### 15.1 IndexedDB stores

| Store | Key | Value |
| --- | --- | --- |
| `projects` | projectId | 可序列化项目状态、schemaVersion、updatedAt |
| `assets` | fingerprint | AudioAsset 描述、关联状态、lastAccessed |
| `peaks` | fingerprint + peakSchema + level + channel | typed array blob、范围、校验信息 |
| `spectrogramTiles` | fingerprint + configHash + tileIndex | 量化 tile、尺寸、lastAccessed |
| `cacheIndex` | cacheKey | sizeBytes、kind、lastAccessed、version |

当前 recent-workspace schema 为 v3，使用 `"mix" | number` 保存分析声道，并保存去重、升序的 `visibleChannels`、`mutedChannels`、`soloChannels`，以及兼容当前声道数的 `channelLayout` 和全局 `spectrumComparison`。读取 v1 时将 `left/right` 迁移为 `0/1`，读取 v2 时保留分析与可见声道，随后统一回写 v3。重新关联源文件后再次校验所有索引和布局；不兼容设置回退到安全默认值。

### 15.2 策略

- 缓存是派生数据，不是用户唯一数据；任何迁移失败都可删除并重建。
- 启动时通过 `navigator.storage.estimate()` 获取可用信息；不可用时采用保守默认上限。
- 默认缓存上限取可用 quota 的 20%，并设置应用级上限；先淘汰声谱 tile，再淘汰 peaks，当前打开资源最后淘汰。
- 每次访问不立即单独写 lastAccessed，可批量节流更新，减少事务放大。
- schema 或算法版本变化时用命名空间隔离旧 key，后台 LRU 清理，不在启动路径遍历整个数据库。
- 写入必须以完整 tile/level 为原子单位；中断的 manifest 不标记 complete。
- fingerprint 只用于非权威缓存。重新关联原文件时同时比较 size、mtime、解码后的 sampleRate/channels/length；冲突时重建。
- 可选持久化 File System Access handle，但恢复前必须重新请求/确认权限，不能把权限存在视为永久授权。

## 16. 性能预算

基准场景为 10 分钟、48 kHz、双声道音频；原始 Float32 PCM 约 `600 * 48000 * 2 * 4 = 230.4 MB`。

| 指标 | 目标 |
| --- | --- |
| 播放控制响应 | 用户手势到状态反馈 < 100 ms；音频启动受浏览器调度影响但不等待分析 |
| 主线程长任务 | 交互期间单任务尽量 < 8 ms，不允许连续 > 50 ms 任务 |
| 波形交互 | 目标 50–60 FPS |
| 3D 默认质量 | 目标 >= 30 FPS，低于 24 FPS 自动降级 |
| 播放头跨视图误差 | <= 50 ms |
| 实时 FFT | 15–30 次/秒，永不排队超过“运行中 + 最新待处理”两项 |
| 参数更新 | 200 ms 内开始呈现缓存或新计算的首批结果 |
| Worker 进度 | 每 100 ms 至 250 ms 最多一次，避免消息风暴 |
| GPU 常驻声谱纹理 | 当前 viewport 邻近 tile，软上限 128 MiB |
| WAV 选区长度 | 与目标范围相差 0 sample |

实现手段：

- PCM 传 Worker 时按任务切片，禁止把完整 AudioBuffer 为每个 Worker 复制一份。
- STFT tile 以 128–512 帧为自适应范围，单条消息目标不超过 8–16 MiB。
- React store 使用 selector，播放头走外部 snapshot/imperative overlay，避免 60 Hz 全局状态更新。
- resize、wheel、pointer move 做帧级合并；不对播放 tick 使用普通 debounce。
- 绘制前按 viewport 选 LOD；GPU 与 Canvas 都不处理肉眼不可见的全量点。
- 用 Performance API 标记 import、first waveform、analysis first tile、analysis complete、export 阶段。

## 17. 大文件策略

MVP 使用 `decodeAudioData`，意味着压缩数据与完整解码 PCM 会在某一时刻同时驻留内存。这是明确限制，不宣称支持任意长度文件。

### 17.1 内存预算

已知元数据时估算：

```text
pcmBytes = durationSeconds * sampleRate * channels * 4
workingSet ≈ pcmBytes + encodedBytes + peakBytes + visibleTiles + transientChunkBytes
```

运行时预算建议：

- 若 `navigator.deviceMemory` 可用，PCM 软预算取设备内存的约 15%，并裁剪到 256–768 MiB。
- 不可用时默认 PCM 软预算 384 MiB。
- 超过软预算时先告警并要求用户确认，默认关闭自动全文件 STFT 和高质量 3D。
- 预计工作集超过 1 GiB 时 MVP 拒绝解码，避免页面或浏览器进程崩溃；阈值应可通过经过评审的配置调整，而不是散落在组件中。
- 当前 Worker 输入仍可能产生 PCM 副本，因此实现暂将工作区常驻解码 PCM 总硬上限设为 512 MiB，并按“已有常驻 PCM + 当前任务副本 + 输出”校验 1 GiB 工作集硬门；单文件导入按 `encodedBytes + 2 * decodedPcmBytes` 做解码后的二次校验。后续分块协议落地后再重新评估该上限。
- 解码前先用编码文件大小和工作区剩余预算执行可得的保守预检；压缩格式无法在解码前可靠推断 PCM，仍需在 `decodeAudioData` 返回后立即二次校验并释放被拒绝结果。
- 峰值金字塔按源声道串行传输并合并，指定声道 FFT 只复制目标声道，选区 WAV 只复制选区 PCM；`mix` FFT 与全文件 WAV 在当前协议下仍受上述工作集硬门保护。

某些压缩格式在解码前无法可靠获得时长。此时先根据编码文件大小作粗略预警，解码完成后立刻按真实 PCM 大小重新评估。取消后清空所有大对象引用，让 GC 有机会回收，但 UI 不承诺瞬时归还进程内存。

### 17.2 降级处理

- 峰值先粗后细，确保大文件仍能快速显示概览。
- STFT 只分析当前选择区；全文件分析必须显式触发并展示预计时间/缓存大小。
- 频谱始终 tile 化，分析一块、显示一块、缓存一块。
- 3D 只消费下采样 LOD，不构建全分辨率 geometry。
- 导出使用 PCM 分块；支持文件流写入时不聚合完整输出 Blob。
- 后续若要突破限制，新增 WebCodecs/WASM 流式解码器与 PCM chunk store；该演进不能改变 SampleIndex、STFT 帧对齐和 Worker 协议的核心语义。

## 18. 兼容性与降级

启动时形成 `CapabilityReport`，UI 只暴露可用能力：

| 能力缺失/限制 | 行为 |
| --- | --- |
| AudioContext 需用户手势 | 状态为 locked；点击播放时 `resume()`，不自动循环弹错 |
| 某音频格式不可解码 | 拒绝该文件，保留应用其他功能，提示转为 WAV |
| WebGL2 不可用 | 波形和 Canvas 2D 声谱保留；隐藏/禁用 3D |
| WebGL context lost | 暂停 3D，显示恢复状态；恢复后从缓存重建 |
| OffscreenCanvas 不可用 | 主线程 Canvas 2D 绘制，仍使用 Worker 计算 |
| File System Access 不可用 | 使用 `<input>` 导入与 Blob 下载 |
| SharedArrayBuffer 不可用 | 使用 Transferable 分块；MVP 不把 SAB 作为必需条件 |
| 存储 quota 不足/IndexedDB 失败 | 进入无持久缓存模式，当前会话仍可播放与分析 |
| `navigator.deviceMemory` 不可用 | 使用保守固定预算 |

浏览器验证以当前主流 Chromium、Firefox、Safari 的稳定版本为目标；具体支持矩阵由 CI/发布测试维护。格式兼容能力必须运行时验证，不以浏览器品牌硬编码。

## 19. 安全与隐私

- 默认所有音频、PCM、分析和导出均在本地浏览器完成，不发起音频内容网络请求。
- 首次界面明确说明本地处理；若未来增加云能力，必须单独征得授权并提供传输范围说明。
- 生产环境设置严格 CSP；不使用 `eval`、动态执行用户文本或从不可信 URL 加载 shader/worker。
- 文件名和元数据只按文本节点渲染，不使用 `innerHTML`。
- 文件签名、尺寸、声道数、采样率、样本长度和所有 Worker 数组长度均做上限校验，以降低畸形文件导致资源耗尽的风险。
- Object URL 用后撤销；File handle 不上传、不写日志；诊断日志不包含本地路径或原始 PCM。
- Worker 与主线程边界仍视为不可信输入边界，双方都做参数校验。
- 依赖定期审计，Three.js、构建工具和解析相关依赖升级需跑视觉与性能回归。
- 如启用 SharedArrayBuffer 所需的跨源隔离头，应评估对第三方资源与嵌入场景的影响；MVP 不为它牺牲部署兼容性。

## 20. 测试策略

### 20.1 单元与数值测试

- SampleIndex/秒/像素变换、边界裁剪、选区半开区间。
- 导入和播放状态机的所有合法转换、非法事件和迟到 session 事件。
- 窗函数系数与 coherent gain。
- FFT：DC、Nyquist、bin 对齐 1 kHz 正弦、非 bin 对齐信号、静音、脉冲、白噪声。
- 幅值：满刻度 bin 对齐正弦在非 DC bin 接近 0 dBFS，容差 ±0.1 dB；端到端显示验收可放宽到 ±1 dB。
- 频率峰值误差不超过一个 FFT bin。
- STFT 全量与 tile 分块输出逐帧一致；末尾补零和短于一个窗的选择区有结果。
- peak pyramid 每层 min/max 包含原始样本极值，尾 block 不引入虚假 0。
- WAV header、chunk size、交错顺序、PCM16/24/Float32 边界和选区长度。
- CSV 行数、顺序、精度、换行和大任务取消。
- configHash 稳定排序、schema 变化与缓存失效。

测试音频优先在测试中确定性生成，不提交大体积媒体：正弦、双音、chirp、脉冲、静音、左右声道不同频率、反相立体声。少量格式兼容 fixture 可控制在仓库允许的体积内。

### 20.2 组件与集成测试

- 拖放/选择文件、错误提示、进度、取消和重新导入。
- 播放、暂停、seek、stop、倍速、循环以及 AudioContext locked 恢复。
- 波形缩放、平移、选择区拖动与三视图联动。
- 参数快速连续修改时旧 job 不覆盖新结果。
- IndexedDB 命中、quota 失败、schema 升级后的无缓存降级。
- Worker 崩溃、超时、取消和幂等 tile 重试。
- WebGL2 缺失/context lost 的 2D 降级。

Web Audio 集成可用 `OfflineAudioContext` 验证音频图；状态机单测使用可控时钟和 fake engine，避免以真实 wall clock 写脆弱测试。

### 20.3 E2E 与性能测试

- Playwright 覆盖至少 Chromium，并在发布前人工/CI 覆盖 Firefox、WebKit。
- 使用固定生成音频执行“导入 → 波形 → 播放 → STFT → 3D → WAV/CSV 导出”主路径。
- 导出 WAV 重新解码，校验采样率、声道、帧数和抽样误差。
- 基准文件记录峰值内存近似值、first waveform、first spectrum tile、完整 STFT 耗时与交互 FPS。
- 性能断言以独立基准任务运行，避免共享 CI 噪声导致普通单测不稳定。

## 21. 可观测性与错误恢复

- 开发模式提供诊断面板：capability report、当前 AudioContext 状态、Worker job、缓存用量、GPU 信息、帧率和关键计时。
- 统一错误码前缀：`IMPORT_*`、`AUDIO_*`、`ANALYSIS_*`、`EXPORT_*`、`CACHE_*`、`GPU_*`。
- 用户可重试的任务保留参数；OOM、格式不支持等不可盲目重试。
- 错误边界只保护 UI；AudioNode、Worker job 和 GPU 资源仍由应用协调器在 finally/dispose 中清理。
- 不采集用户音频或文件名遥测。若未来加入匿名性能遥测，需默认关闭或明确披露，并只记录聚合数值。

## 22. 主要风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `decodeAudioData` 需要完整文件且格式支持不一致 | 大文件 OOM、部分文件无法导入 | 内存预算、运行时能力检测、WAV 基线、后续流式解码 ADR |
| Worker 复制 PCM 造成内存翻倍 | 页面崩溃 | 只发送窗口/tile 所需分块并 transfer，限制并发与消息大小 |
| STFT 数据量远超原 PCM | 缓存与 GPU 爆炸 | Uint8 量化、tile、LOD、选区优先、LRU |
| 实时频谱任务积压 | 延迟持续上升 | 最新值优先背压，最多一运行一待处理 |
| AudioContext 自动播放限制 | 首次播放无声 | locked 状态与明确用户手势恢复 |
| source `onended` 迟到 | seek/stop 后状态倒退 | sessionId 校验 |
| 2D/3D 数学定义漂移 | 同一点读数不一致 | 共用 config、bin 映射、色板和数值 golden test |
| WebGL context 丢失或低端 GPU 性能差 | 3D 黑屏/卡顿 | context 恢复、动态 LOD、Canvas 2D 降级 |
| 浏览器存储清理或 quota 不足 | 缓存丢失 | 缓存可重建、无缓存模式、项目不依赖缓存正确性 |
| WAV/CSV 输出过大 | 内存高、下载失败 | 预估大小、流式写入（可用时）、阈值与明确拒绝 |
| 高频 React 状态更新 | 主线程掉帧 | 外部播放 snapshot、selector、imperative overlay |

## 23. ADR 决策记录

以下为初始决策摘要。影响边界或存在重要替代方案的变更，应在 `docs/adr/` 新增独立记录，并在这里链接。

### ADR-001：MVP 使用 `decodeAudioData` 全量解码

- **状态**：Accepted
- **决定**：用 Web Audio 原生解码建立 `AudioBuffer` 作为会话 PCM 权威源。
- **原因**：实现路径短，播放与随机访问稳定，足以验证完整工作流。
- **代价**：格式依浏览器，无法真正流式处理超长文件，必须执行内存预算。
- **演进**：后续可增加 WebCodecs/WASM adapter，但不改变领域层 SampleIndex 与 PCM chunk 接口。

### ADR-002：整数采样点是时间边界的唯一权威表示

- **状态**：Accepted
- **决定**：选择、循环、分析和导出范围使用 `[startSample, endSample)`。
- **原因**：避免浮点累计误差，保证导出长度和跨视图同步可验证。
- **代价**：所有 UI 秒数输入都需显式转换与裁剪。

### ADR-003：权威 FFT/STFT 在 Worker 中统一计算

- **状态**：Accepted
- **决定**：不以 `AnalyserNode` 输出作为可导出或跨视图对齐的分析结果。
- **原因**：统一窗、重叠、幅值校准和离线结果；重计算离开主线程和音频线程。
- **代价**：实时频谱需复制小窗口 PCM，麦克风输入以后另做采集通道。

### ADR-004：波形使用 min/max 多分辨率金字塔

- **状态**：Accepted
- **决定**：以 256 samples 为基础 block，逐层 2:1 聚合。
- **原因**：任意缩放下查询复杂度接近屏幕宽度，同时保存瞬态峰值。
- **代价**：导入后有后台预处理和少量缓存开销。

### ADR-005：3D 使用 Three.js，2D 保留 Canvas 降级

- **状态**：Accepted
- **决定**：Three.js 管理 WebGL2 3D 资源与交互；Canvas 2D 保证核心分析可用。
- **原因**：降低 3D 相机、几何、shader 和兼容维护成本，同时明确无 WebGL2 时的产品行为。
- **代价**：增加依赖体积，必须显式 dispose 并做性能回归。

### ADR-006：音频实时渲染线程不承担重型分析

- **状态**：Accepted
- **决定**：MVP 不使用 AudioWorklet 执行 FFT/STFT；Worklet 仅负责采集/ring buffer 或采样率转换等固定成本、预分配的流式工作。
- **原因**：避免分配、GC 或重计算导致音频 underrun。
- **代价**：文件实时频谱以播放位置采样，不能代表未来任意效果链的最终输出。

### ADR-007：序列化 store 与运行时资源注册表分离

- **状态**：Accepted
- **决定**：项目 store 只存数据；AudioBuffer、AudioNode、Worker 和 GPU 对象由专用 service 持有。
- **原因**：状态可恢复、易测试，避免响应式代理或持久化误处理大型对象。
- **代价**：需要通过 assetId 解析运行时资源，并处理 source-missing 状态。

### ADR-008：频谱结果使用 tile + 派生缓存

- **状态**：Accepted
- **决定**：STFT 渐进生成固定帧数 tile，默认以 `Uint8` dB 量化缓存。
- **原因**：限制单任务内存、支持渐进渲染和局部重算。
- **代价**：缓存依赖 dB 范围，精确 CSV 如需 Float32 必须保留/重算高精度结果。

### ADR-009：首版只保证 WAV 音频导出

- **状态**：Accepted
- **决定**：提供 PCM16、PCM24 和 Float32 WAV；压缩编码不进入 MVP。
- **原因**：浏览器编码与封装支持不一致，WAV 可本地、确定性实现并精确验证。
- **代价**：文件较大，用户需要外部工具转码。

### ADR-010：缓存不是项目正确性的依赖

- **状态**：Accepted
- **决定**：IndexedDB 中的峰值和声谱始终视为可丢弃派生物。
- **原因**：浏览器可能清理存储，schema/算法也会演进。
- **代价**：缓存丢失后需要重新分析；UI 必须表达重建进度。

### ADR-011：基础滤波使用非破坏式监听分支

- **状态**：Accepted
- **记录**：[`docs/adr/011-non-destructive-filter-audition.md`](adr/011-non-destructive-filter-audition.md)
- **决定**：在多声道合并后编译串行 BiquadFilter 链，以干/湿双分支提供原音与滤波结果 A/B 试听。
- **原因**：允许快速比较不同滤波设置，同时保持源 PCM、分析与导出语义不变。
- **代价**：首版只提供串行基础滤波，不提供任意图拓扑、离线处理或效果后分析。

### ADR-012：采样率转换只模拟非破坏式监听效果

- **状态**：Accepted
- **记录**：[`docs/adr/012-realtime-resampler-node.md`](adr/012-realtime-resampler-node.md)
- **决定**：采样器节点在 AudioWorklet 内执行固定成本的抗混叠与抽取/保持，并始终输出 AudioContext 的固定采样率。
- **原因**：Web Audio 中间节点不能改变上下文输出采样率；监听效果仍需保持播放时长、源 PCM 和导出语义不变。
- **代价**：上采样不产生超过上下文 Nyquist 的新信息，且该节点不是离线高质量重采样或导出重采样功能。

## 24. 实施顺序与技术验收门

1. **基础设施门**：严格 TypeScript、测试框架、Worker typed protocol、CapabilityReport 和资源 dispose 约定就绪。
2. **播放纵切门**：WAV 导入、AudioBuffer registry、状态机、播放/暂停/seek/stop 可测试，播放不依赖任何分析任务。
3. **波形门**：peak pyramid Worker、缩放/平移/选区完成；10 分钟基准文件交互达到预算。
4. **分析门**：统一 FFT 数值用例通过，实时 frame 与离线 STFT 共享实现，tile 可取消且不会被旧结果覆盖。
5. **可视化门**：2D WebGL/Canvas 降级与 Three.js 3D LOD 完成，context lost 和 dispose 有测试或可重复手工验证步骤。
6. **导出门**：WAV 重新解码校验长度/格式，CSV 大小预估与分块输出可用。
7. **发布门**：兼容矩阵、隐私说明、内存阈值、错误恢复、性能基准和缓存降级全部验收。

每个阶段都必须保持已有纵向工作流可运行，不以“后续统一重构”为由绕过状态机、取消或资源释放。
