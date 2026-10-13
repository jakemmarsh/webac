# Notices and credits

## Not affiliated

webAC is an independent, non-commercial fan project. It is not affiliated with,
endorsed by or sponsored by Warner Bros. Games, Turbine, Daybreak Game Company
or any owner of the Asheron's Call trademark or game. "Asheron's Call" is used
only to describe what the client is compatible with.

## Game data

This repository contains no game data. The client reads the retail Asheron's
Call data files (the DAT files: textures, models, maps, fonts, user-interface
layouts and strings) at run time. The hosted site streams copies of the
end-of-retail DATs that the emulator community has distributed since the
servers closed in 2017. We will remove anything a rights holder asks us to
remove; see [SECURITY.md](SECURITY.md) for how to reach us.

## Interoperability

Parts of the client were written by studying how the original client talks to
servers and reads its data, for interoperability with community servers. No
original client code or decompiled output is distributed; documentation cites
function addresses and describes behaviour in prose.

## Code we build on

| Project | License | What we use |
|---|---|---|
| [ACE (ACEmulator)](https://github.com/ACEmulator/ACE) | AGPL-3.0 | DAT formats, network protocol, game formulas and enums ported to TypeScript |
| [ACViewer](https://github.com/ACEmulator/ACViewer) | GPL-3.0 | Rendering approach for terrain, models and environments |
| [aclogview](https://github.com/ACEmulator/aclogview) | — | Reference for message layouts (consulted, not copied) |
| [GDLEnhanced](https://gitlab.com/Scribble/gdlenhanced) | — | Reference for GDLE server behaviour (consulted, not copied) |
| [UtilityBelt](https://gitlab.com/utilitybelt/utilitybelt) | MIT (its README) | The `/ub` commands, AutoVendor, equipment profiles, AutoXp, aliases and game events, the quest tracker and tinkering calculator, and Nametags, ported to TypeScript from 5fe9825a (`packages/renderer/src/agent/ub/`, `packages/renderer/src/scene/Nametags.ts`); its Dungeon Maps and Landscape Maps windows, settings and town list (`packages/renderer/src/ui/maps/`, `tools/build-map-markers.ts`); its main window's layout (`packages/renderer/src/ui/automation/UbMainWindow.ts`) and its icon, `Resources/icons/utilitybelt.png` (`ubIcon.ts`) |
| [Virindi public plugins](http://www.virindi.net/repos/virindi_public/trunk/) | MIT (file headers, VirindiPlugins 2010–2011) | Virindi Reporter's behaviour and output text, rebuilt in TypeScript (`packages/shared/src/routines/virindiReporter.ts`); facts only, from its source (docs/plugin-specs/reporter-statushud.md) |
| [GoArrow](https://github.com/Xanius/GoArrow-VVSEdition) (Ben Howell 2007, Xanius 2018) | MIT | Its arrow images, close box and toolbar glyph (`packages/renderer/src/ui/goarrow/arrows/`, LICENSE.txt there); its behaviour rebuilt in TypeScript, facts only (docs/plugin-specs/goarrow.md). Its bundled location database is not used: ours is generated from each era's world data (`tools/build-goarrow-locations.ts`) |
| [Mag-Tools](https://github.com/Mag-nus/Mag-Plugins) | LGPL-2.1 | Behaviour, option names and output text only, rebuilt in our own TypeScript (`packages/shared/src/magtools/`; docs/plugin-specs/magtools.md); no code or images |
| Virindi Chat System 5 | closed | Behaviour from its wiki only, no code or art: its chat routing rebuilt in our own TypeScript (`packages/shared/src/vcs5/`, `packages/renderer/src/ui/automation/VcsWindow.ts`; docs/plugin-specs/vcs5.md) |
| [three.js](https://threejs.org/) | MIT | 3D rendering |
| [ws](https://github.com/websockets/ws) | MIT | WebSocket server in the bridge |

The AGPL-3.0 allows combining GPL-3.0 code, so the whole project is
AGPL-3.0-or-later ([LICENSE](LICENSE)).

## Community resources

- Server list: [acresources/serverslist](https://github.com/acresources/serverslist)
- Server status: [TreeStats](https://treestats.net/)
- Thanks to the ACE, GDLE and wider Asheron's Call emulator communities, who
  kept Dereth running.
