# ADR-011：基础滤波使用非破坏式监听分支

- 状态：Accepted
- 日期：2026-08-07

## 背景

用户需要在独立选项页配置不同滤波器，并在不中断播放的情况下比较滤波前后的听感。现有播放图在源声道完成 Mute/Solo 后合并到 Master Gain，波形、FFT/STFT 和导出始终读取不可变源 PCM。

## 决策

在 ChannelMergerNode 后增加可选的监听分支：

```text
Merger ─┬─> Dry Gain ──────────────────┐
        └─> BiquadFilter serial chain ─> Wet Gain ─> Master Gain
```

- 节点编辑器生成有序、最多 16 个节点的声明式配置；旁路节点不进入编译后的运行图。
- 运行图使用浏览器原生 BiquadFilterNode，支持低通、高通、带通、陷波、峰值、低架、高架和全通。
- A/B 切换仅对 Dry/Wet GainNode 使用短线性斜坡，不销毁或重启当前 AudioBufferSourceNode。
- 新图准备完成后再替换 Merger 输出连接；替换或释放时显式 disconnect 所有旧滤波器和增益节点。
- 滤波链只影响扬声器监听。实时/离线频谱、声谱、3D、波形和 WAV/CSV/JSON 导出继续使用源 PCM。

## 结果

优点：

- 播放位置和选择区在 A/B 切换时保持稳定。
- 监听效果与权威分析、导出边界清晰，不会误把试听处理写回源数据。
- 声道 Mute/Solo 在滤波前完成，滤波链自然保持当前多声道布局。

限制：

- 首版只支持串行链，不支持分支、反馈、任意节点连线或参数自动化。
- 首版不生成滤波后离线分析或处理后 WAV；若未来增加，必须使用独立 Worker/OfflineAudioContext 管线和显式导出选项。
