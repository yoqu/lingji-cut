import type { AppIconName } from '../components/AppIcon';
import { CARRIER_META, STORYBOARD_CARRIERS, type StoryboardCarrier } from './motion-storyboard';

export type ManualCardKind = 'motion' | 'image' | 'video';

export const MANUAL_CARD_KIND_OPTIONS: Array<{
  kind: ManualCardKind;
  label: string;
  icon: AppIconName;
}> = [
  { kind: 'motion', label: 'Motion 卡', icon: 'sparkles' },
  { kind: 'image', label: '图片卡', icon: 'image' },
  { kind: 'video', label: '视频卡', icon: 'film' },
];

/** 手动建卡的载体倾向；auto = 交给导演自行判断 */
export const MANUAL_CARD_CARRIER_OPTIONS: Array<{
  value: StoryboardCarrier | 'auto';
  label: string;
}> = [
  { value: 'auto', label: '自动（按内容判断）' },
  ...STORYBOARD_CARRIERS.map((value) => ({
    value,
    label: `${CARRIER_META[value].label}（${CARRIER_META[value].description}）`,
  })),
];
