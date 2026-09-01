// The TypeScript entry point, loaded as a module by index.html. Vite compiles
// it; `pnpm typecheck` type-checks it. If the week's spec rules out
// JavaScript, delete this file and the script tag that loads it.
export {};

const tracks = import.meta.glob<string>("../assets/music/*.mp3", { eager: true, query: "?url", import: "default" });
const [trackName, trackUrl] = Object.entries(tracks)[0] ?? [];

if (trackUrl) {
  const canvas = document.querySelector<HTMLCanvasElement>("#game");
  if (canvas) {
    import("./game")
      .then(({ startGame }) => startGame(canvas, trackUrl))
      .catch((err) => console.error("[game] failed to start", err));
  }
} else {
  console.warn("[rhythm] no track found under src/assets/music/*.mp3");
}

// Dev-only manual verification for src/scripts/rhythm.ts's onset detection —
// see rhythm-debug.ts for what it mounts (a playable timeline you can watch
// and listen to at once). Stripped from the production build by
// `import.meta.env.DEV` (confirmed empty in dist/ output). Opt-in only
// (?debug) — it prepends its own UI to <body>, which pushed the real
// full-viewport game canvas out of view (html/body have overflow:hidden)
// when it was mounted unconditionally, making the actual game unreachable
// even though it was running fine underneath.
if (import.meta.env.DEV && trackUrl && new URLSearchParams(location.search).has("debug")) {
  import("./rhythm-debug").then(({ mountRhythmDebugger }) => mountRhythmDebugger(trackUrl, trackName));
}
