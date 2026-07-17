import { describe, expect, it } from 'vitest';
import { parseLoudnormMeasurement } from '../electron/audio-mastering';

describe('parseLoudnormMeasurement', () => {
  it('解析第一遍 loudnorm 的输入测量结果', () => {
    const measurement = parseLoudnormMeasurement(`noise\n{
      "input_i": "-20.10",
      "input_tp": "-3.20",
      "input_lra": "4.00",
      "input_thresh": "-30.00",
      "target_offset": "0.10"
    }`);
    expect(measurement).toMatchObject({ integratedLufs: -20.1, truePeakDbtp: -3.2 });
  });

  it('解析第二遍输出测量结果', () => {
    const measurement = parseLoudnormMeasurement(`{
      "output_i": "-15.00",
      "output_tp": "-1.10",
      "output_lra": "3.50",
      "output_thresh": "-25.00",
      "target_offset": "0.00"
    }`, 'output');
    expect(measurement).toMatchObject({ integratedLufs: -15, truePeakDbtp: -1.1 });
  });
});
