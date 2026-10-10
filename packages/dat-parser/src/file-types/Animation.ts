import { DatReader } from '../DatReader.js';
import { readFrame, type Frame } from './Frame.js';
import { readAnimationFrame, type AnimationFrame } from './AnimationHook.js';

export enum AnimationFlags {
  PosFrames = 0x01,
}

/**
 * Animation — keyframe animation from portal.dat (0x03xxxxxx)
 * Reference: ACE.DatLoader/FileTypes/Animation.cs
 */
export class Animation {
  id: number = 0;
  flags: number = 0;
  numParts: number = 0;
  numFrames: number = 0;
  posFrames: Frame[] = [];
  partFrames: AnimationFrame[] = [];

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();
    this.flags = reader.readUInt32();
    this.numParts = reader.readUInt32();
    this.numFrames = reader.readUInt32();

    // Position frames (root motion)
    if ((this.flags & AnimationFlags.PosFrames) !== 0) {
      for (let i = 0; i < this.numFrames; i++) {
        this.posFrames.push(readFrame(reader));
      }
    }

    // Per-frame part transforms + hooks
    for (let i = 0; i < this.numFrames; i++) {
      this.partFrames.push(readAnimationFrame(reader, this.numParts));
    }
  }
}
