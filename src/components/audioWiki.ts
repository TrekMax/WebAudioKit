import type { FilterKind } from '../audio/filterGraph'

export type AudioConceptVisualKind =
  | 'iir-flow'
  | 'nyquist'
  | 'cubic-interpolation'
  | 'windowed-sinc'
  | 'envelope'
  | 'q-bandwidth'
  | 'dbfs'
  | 'fft-stft'

export interface AudioKnowledgeConcept {
  readonly id: string
  readonly title: string
  readonly englishTitle: string
  readonly introduction: string
  readonly keyPoint: string
  readonly visualKind: AudioConceptVisualKind
  readonly visualSummary: string
  readonly relatedTopics: readonly string[]
}

export interface AudioWikiSection {
  readonly id: string
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly types: readonly FilterKind[]
}

export const AUDIO_KNOWLEDGE_CONCEPTS: readonly AudioKnowledgeConcept[] = [
  {
    id: 'iir-filter',
    title: 'IIR 滤波器',
    englishTitle: 'INFINITE IMPULSE RESPONSE',
    introduction: 'IIR 会把过去的输出反馈到当前计算，因此一个很短的滤波结构也能形成持续衰减的响应。Web Audio 的 BiquadFilterNode 就是常用的二阶 IIR。',
    keyPoint: '计算成本低、适合实时处理；反馈系数决定频率响应与稳定性，相位通常不是线性的。',
    visualKind: 'iir-flow',
    visualSummary: '输入经过前向系数，同时由延迟后的输出反馈；反馈令脉冲响应理论上可以无限延续。',
    relatedTopics: ['Biquad', '低通 / 高通', 'EQ', '相位'],
  },
  {
    id: 'nyquist-theorem',
    title: '奈奎斯特采样定理',
    englishTitle: 'NYQUIST–SHANNON THEOREM',
    introduction: '理想条件下，要无失真重建最高频率为 fmax 的带限信号，采样率 fs 必须大于 2 × fmax；fs / 2 称为奈奎斯特频率。',
    keyPoint: '超过 fs / 2 的内容会折叠成混叠，降采样前必须先低通抗混叠；提高采样率不能找回已经丢失的高频。',
    visualKind: 'nyquist',
    visualSummary: '奈奎斯特频率把可表示频带与混叠区域分开，越界频率会镜像折返到较低频率。',
    relatedTopics: ['采样器', '抗混叠', '采样率', '低通'],
  },
  {
    id: 'cubic-interpolation',
    title: '三次平滑',
    englishTitle: 'CUBIC CATMULL–ROM RECONSTRUCTION',
    introduction: '三次平滑使用相邻四个离散采样点构造三次曲线。本项目采用 Catmull–Rom 插值，让曲线经过中间两个样本，并用前后样本估计切线方向。',
    keyPoint: '它比线性插值更连续、通常能保留更多瞬态和高频，但不是带限算法；陡峭边缘可能过冲，并引入约两个目标采样间隔的因果延迟。',
    visualKind: 'cubic-interpolation',
    visualSummary: '虚线表示两点间的线性连接，实线利用四个相邻样本形成更连续的三次重建曲线。',
    relatedTopics: ['采样器', '线性插值', 'Catmull–Rom', '过冲', '因果延迟'],
  },
  {
    id: 'windowed-sinc',
    title: '带限重建',
    englishTitle: 'WINDOWED-SINC RECONSTRUCTION',
    introduction: '理想带限重建用 sinc 核对多个离散样本加权求和。实际实时系统会对无限延伸的 sinc 截断并加窗，本项目使用 128 个分数相位与 16 抽头 Lanczos 窗。',
    keyPoint: '它的通带更平直、镜像抑制优于低阶插值，但乘加成本最高，也可能出现前后振铃；当前固定因果实现会延迟约八个目标采样间隔。',
    visualKind: 'windowed-sinc',
    visualSummary: '有限窗口保留 sinc 中心主瓣和逐渐衰减的旁瓣，16 个抽头共同计算一个重建样本。',
    relatedTopics: ['采样器', '奈奎斯特定理', '抗混叠', 'FIR', '窗函数'],
  },
  {
    id: 'amplitude-envelope',
    title: '振幅包络',
    englishTitle: 'AMPLITUDE ENVELOPE',
    introduction: '包络描述声音振幅随时间变化的外轮廓，而不是快速振荡的逐采样波形。它决定声音起音、延续和消失的动态形态。',
    keyPoint: 'ADSR 是常见的控制模型；分析真实音频时通常用整流、RMS 或低通平滑提取包络，并用攻击与释放时间控制响应速度。',
    visualKind: 'envelope',
    visualSummary: '攻击、衰减、保持与释放四个阶段共同描述一次声音事件的宏观振幅变化。',
    relatedTopics: ['波形', 'ADSR', '动态处理', '响度'],
  },
  {
    id: 'q-bandwidth',
    title: 'Q 值与带宽',
    englishTitle: 'QUALITY FACTOR & BANDWIDTH',
    introduction: 'Q 值描述中心频率附近响应的集中程度。对常见带通或峰值滤波器，可近似理解为 Q = 中心频率 f0 ÷ 带宽 Δf。',
    keyPoint: 'Q 越高，影响范围越窄且中心附近越尖锐；Q 越低，处理范围越宽，音色变化通常更平缓。',
    visualKind: 'q-bandwidth',
    visualSummary: '三条曲线共享中心频率，但不同 Q 值形成由宽到窄的响应范围。',
    relatedTopics: ['峰值', '带通', '陷波', '共振'],
  },
  {
    id: 'dbfs-level',
    title: 'dBFS 数字电平',
    englishTitle: 'DECIBELS RELATIVE TO FULL SCALE',
    introduction: 'dBFS 以数字系统可表示的满幅为 0 dBFS。常规信号峰值位于负数区间，数值越接近 0，离数字削波越近。',
    keyPoint: '振幅换算使用 20 × log10(|x|)；数字静音趋向 −∞ dBFS，0 dBFS 以上没有可用的线性 PCM 余量。',
    visualKind: 'dbfs',
    visualSummary: '电平靠近 0 dBFS 时余量逐渐减少，到达满幅后继续提升会产生削波。',
    relatedTopics: ['频谱', '峰值', '动态余量', '削波'],
  },
  {
    id: 'fft-stft',
    title: 'FFT 与 STFT',
    englishTitle: 'FREQUENCY & TIME–FREQUENCY ANALYSIS',
    introduction: 'FFT 把一个有限时间窗转换为频率 bin；STFT 则让窗口沿时间滑动，连续计算多帧 FFT，从而得到二维声谱。',
    keyPoint: '更长窗口提高频率分辨率但降低时间定位能力；窗函数与重叠率用于控制频谱泄漏和帧间连续性。',
    visualKind: 'fft-stft',
    visualSummary: '单个窗口产生一帧频谱，连续重叠窗口沿时间排列后形成二维时频矩阵。',
    relatedTopics: ['实时频谱', '二维声谱', '窗函数', 'FFT Size'],
  },
]

export const AUDIO_WIKI_SECTIONS: readonly AudioWikiSection[] = [
  {
    id: 'frequency-boundaries',
    eyebrow: 'FREQUENCY CONTROL',
    title: '频段边界与清理',
    description: '用截止频率或中心频率决定哪些声音通过、被突出或被移除。',
    types: ['lowpass', 'highpass', 'bandpass', 'notch'],
  },
  {
    id: 'tone-shaping',
    eyebrow: 'TONE SHAPING',
    title: '音色塑形与均衡',
    description: '围绕目标频段提升或削减能量，从局部修饰延伸到整条 EQ 曲线。',
    types: ['peaking', 'lowshelf', 'highshelf', 'equalizer'],
  },
  {
    id: 'phase-and-sampling',
    eyebrow: 'PHASE & SAMPLING',
    title: '相位与采样',
    description: '理解幅度之外的相位变化，以及目标采样率和重建算法对波形的影响。',
    types: ['allpass', 'resampler'],
  },
]
