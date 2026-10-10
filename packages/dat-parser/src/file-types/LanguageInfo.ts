import { DatReader } from '../DatReader.js';

/**
 * LanguageInfo — client_local_English.dat file 0x41000000.
 *
 * Locale-specific number formatting + plural rules + treasure-name letter
 * pools + Input Method Editor (IME) UI styling. Retail used this to drive
 * non-English locale support; we only ship English so the parsed data is
 * mostly diagnostic / completeness-only.
 *
 * Reference: reference/ACE/Source/ACE.DatLoader/FileTypes/LanguageInfo.cs
 */
export interface LanguageInfoData {
  version: number;
  base: number;
  numDecimalDigits: number;
  leadingZero: boolean;
  groupingSize: number;
  numerals: string[];
  decimalSeparator: string[];
  groupingSeparator: string[];
  negativeNumberFormat: string[];
  isZeroSingular: boolean;
  isOneSingular: boolean;
  isNegativeOneSingular: boolean;
  isTwoOrMoreSingular: boolean;
  isNegativeTwoOrLessSingular: boolean;
  treasurePrefixLetters: string[];
  treasureMiddleLetters: string[];
  treasureSuffixLetters: string[];
  malePlayerLetters: string[];
  femalePlayerLetters: string[];
  imeEnabledSetting: number;
  symbolColor: number;
  symbolColorText: number;
  symbolHeight: number;
  symbolTranslucence: number;
  symbolPlacement: number;
  candColorBase: number;
  candColorBorder: number;
  candColorText: number;
  compColorInput: number;
  compColorTargetConv: number;
  compColorConverted: number;
  compColorTargetNotConv: number;
  compColorInputErr: number;
  compTranslucence: number;
  compColorText: number;
  otherIme: number;
  wordWrapOnSpace: number;
  additionalSettings: string[];
  additionalFlags: number;
}

/** Read a list of uint16 codepoints prefixed by a uint8 count, returned as chars. */
function unpackCharList(reader: DatReader): string[] {
  const numElements = reader.readUInt8();
  const chars: string[] = [];
  for (let i = 0; i < numElements; i++) {
    chars.push(String.fromCharCode(reader.readUInt16()));
  }
  return chars;
}

export class LanguageInfo implements LanguageInfoData {
  version: number = 0;
  base: number = 0;
  numDecimalDigits: number = 0;
  leadingZero: boolean = false;
  groupingSize: number = 0;
  numerals: string[] = [];
  decimalSeparator: string[] = [];
  groupingSeparator: string[] = [];
  negativeNumberFormat: string[] = [];
  isZeroSingular: boolean = false;
  isOneSingular: boolean = false;
  isNegativeOneSingular: boolean = false;
  isTwoOrMoreSingular: boolean = false;
  isNegativeTwoOrLessSingular: boolean = false;
  treasurePrefixLetters: string[] = [];
  treasureMiddleLetters: string[] = [];
  treasureSuffixLetters: string[] = [];
  malePlayerLetters: string[] = [];
  femalePlayerLetters: string[] = [];
  imeEnabledSetting: number = 0;
  symbolColor: number = 0;
  symbolColorText: number = 0;
  symbolHeight: number = 0;
  symbolTranslucence: number = 0;
  symbolPlacement: number = 0;
  candColorBase: number = 0;
  candColorBorder: number = 0;
  candColorText: number = 0;
  compColorInput: number = 0;
  compColorTargetConv: number = 0;
  compColorConverted: number = 0;
  compColorTargetNotConv: number = 0;
  compColorInputErr: number = 0;
  compTranslucence: number = 0;
  compColorText: number = 0;
  otherIme: number = 0;
  wordWrapOnSpace: number = 0;
  additionalSettings: string[] = [];
  additionalFlags: number = 0;

  static read(reader: DatReader): LanguageInfo {
    const t = new LanguageInfo();
    t.version = reader.readInt32();
    t.base = reader.readInt16();
    t.numDecimalDigits = reader.readInt16();
    t.leadingZero = reader.readUInt8() !== 0;
    t.groupingSize = reader.readInt16();
    t.numerals = unpackCharList(reader);
    t.decimalSeparator = unpackCharList(reader);
    t.groupingSeparator = unpackCharList(reader);
    t.negativeNumberFormat = unpackCharList(reader);
    t.isZeroSingular = reader.readUInt8() !== 0;
    t.isOneSingular = reader.readUInt8() !== 0;
    t.isNegativeOneSingular = reader.readUInt8() !== 0;
    t.isTwoOrMoreSingular = reader.readUInt8() !== 0;
    t.isNegativeTwoOrLessSingular = reader.readUInt8() !== 0;
    reader.align(4);
    t.treasurePrefixLetters = unpackCharList(reader);
    t.treasureMiddleLetters = unpackCharList(reader);
    t.treasureSuffixLetters = unpackCharList(reader);
    t.malePlayerLetters = unpackCharList(reader);
    t.femalePlayerLetters = unpackCharList(reader);
    t.imeEnabledSetting = reader.readUInt32();
    t.symbolColor = reader.readUInt32();
    t.symbolColorText = reader.readUInt32();
    t.symbolHeight = reader.readUInt32();
    t.symbolTranslucence = reader.readUInt32();
    t.symbolPlacement = reader.readUInt32();
    t.candColorBase = reader.readUInt32();
    t.candColorBorder = reader.readUInt32();
    t.candColorText = reader.readUInt32();
    t.compColorInput = reader.readUInt32();
    t.compColorTargetConv = reader.readUInt32();
    t.compColorConverted = reader.readUInt32();
    t.compColorTargetNotConv = reader.readUInt32();
    t.compColorInputErr = reader.readUInt32();
    t.compTranslucence = reader.readUInt32();
    t.compColorText = reader.readUInt32();
    t.otherIme = reader.readUInt32();
    t.wordWrapOnSpace = reader.readInt32();
    t.additionalSettings = unpackCharList(reader);
    t.additionalFlags = reader.readUInt32();
    return t;
  }
}
