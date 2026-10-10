# DAT Parser (`@ac/dat-parser`)

Binary parser for Asheron's Call `.dat` files (portal.dat and cell.dat).

## Architecture

The DAT file is a B-tree indexed container of binary files. Each file has a unique 32-bit ID where the high byte indicates the file type.

### Core Classes

- **`DatReader`** — Low-level binary reader wrapping `DataView`. Supports uint8/16/32, int8/16/32, float32, Vector3, string (PString), CompressedUInt32, and 4-byte alignment.
- **`DatDatabase`** — Opens a DAT file, reads the header at offset `0x140`, traverses the B-tree directory to build a file ID → offset map, and reads files via sector chains.

### DAT Container Format

```
Header at offset 0x140:
  BlockSize: 1024 (portal) or 256 (cell)
  BTreeRoot: sector offset of root directory node

Sectors: first 4 bytes = next sector pointer, remaining = data
B-tree nodes: 62 branch pointers + entry count + up to 61 entries (each 24 bytes)
```

### File Type Parsers

Each parser class takes a `DatReader` and deserializes the binary format:

| Type ID | Class | Description |
|---------|-------|-------------|
| `0x01` | `GfxObj` | 3D mesh: vertices, normals, UVs, polygons, physics BSP |
| `0x02` | `SetupModel` | Multi-part model: part list, parent hierarchy, placement frames |
| `0x03` | `Animation` | Keyframe data: per-part transforms per frame, hooks |
| `0x04` | `Palette` | 256-entry ARGB color palette |
| `0x05` | `SurfaceTexture` | Multi-resolution texture reference list |
| `0x06` | `Texture` | Raw pixel data (RGBA, RGB565, DXT1/3/5, palette-indexed) |
| `0x08` | `Surface` | Material definition: texture, palette, translucency, luminosity |
| `0x09` | `MotionTable` | Animation state machine: stances, cycles, modifiers, links |
| `0x0A` | `Wave` | Sound data (PCM WAV or MP3) |
| `0x0D` | `Environment` | Dungeon room geometry |
| `0x0F` | `PaletteSet` | Palette variation set for appearance customization |
| `0x10` | `ClothingTable` | Equipment appearance overrides |
| `0x30` | `CombatManeuverTable` | Combat action definitions |
| `0x32` | `ParticleEmitterInfo` | Particle system parameters |

**Cell DAT types** (by low 16 bits of ID):
| Mask | Class | Description |
|------|-------|-------------|
| `0xFFFF` | `CellLandblock` | 9x9 terrain heights + terrain types |
| `0xFFFE` | `LandblockInfo` | Building placement, object spawns |
| `0x0001-0xFFFD` | `EnvCell` | Interior/dungeon cell geometry |

**Special IDs** (game data tables):
| ID | Class | Description |
|----|-------|-------------|
| `0x0E000002` | `CharGen` | Character creation options |
| `0x0E000003` | `SecondaryAttributeTable` | Health/stamina/mana formulas |
| `0x0E000004` | `SkillTable` | All 67 skills with formulas |
| `0x0E00000E` | `SpellTable` | 6,247 spells |
| `0x0E00000F` | `SpellComponentTable` | Reagent definitions |
| `0x0E000018` | `XpTable` | Level thresholds 1-275 |

### Key Binary Formats

**CompressedUInt32**: Variable-length encoding (1, 2, or 4 bytes based on high bits).

**PString**: 2-byte length prefix + ASCII bytes + 4-byte alignment padding.

**Frame**: 3 floats (origin xyz) + 4 floats (quaternion wxyz) = 28 bytes.

**BSP Tree**: Recursive nodes with type tags (`PORT`, `LEAF`, `BPnn`, `BPIn`, `BpIN`, `BpnN`, `BPIN`, `BPnN`). Capital letter = has that child branch.

### Usage

```typescript
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';

const db = new DatDatabase(arrayBuffer);
const ids = db.listFileIds(0x01); // all GfxObj files
const data = db.getFileData(ids[0]);
const gfx = new GfxObj(new DatReader(data));
```
