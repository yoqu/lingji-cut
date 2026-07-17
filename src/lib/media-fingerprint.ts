function bitsToHex(bits: number[]): string {
  let output = '';
  for (let index = 0; index < bits.length; index += 4) {
    const nibble = bits.slice(index, index + 4).reduce(
      (value, bit) => (value << 1) | bit,
      0,
    );
    output += nibble.toString(16);
  }
  return output;
}

export function computeVideoFrameDHashes(
  pixels: Uint8Array,
  width = 9,
  height = 8,
  maxFrames = 5,
): string[] {
  if (width < 2 || height < 1) return [];
  const frameSize = width * height;
  const frameCount = Math.min(maxFrames, Math.floor(pixels.byteLength / frameSize));
  const hashes: string[] = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * frameSize;
    const bits: number[] = [];
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width - 1; column += 1) {
        const left = pixels[offset + row * width + column];
        const right = pixels[offset + row * width + column + 1];
        bits.push(left > right ? 1 : 0);
      }
    }
    hashes.push(bitsToHex(bits));
  }
  return hashes;
}
