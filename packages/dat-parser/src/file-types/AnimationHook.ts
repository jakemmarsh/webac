import { DatReader } from '../DatReader.js';
import { readFrame, type Frame } from './Frame.js';

export enum AnimationHookType {
  NoOp = 0,
  Sound = 1,
  SoundTable = 2,
  Attack = 3,
  AnimationDone = 4,
  ReplaceObject = 5,
  Ethereal = 6,
  TransparentPart = 7,
  Luminous = 8,
  LuminousPart = 9,
  Diffuse = 10,
  DiffusePart = 11,
  Scale = 12,
  CreateParticle = 13,
  DestroyParticle = 14,
  StopParticle = 15,
  NoDraw = 16,
  DefaultScript = 17,
  DefaultScriptPart = 18,
  CallPES = 19,
  Transparent = 20,
  SoundTweaked = 21,
  SetOmega = 22,
  TextureVelocity = 23,
  TextureVelocityPart = 24,
  SetLight = 25,
  CreateBlockingParticle = 26,
}

export interface AnimationHookBase {
  hookType: AnimationHookType;
  direction: number;
}

export interface SoundHookData extends AnimationHookBase { soundId: number; }
export interface SoundTableHookData extends AnimationHookBase { soundType: number; }
export interface AttackHookData extends AnimationHookBase {
  partIndex: number; leftX: number; leftY: number; rightX: number; rightY: number;
  radius: number; height: number;
}
export interface ReplaceObjectHookData extends AnimationHookBase { partIndex: number; partId: number; }
export interface EtherealHookData extends AnimationHookBase { ethereal: number; }
export interface TransparentPartHookData extends AnimationHookBase { part: number; start: number; end: number; time: number; }
export interface LuminousHookData extends AnimationHookBase { start: number; end: number; time: number; }
export interface LuminousPartHookData extends AnimationHookBase { part: number; start: number; end: number; time: number; }
export interface DiffuseHookData extends AnimationHookBase { start: number; end: number; time: number; }
export interface DiffusePartHookData extends AnimationHookBase { part: number; start: number; end: number; time: number; }
export interface ScaleHookData extends AnimationHookBase { end: number; time: number; }
export interface CreateParticleHookData extends AnimationHookBase {
  emitterInfoId: number; partIndex: number; offset: Frame; emitterId: number;
}
export interface DestroyParticleHookData extends AnimationHookBase { emitterId: number; }
export interface StopParticleHookData extends AnimationHookBase { emitterId: number; }
export interface NoDrawHookData extends AnimationHookBase { noDraw: number; }
export interface DefaultScriptPartHookData extends AnimationHookBase { partIndex: number; }
export interface CallPESHookData extends AnimationHookBase { pes: number; pause: number; }
export interface TransparentHookData extends AnimationHookBase { start: number; end: number; time: number; }
export interface SoundTweakedHookData extends AnimationHookBase {
  soundId: number; priority: number; probability: number; volume: number;
}
export interface SetOmegaHookData extends AnimationHookBase { axis: { x: number; y: number; z: number }; }
export interface TextureVelocityHookData extends AnimationHookBase { uSpeed: number; vSpeed: number; }
export interface TextureVelocityPartHookData extends AnimationHookBase { partIndex: number; uSpeed: number; vSpeed: number; }
export interface SetLightHookData extends AnimationHookBase { lightsOn: number; }

export type AnimationHook =
  | AnimationHookBase
  | SoundHookData
  | SoundTableHookData
  | AttackHookData
  | ReplaceObjectHookData
  | EtherealHookData
  | TransparentPartHookData
  | LuminousHookData
  | LuminousPartHookData
  | DiffuseHookData
  | DiffusePartHookData
  | ScaleHookData
  | CreateParticleHookData
  | DestroyParticleHookData
  | StopParticleHookData
  | NoDrawHookData
  | DefaultScriptPartHookData
  | CallPESHookData
  | TransparentHookData
  | SoundTweakedHookData
  | SetOmegaHookData
  | TextureVelocityHookData
  | TextureVelocityPartHookData
  | SetLightHookData;

export function readAnimationHook(reader: DatReader): AnimationHook {
  const hookType = reader.readUInt32() as AnimationHookType;
  const direction = reader.readInt32();

  const base: AnimationHookBase = { hookType, direction };

  switch (hookType) {
    case AnimationHookType.Sound:
      return { ...base, soundId: reader.readUInt32() };

    case AnimationHookType.SoundTable:
      return { ...base, soundType: reader.readUInt32() };

    case AnimationHookType.Attack: {
      const partIndex = reader.readUInt32();
      const leftX = reader.readFloat32();
      const leftY = reader.readFloat32();
      const rightX = reader.readFloat32();
      const rightY = reader.readFloat32();
      const radius = reader.readFloat32();
      const height = reader.readFloat32();
      return { ...base, partIndex, leftX, leftY, rightX, rightY, radius, height };
    }

    case AnimationHookType.ReplaceObject: {
      // ACE ReplaceObjectHook.cs: a 2-byte PartIndex (masked to a byte by
      // AnimationPartChange.Unpack(reader, ushort)), then the GfxObj id as a
      // PACKED DID — ReadAsDataIDOfKnownType(0x01000000), 2 or 4 bytes
      // (AnimationPartChange.cs). A raw uint32 here over-reads 2 bytes and
      // misaligns every later hook in the frame (anim 0x0300055B).
      const partIndex = reader.readUInt16() & 0xFF;
      const partId = reader.readDataIdOfKnownType(0x01000000);
      return { ...base, partIndex, partId };
    }

    case AnimationHookType.Ethereal:
      return { ...base, ethereal: reader.readInt32() };

    case AnimationHookType.TransparentPart:
      return { ...base, part: reader.readUInt32(), start: reader.readFloat32(), end: reader.readFloat32(), time: reader.readFloat32() };

    case AnimationHookType.Luminous:
      return { ...base, start: reader.readFloat32(), end: reader.readFloat32(), time: reader.readFloat32() };

    case AnimationHookType.LuminousPart:
      return { ...base, part: reader.readUInt32(), start: reader.readFloat32(), end: reader.readFloat32(), time: reader.readFloat32() };

    case AnimationHookType.Diffuse:
      return { ...base, start: reader.readFloat32(), end: reader.readFloat32(), time: reader.readFloat32() };

    case AnimationHookType.DiffusePart:
      return { ...base, part: reader.readUInt32(), start: reader.readFloat32(), end: reader.readFloat32(), time: reader.readFloat32() };

    case AnimationHookType.Scale:
      return { ...base, end: reader.readFloat32(), time: reader.readFloat32() };

    case AnimationHookType.CreateParticle:
    case AnimationHookType.CreateBlockingParticle: {
      const emitterInfoId = reader.readUInt32();
      const emPartIndex = reader.readUInt32();
      const offset = readFrame(reader);
      const emitterId = reader.readUInt32();
      return { ...base, emitterInfoId, partIndex: emPartIndex, offset, emitterId };
    }

    case AnimationHookType.DestroyParticle:
      return { ...base, emitterId: reader.readUInt32() };

    case AnimationHookType.StopParticle:
      return { ...base, emitterId: reader.readUInt32() };

    case AnimationHookType.NoDraw:
      return { ...base, noDraw: reader.readUInt32() };

    case AnimationHookType.DefaultScriptPart:
      return { ...base, partIndex: reader.readUInt32() };

    case AnimationHookType.CallPES:
      return { ...base, pes: reader.readUInt32(), pause: reader.readFloat32() };

    case AnimationHookType.Transparent:
      return { ...base, start: reader.readFloat32(), end: reader.readFloat32(), time: reader.readFloat32() };

    case AnimationHookType.SoundTweaked: {
      // BUG.invented-portal-hum-timer — retail SoundTweakedHook::UnPack
      // @ 00527780 reads gid, PROBABILITY, priority, volume (ACE's
      // SoundTweakedHook.cs swaps the two names). The DAT agrees: 144 hooks'
      // second float is 0.9 (the ctor default prio, SoundTweakedHook @ 00526a40) and 220
      // are 0 — read as a probability those would never play, among them
      // every portal's DefaultScript hum (0x3300067A).
      const soundId = reader.readUInt32();
      const probability = reader.readFloat32();
      const priority = reader.readFloat32();
      return { ...base, soundId, priority, probability, volume: reader.readFloat32() };
    }

    case AnimationHookType.SetOmega:
      return { ...base, axis: reader.readVector3() };

    case AnimationHookType.TextureVelocity:
      return { ...base, uSpeed: reader.readFloat32(), vSpeed: reader.readFloat32() };

    case AnimationHookType.TextureVelocityPart:
      return { ...base, partIndex: reader.readUInt32(), uSpeed: reader.readFloat32(), vSpeed: reader.readFloat32() };

    case AnimationHookType.SetLight:
      return { ...base, lightsOn: reader.readInt32() };

    case AnimationHookType.AnimationDone:
    case AnimationHookType.DefaultScript:
    case AnimationHookType.NoOp:
    default:
      return base;
  }
}

export interface AnimationFrame {
  frames: Frame[];
  hooks: AnimationHook[];
}

export function readAnimationFrame(reader: DatReader, numParts: number): AnimationFrame {
  const frames: Frame[] = [];
  for (let i = 0; i < numParts; i++) {
    frames.push(readFrame(reader));
  }

  const numHooks = reader.readUInt32();
  const hooks: AnimationHook[] = [];
  for (let i = 0; i < numHooks; i++) {
    hooks.push(readAnimationHook(reader));
  }

  return { frames, hooks };
}
