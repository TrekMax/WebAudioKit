export type SignalKnowledgeDiagramKind =
  | 'complex-plane'
  | 'euler'
  | 'phasor-wave'
  | 'sampling'
  | 'dft-bin'
  | 'magnitude-phase'
  | 'fft'
  | 'windowing'
  | 'stft'

export interface SignalKnowledgeTopic {
  readonly id: string
  readonly order: number
  readonly eyebrow: string
  readonly title: string
  readonly summary: string
  readonly formula: string
  readonly insight: string
  readonly diagram: SignalKnowledgeDiagramKind
}

export interface SignalKnowledgeSection {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly topics: readonly SignalKnowledgeTopic[]
}

export const SIGNAL_KNOWLEDGE_SECTIONS: readonly SignalKnowledgeSection[] = [
  {
    id: 'complex-foundations',
    title: '复数与旋转',
    description: '把实部、虚部和相位放到同一个几何坐标中，建立频域计算需要的语言。',
    topics: [
      {
        id: 'complex-plane',
        order: 1,
        eyebrow: 'COMPLEX PLANE',
        title: '复数不是“虚构的数”',
        summary: '复数 z = a + jb 是平面上的一个向量：横轴保存实部，纵轴保存虚部。长度表示幅度，方向表示相位。',
        formula: '|z| = √(a²+b²),  φ = atan2(b,a)',
        insight: '音频频谱的每个频率 bin 都是这样的复向量，因此能同时保存“有多强”和“转到哪里”。',
        diagram: 'complex-plane',
      },
      {
        id: 'euler',
        order: 2,
        eyebrow: 'EULER FORMULA',
        title: '欧拉公式把旋转写成指数',
        summary: '单位圆上的旋转可以拆成水平余弦与垂直正弦。指数形式让连续旋转和复数乘法变成同一件事。',
        formula: 'eʲᶿ = cos θ + j sin θ',
        insight: '改变 θ 就是在复平面上旋转；改变半径则是在保持相位的同时改变幅度。',
        diagram: 'euler',
      },
      {
        id: 'phasor-wave',
        order: 3,
        eyebrow: 'PHASOR PROJECTION',
        title: '旋转相量投影成波形',
        summary: '让单位复向量匀速旋转，并把实部或虚部沿时间展开，就得到余弦或正弦波。频率决定旋转速度，相位决定起点。',
        formula: 'x(t) = A cos(2πft + φ)',
        insight: '时域波形与复平面旋转是同一个运动的两种观察方式。',
        diagram: 'phasor-wave',
      },
    ],
  },
  {
    id: 'discrete-fourier',
    title: '从采样到 DFT / FFT',
    description: '把连续变化取成有限个样本，再逐个询问“这个频率在信号中有多少”。',
    topics: [
      {
        id: 'sampling',
        order: 4,
        eyebrow: 'DISCRETE SAMPLING',
        title: '连续曲线变成离散样本',
        summary: '数字系统只在固定时刻记录幅度。N 个样本构成一帧，样本率决定一秒记录多少次。',
        formula: 'x[n] = x(n / fₛ),  n = 0…N−1',
        insight: 'DFT 处理的是这 N 个离散数，不是屏幕上看起来连续的曲线。',
        diagram: 'sampling',
      },
      {
        id: 'dft-bin',
        order: 5,
        eyebrow: 'DFT BIN',
        title: '逐点反向旋转并累加',
        summary: '检测第 k 个频率时，每个样本乘上一个反向旋转的单位复数，再把所有结果首尾相接。匹配频率会朝同一方向聚拢。',
        formula: 'X[k] = Σ x[n]e⁻ʲ²ᵖⁱᵏⁿ／ᴺ',
        insight: '向量和越长，说明该频率越强；和向量的方向就是该频率分量的相位。',
        diagram: 'dft-bin',
      },
      {
        id: 'magnitude-phase',
        order: 6,
        eyebrow: 'MAGNITUDE + PHASE',
        title: '复数结果拆成幅度与相位',
        summary: '对每个 X[k] 取长度得到幅度谱，取角度得到相位谱。只看幅度容易读，但相位仍是重建时域信号的必要信息。',
        formula: 'M[k] = |X[k]|,  P[k] = atan2(Im, Re)',
        insight: '实值信号的完整 DFT 具有共轭对称性，所以常用单边幅度谱展示 0 到 Nyquist。',
        diagram: 'magnitude-phase',
      },
      {
        id: 'fft',
        order: 7,
        eyebrow: 'FAST FOURIER TRANSFORM',
        title: 'FFT 是 DFT 的高效算法',
        summary: 'FFT 利用旋转因子的重复与对称，把一个大问题递归拆成奇数项和偶数项的小问题。输出仍是同一组 X[k]。',
        formula: 'O(N²) → O(N log₂N)',
        insight: 'DFT 是要计算的数学变换，FFT 是更快得到相同结果的算法族。',
        diagram: 'fft',
      },
    ],
  },
  {
    id: 'time-frequency',
    title: '窗函数与时频结构',
    description: '有限观察会引入边界；滑动有限窗并重复变换，就能看到频率随时间如何变化。',
    topics: [
      {
        id: 'windowing',
        order: 8,
        eyebrow: 'WINDOW + LEAKAGE',
        title: '窗函数柔化帧边界',
        summary: '截取的信号若在首尾不能无缝衔接，DFT 会把突变解释为许多频率。Hann 等窗让边界逐渐衰减，以主瓣变宽换取旁瓣降低。',
        formula: 'xʷ[n] = x[n] · w[n]',
        insight: '窗函数不会凭空提高分辨率；它是在频率分辨能力与泄漏抑制之间做选择。',
        diagram: 'windowing',
      },
      {
        id: 'stft',
        order: 9,
        eyebrow: 'SHORT-TIME FOURIER TRANSFORM',
        title: '滑动 DFT 形成 STFT',
        summary: '把窗口沿时间移动，每一帧都计算一次频谱，再按时间顺序堆叠。横轴是时间，纵轴是频率，颜色或高度表示幅度。',
        formula: 'STFT{ x }(m,k) = Σ x[n]w[n−mH]e⁻ʲ²ᵖⁱᵏⁿ／ᴺ',
        insight: '窗长决定时间/频率分辨率的权衡，hop size 决定帧之间的采样密度。',
        diagram: 'stft',
      },
    ],
  },
] as const

export const SIGNAL_KNOWLEDGE_TOPICS = SIGNAL_KNOWLEDGE_SECTIONS.flatMap(
  (section) => section.topics,
)
