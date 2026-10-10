# Architecture Overview

## Project Structure

```
packages/
  shared/        — @ac/shared: types, enums, constants (used by all packages)
  dat-parser/    — @ac/dat-parser: binary DAT file parsing (portal.dat, cell.dat)
  renderer/      — @ac/renderer: Three.js browser client (terrain, models, effects, audio)
  network/       — @ac/network: AC protocol packet serialization
services/
  ws-tcp-bridge/ — WebSocket↔TCP proxy for connecting to ACE C# servers
tools/
  world-db-convert.ts — MySQL→SQLite converter for ACE world database
tests/
  verify-phase*.ts — Phase verification tests
docs/            — Subsystem documentation
dat/             — DAT files (gitignored, ~1.3GB)
reference/       — ACE/ACViewer C# source (gitignored)
```

## Operating Mode

**ACE Server Connectivity** — The browser client connects to existing community ACE C# servers via a WebSocket-to-TCP bridge (`ws-tcp-bridge`). The bridge translates between browser WebSocket and the ACE server's UDP protocol.

## Data Flow

### Asset Pipeline (Phases 1-8)
```
.dat files (binary)
  → DatDatabase (B-tree + sector chains)
    → File type parsers (GfxObj, Texture, Animation, etc.)
      → Structured TypeScript objects
```

### Rendering Pipeline (Phases 11-17)
```
Parsed assets
  → Renderer modules (ModelRenderer, TextureManager, etc.)
    → Three.js objects (BufferGeometry, Material, Mesh)
      → WebGL scene
```

### Network Pipeline
```
Browser WebSocket
  → ws-tcp-bridge (WebSocket↔UDP)
    → ACE C# server (auth port 9000, world port 9001)
```

## Key Technical Decisions

| Area | Choice | Why |
|------|--------|-----|
| Binary parsing | DataView on ArrayBuffer | Works in Node.js + browser |
| 3D rendering | Three.js | Industry standard, TypeScript support |
| Build tool | Vite | Fast HMR, serves DAT files as static |
| Testing | Vitest | Fast, native TypeScript, Vite-compatible |
| Package manager | npm workspaces | Simple monorepo, no extra tools |
| World DB (tools/tests) | better-sqlite3 | Native performance, sync API |
| Networking | WebSocket + ws-tcp-bridge | Browser WS to ACE server TCP/UDP |

## Phase Progression

| Group | Phases | Description |
|-------|--------|-------------|
| Asset Pipeline | 1-8 | DAT parsing, textures, models, animations, game tables |
| World Data | 9 | World database conversion and data integrity |
| Renderer | 11-18 | Three.js scene, terrain, models, animation, effects, audio |
| Core Systems | 19-25 | Physics, character, combat, magic, AI |
| Extended Game | 27-32 | Loot, death, vendors, social, crafting, housing |
| Network | 33-34 | Packet protocol, WebSocket bridge |
| UI | 40-42 | Loading screen, HUD, inventory, chat |
| Checkpoints | 18, 26, 39 | Integration smoke tests (no new implementation) |

## DAT File Specifics

The game has two main DAT files:
- **portal.dat** (~880MB) — All shared assets: 3D models, textures, animations, spells, skills
- **cell.dat** (~330MB) — World geometry: terrain heightmaps, dungeon cells, building placement

Both use the same container format: sector-chain storage with B-tree directory indexing. Header at offset `0x140`. Block sizes differ (1024 vs 256 bytes).
