# Contributing

Thanks for helping. webAC aims to match the end-of-retail (January 2017)
Asheron's Call client exactly, so the bar for a change is "this is what
retail did", backed by evidence.

## Ground rules

1. **Data, not guesses.** Textures, layouts, colours, strings, timings and
   formulas come from the DAT files, the ACE server source or documented
   retail client behaviour. If you can't find the value, ask in an issue
   rather than approximating it.
2. **Retail defaults.** Key bindings, camera, options and behaviour match
   retail out of the box. The exceptions are browser conventions (window
   resizing, scrolling, wheel zoom) and controls whose target no longer
   exists (Report Abuse, in-game help), which are removed.
3. **Tests run real code.** Every change under `packages/` comes with a test
   under `tests/` that imports the real module and checks behaviour. Tests
   that read a source file and match text are not accepted. Tests that need
   the DAT files use `describe.skipIf` and do their loading in `beforeAll`.
4. **Look at it.** UI and rendering changes need a before/after screenshot
   from the running client.
5. **No game data or original client code** in commits: no DAT files, no
   executables, no decompiled output.

## Workflow

```bash
npm install
npx tsc -b                                   # type check
npm run test:file -- tests/<your-test>.ts    # while iterating
npm test                                     # the full suite, before a PR
```

`git config core.hooksPath tools/githooks` enables the commit hooks (a test
change must accompany a code change; `[skip-tests]` in the message for docs
and config).

## Where things are

- `docs/`: design notes and findings, for example `docs/dat-streaming.md`,
  `docs/gdle-compat.md` and `docs/release-plan.md`.
- `tasks.json`: the backlog. `node tools/task-status.mjs next` lists the
  next open tasks.
- `verification/scorecard.json`: how close each screen and flow is to retail
  (`node tools/scorecard.mjs`).

By contributing you agree your contribution is licensed under
AGPL-3.0-or-later.
