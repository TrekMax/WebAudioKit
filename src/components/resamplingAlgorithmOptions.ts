import type { ResamplingAlgorithm } from '../audio/filterGraph'

export interface ResamplingAlgorithmOption {
  readonly value: ResamplingAlgorithm
  readonly label: string
  readonly algorithm: string
  readonly listeningCharacter: string
  readonly realtimeCost: string
  readonly recommendation: string
}

export const RESAMPLING_ALGORITHM_OPTIONS: readonly ResamplingAlgorithmOption[] = [
  {
    value: 'point',
    label: '原始抽点',
    algorithm: '直接抽点 + 零阶保持（无抗混叠）',
    listeningCharacter: '保留最原始的频率折叠与混叠失真，用于直接观察不做预滤波的抽点结果。',
    realtimeCost: '最低',
    recommendation: '仅用作算法对照基线；需要正常降采样时应选择带抗混叠的模式。',
  },
  {
    value: 'hold',
    label: '复古保持',
    algorithm: '一阶抗混叠 + 零阶保持',
    listeningCharacter: '颗粒感和阶梯感明显，高频细节会随目标采样率下降而减少。',
    realtimeCost: '低',
    recommendation: '默认模式，适合复古采样质感和低成本实时试听。',
  },
  {
    value: 'linear',
    label: '线性平滑',
    algorithm: '一阶抗混叠 + 因果线性插值',
    listeningCharacter: '重建更平滑，但失真和高频衰减仍可听见，并带有一个模拟采样间隔的延迟。',
    realtimeCost: '低',
    recommendation: '适合减少阶梯感，同时保持较低实时成本。',
  },
  {
    value: 'cubic',
    label: '三次平滑',
    algorithm: '一阶抗混叠 + 四点 Catmull–Rom 插值',
    listeningCharacter: '瞬态和连续曲线比线性模式更自然，高频保留更好；陡峭边缘可能出现轻微过冲。',
    realtimeCost: '中',
    recommendation: '推荐用于兼顾实时成本与平滑度的高质量监听。',
  },
  {
    value: 'sinc',
    label: '带限重建',
    algorithm: '一阶抗混叠 + 128 相位 16 抽头窗化 sinc',
    listeningCharacter: '通带最平直、镜像抑制更好，但会引入约八个模拟采样间隔的因果延迟，并可能产生轻微振铃。',
    realtimeCost: '高',
    recommendation: '适合双声道高质量试听；多声道或性能受限设备优先使用三次平滑。',
  },
]

export function resamplingAlgorithmLabel(algorithm: ResamplingAlgorithm): string {
  return RESAMPLING_ALGORITHM_OPTIONS.find(({ value }) => value === algorithm)?.label
    ?? algorithm
}

export function resolveResamplingMode(
  targetSampleRateHz: number,
  outputSampleRateHz: number,
): { readonly active: boolean; readonly label: '下采样与重建' | '透明直通' } {
  const active = targetSampleRateHz < outputSampleRateHz
  return {
    active,
    label: active ? '下采样与重建' : '透明直通',
  }
}
