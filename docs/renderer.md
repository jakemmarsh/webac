# Renderer (`@ac/renderer`)

Three.js-based rendering system for Asheron's Call world visualization.

## Subsystems

### Terrain (`terrain/`)

- **`LandblockMesh`** — Converts `CellLandblock` height data into geometry. 9x9 vertex grid (81 vertices), 8x8 quads (128 triangles). Each cell = 24m, full landblock = 192m.
- **`LandblockGeometry`** — Pure-data geometry (Float32Array positions/normals/uvs, Uint16Array indices). Works in both Node.js and browser.
- **`TerrainManager`** — Streams landblocks around the camera. Loads/unloads a configurable radius grid as the camera moves.
- **`TerrainRenderer`** — Creates Three.js `Mesh` objects from terrain geometry with texture mapping.

### Models (`models/`)

- **`ModelRenderer`** — Loads `GfxObj` meshes from portal.dat, creates Three.js `BufferGeometry` with caching.
- **`buildGfxObjGeometry()`** — Converts GfxObj vertices/polygons to renderable arrays. Handles fan triangulation for n-gon polygons.
- **`SetupModelRenderer`** — Assembles multi-part models from `SetupModel` data. Places child parts using Frame transforms and parent hierarchy.
- **`TextureManager`** — On-demand texture loading from portal.dat. Triple-level cache (SurfaceTexture → Texture → RGBA). Palette application support.
- **`MaterialFactory`** — Converts `Surface` definitions to Three.js `MeshStandardMaterial`. Handles translucency, luminosity, alpha testing.
- **`ClothingRenderer`** — Applies clothing table texture/palette overrides for equipment appearance.
- **`AppearanceManager`** — Character customization via palette composition (skin, hair, clothing colors).

### Scene (`scene/`)

- **`SceneManager`** — Three.js scene, camera, and renderer lifecycle. Default lighting setup.
- **`CameraController`** — First-person WASD + mouse look. Pure math (testable without DOM). Configurable pitch/yaw limits and movement speed.

### Animation (`animation/`)

- **`AnimationPlayer`** — Low-level keyframe playback. Frame interpolation using position lerp + quaternion slerp. Hook event dispatching at frame boundaries.
- **`MotionManager`** — High-level animation state machine driven by `MotionTable`. Manages stance/action transitions with composite keys: `(stance_lower16 << 16) | (motion_lower20)`.
- **`SkeletonSystem`** — Bone hierarchy with forward kinematics. Initializes from `SetupModel` parent indices. Computes world transforms via parent-child quaternion multiplication chain.

### Effects (`effects/`)

- **`ParticleSystem`** — Runtime particle emitter using Three.js `Points`. Driven by `ParticleEmitterInfo` data: birthrate, velocity, gravity, scale/opacity interpolation.
- **`SkyboxRenderer`** — Gradient shader skybox with 24-minute day/night cycle (1440 seconds). Updates sun position, light intensity, fog color.
- **`SpellEffects`** — Visual effects for 5 magic schools. Creates projectiles (sphere + trail + light), impact flashes (rings), and auras (pillars).

### Audio (`audio/`)

- **`AudioManager`** — Web Audio API wrapper. 4 categories (ambient, effects, music, ui) with independent volume/mute. Master volume. WAV buffer decoding.
- **`SoundPlayer`** — Loads `Wave` files from portal.dat. Positional (3D) audio with linear distance attenuation. Caches decoded AudioBuffers.
- **`MusicPlayer`** — Background music with configurable crossfade transitions between tracks.

## Pipeline

```
DAT File → DatDatabase.getFileData()
  → Parser (GfxObj, Texture, etc.)
    → Renderer Module (ModelRenderer, TextureManager)
      → Three.js Object (BufferGeometry, Mesh, Material)
        → Scene
```

## Usage

```typescript
import { SceneManager } from '@ac/renderer/scene/SceneManager.js';
import { ModelRenderer } from '@ac/renderer/models/ModelRenderer.js';

const scene = new SceneManager();
const models = new ModelRenderer(portalDb, textureManager, materialFactory);
const mesh = models.createMesh(gfxObjId);
scene.add(mesh);
```
