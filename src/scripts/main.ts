// The TypeScript entry point, loaded as a module by index.html. Vite compiles
// it; `pnpm typecheck` type-checks it. If the week's spec rules out
// JavaScript, delete this file and the script tag that loads it.
export {};

// Dev-only manual verification for src/scripts/rhythm.ts's onset detection —
// see rhythm-debug.ts for what it mounts (a playable timeline you can watch
// and listen to at once). Stripped from the production build by
// `import.meta.env.DEV` (confirmed empty in dist/ output); remove this
// block once onset detection is confirmed good, it's not part of the game.
if (import.meta.env.DEV) {
  const tracks = import.meta.glob<string>("../assets/music/*.mp3", { eager: true, query: "?url", import: "default" });
  const [name, url] = Object.entries(tracks)[0] ?? [];
  if (url) {
    import("./rhythm-debug").then(({ mountRhythmDebugger }) => mountRhythmDebugger(url, name));
  } else {
    console.warn("[rhythm] no track found under src/assets/music/*.mp3");
  }
}
