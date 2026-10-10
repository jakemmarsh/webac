/**
 * DXT1/3/5 texture decompression.
 * Ported from MonoGame (Ms-PL license) via ACE DxtUtil.cs.
 *
 * Output format: RGBA (r,g,b,a) byte order, 4 bytes per pixel.
 */

function convertRgb565ToRgb888(color: number): [number, number, number] {
  let temp: number;
  temp = (color >> 11) * 255 + 16;
  const r = ((temp / 32 + temp) / 32) | 0;
  temp = ((color & 0x07e0) >> 5) * 255 + 32;
  const g = ((temp / 64 + temp) / 64) | 0;
  temp = (color & 0x001f) * 255 + 16;
  const b = ((temp / 32 + temp) / 32) | 0;
  return [r, g, b];
}

function decompressDxt1Block(
  data: DataView,
  dataOffset: number,
  x: number,
  y: number,
  width: number,
  height: number,
  imageData: Uint8Array,
): number {
  const c0 = data.getUint16(dataOffset, true);
  const c1 = data.getUint16(dataOffset + 2, true);
  dataOffset += 4;

  const [r0, g0, b0] = convertRgb565ToRgb888(c0);
  const [r1, g1, b1] = convertRgb565ToRgb888(c1);

  const lookupTable = data.getUint32(dataOffset, true);
  dataOffset += 4;

  for (let blockY = 0; blockY < 4; blockY++) {
    for (let blockX = 0; blockX < 4; blockX++) {
      let r = 0, g = 0, b = 0, a = 255;
      const index = (lookupTable >> (2 * (4 * blockY + blockX))) & 0x03;

      if (c0 > c1) {
        switch (index) {
          case 0: r = r0; g = g0; b = b0; break;
          case 1: r = r1; g = g1; b = b1; break;
          case 2: r = ((2 * r0 + r1) / 3) | 0; g = ((2 * g0 + g1) / 3) | 0; b = ((2 * b0 + b1) / 3) | 0; break;
          case 3: r = ((r0 + 2 * r1) / 3) | 0; g = ((g0 + 2 * g1) / 3) | 0; b = ((b0 + 2 * b1) / 3) | 0; break;
        }
      } else {
        switch (index) {
          case 0: r = r0; g = g0; b = b0; break;
          case 1: r = r1; g = g1; b = b1; break;
          case 2: r = ((r0 + r1) / 2) | 0; g = ((g0 + g1) / 2) | 0; b = ((b0 + b1) / 2) | 0; break;
          case 3: r = 0; g = 0; b = 0; a = 0; break;
        }
      }

      const px = (x << 2) + blockX;
      const py = (y << 2) + blockY;
      if (px < width && py < height) {
        const offset = ((py * width) + px) << 2;
        imageData[offset] = r;
        imageData[offset + 1] = g;
        imageData[offset + 2] = b;
        imageData[offset + 3] = a;
      }
    }
  }

  return dataOffset;
}

function decompressDxt3Block(
  data: DataView,
  dataOffset: number,
  x: number,
  y: number,
  width: number,
  height: number,
  imageData: Uint8Array,
): number {
  // Read 8 alpha bytes
  const alphaBytes: number[] = [];
  for (let i = 0; i < 8; i++) {
    alphaBytes.push(data.getUint8(dataOffset++));
  }

  const c0 = data.getUint16(dataOffset, true);
  const c1 = data.getUint16(dataOffset + 2, true);
  dataOffset += 4;

  const [r0, g0, b0] = convertRgb565ToRgb888(c0);
  const [r1, g1, b1] = convertRgb565ToRgb888(c1);

  const lookupTable = data.getUint32(dataOffset, true);
  dataOffset += 4;

  let alphaIndex = 0;
  for (let blockY = 0; blockY < 4; blockY++) {
    for (let blockX = 0; blockX < 4; blockX++) {
      let r = 0, g = 0, b = 0, a = 0;
      const index = (lookupTable >> (2 * (4 * blockY + blockX))) & 0x03;

      // Extract 4-bit alpha
      const byteIdx = alphaIndex >> 1;
      if ((alphaIndex & 1) === 0) {
        a = (alphaBytes[byteIdx] & 0x0f) | ((alphaBytes[byteIdx] & 0x0f) << 4);
      } else {
        a = (alphaBytes[byteIdx] & 0xf0) | ((alphaBytes[byteIdx] & 0xf0) >> 4);
      }
      alphaIndex++;

      switch (index) {
        case 0: r = r0; g = g0; b = b0; break;
        case 1: r = r1; g = g1; b = b1; break;
        case 2: r = ((2 * r0 + r1) / 3) | 0; g = ((2 * g0 + g1) / 3) | 0; b = ((2 * b0 + b1) / 3) | 0; break;
        case 3: r = ((r0 + 2 * r1) / 3) | 0; g = ((g0 + 2 * g1) / 3) | 0; b = ((b0 + 2 * b1) / 3) | 0; break;
      }

      const px = (x << 2) + blockX;
      const py = (y << 2) + blockY;
      if (px < width && py < height) {
        const offset = ((py * width) + px) << 2;
        imageData[offset] = r;
        imageData[offset + 1] = g;
        imageData[offset + 2] = b;
        imageData[offset + 3] = a;
      }
    }
  }

  return dataOffset;
}

function decompressDxt5Block(
  data: DataView,
  dataOffset: number,
  x: number,
  y: number,
  width: number,
  height: number,
  imageData: Uint8Array,
): number {
  const alpha0 = data.getUint8(dataOffset++);
  const alpha1 = data.getUint8(dataOffset++);

  // Read 6 bytes of alpha mask (48 bits)
  let alphaMask = 0n;
  for (let i = 0; i < 6; i++) {
    alphaMask += BigInt(data.getUint8(dataOffset++)) << BigInt(i * 8);
  }

  const c0 = data.getUint16(dataOffset, true);
  const c1 = data.getUint16(dataOffset + 2, true);
  dataOffset += 4;

  const [r0, g0, b0] = convertRgb565ToRgb888(c0);
  const [r1, g1, b1] = convertRgb565ToRgb888(c1);

  const lookupTable = data.getUint32(dataOffset, true);
  dataOffset += 4;

  for (let blockY = 0; blockY < 4; blockY++) {
    for (let blockX = 0; blockX < 4; blockX++) {
      let r = 0, g = 0, b = 0, a = 255;
      const index = (lookupTable >> (2 * (4 * blockY + blockX))) & 0x03;

      const alphaIdx = Number((alphaMask >> BigInt(3 * (4 * blockY + blockX))) & 0x07n);
      if (alphaIdx === 0) {
        a = alpha0;
      } else if (alphaIdx === 1) {
        a = alpha1;
      } else if (alpha0 > alpha1) {
        a = (((8 - alphaIdx) * alpha0 + (alphaIdx - 1) * alpha1) / 7) | 0;
      } else if (alphaIdx === 6) {
        a = 0;
      } else if (alphaIdx === 7) {
        a = 0xff;
      } else {
        a = (((6 - alphaIdx) * alpha0 + (alphaIdx - 1) * alpha1) / 5) | 0;
      }

      switch (index) {
        case 0: r = r0; g = g0; b = b0; break;
        case 1: r = r1; g = g1; b = b1; break;
        case 2: r = ((2 * r0 + r1) / 3) | 0; g = ((2 * g0 + g1) / 3) | 0; b = ((2 * b0 + b1) / 3) | 0; break;
        case 3: r = ((r0 + 2 * r1) / 3) | 0; g = ((g0 + 2 * g1) / 3) | 0; b = ((b0 + 2 * b1) / 3) | 0; break;
      }

      const px = (x << 2) + blockX;
      const py = (y << 2) + blockY;
      if (px < width && py < height) {
        const offset = ((py * width) + px) << 2;
        imageData[offset] = r;
        imageData[offset + 1] = g;
        imageData[offset + 2] = b;
        imageData[offset + 3] = a;
      }
    }
  }

  return dataOffset;
}

export class DxtUtil {
  static decompressDxt1(sourceData: Uint8Array, width: number, height: number): Uint8Array {
    const imageData = new Uint8Array(width * height * 4);
    const view = new DataView(sourceData.buffer, sourceData.byteOffset, sourceData.byteLength);
    const blockCountX = ((width + 3) / 4) | 0;
    const blockCountY = ((height + 3) / 4) | 0;
    let offset = 0;

    for (let y = 0; y < blockCountY; y++) {
      for (let x = 0; x < blockCountX; x++) {
        offset = decompressDxt1Block(view, offset, x, y, width, height, imageData);
      }
    }

    return imageData;
  }

  static decompressDxt3(sourceData: Uint8Array, width: number, height: number): Uint8Array {
    const imageData = new Uint8Array(width * height * 4);
    const view = new DataView(sourceData.buffer, sourceData.byteOffset, sourceData.byteLength);
    const blockCountX = ((width + 3) / 4) | 0;
    const blockCountY = ((height + 3) / 4) | 0;
    let offset = 0;

    for (let y = 0; y < blockCountY; y++) {
      for (let x = 0; x < blockCountX; x++) {
        offset = decompressDxt3Block(view, offset, x, y, width, height, imageData);
      }
    }

    return imageData;
  }

  static decompressDxt5(sourceData: Uint8Array, width: number, height: number): Uint8Array {
    const imageData = new Uint8Array(width * height * 4);
    const view = new DataView(sourceData.buffer, sourceData.byteOffset, sourceData.byteLength);
    const blockCountX = ((width + 3) / 4) | 0;
    const blockCountY = ((height + 3) / 4) | 0;
    let offset = 0;

    for (let y = 0; y < blockCountY; y++) {
      for (let x = 0; x < blockCountX; x++) {
        offset = decompressDxt5Block(view, offset, x, y, width, height, imageData);
      }
    }

    return imageData;
  }
}
