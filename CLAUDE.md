# COMP4020 prototype

Your starter repo for a COMP4020 prototype: a static site in HTML/CSS/TypeScript
that builds to plain HTML/CSS/JS and deploys to GitHub Pages. The deployed site
is what gets marked, not this repo.

The
[course website](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/)
publishes this deliverable's brief and spec, and this repo's name tells you
which deliverable applies. Read both before you plan or build.

## How to work in here

- Keep the dev server running (`pnpm dev`) so you see changes as you make them.
- Run `pnpm check` before you push.
- Open the page in a browser and look at it. The rendered page is the truth;
  your mental model of it isn't.
- When a check fails, read its output before you change anything.
- Never commit a red state.

## Auto-commit

Commit automatically whenever a feature is added, removed, or adjusted —
don't wait to be asked each time. A "feature" boundary is a working,
checked increment (e.g. one step of a manual-check sequence below, one
item from `plan.md`'s next-steps list), not every individual file edit.
Still never commit a red state (`pnpm check` must pass first), and this
durable authorization doesn't extend to push, force-push, or history
rewrites — those still need an explicit ask each time.

## Manual checks, one step at a time

`pnpm check` proves internal consistency (types, build, the rules you
thought to write a test for) — not that the thing behaves right against
reality. Anything where correctness is a judgment call rather than a
pass/fail assertion — a generated map, a difficulty curve, timing/feel,
anything parsed or synthesized from real-world input — needs a human to
actually look at or listen to the real output before more gets built on
top of it.

- Break that kind of work into steps small enough that each one produces
  something checkable — a rendering, a number stream, a short recording —
  before starting the next step. Don't chain several unverified
  assumptions together and only check at the end: when it's wrong, you
  won't know which step broke it, and unwinding costs more the longer you
  waited.
- Build a small dev-only tool for the check when a console log or a
  static number isn't enough to judge it — e.g. something that lets a
  human see *and* hear generated output against the real source at the
  same time. Gate it out of the production build (`import.meta.env.DEV`
  or equivalent) and confirm it's actually stripped from `dist/`.
- Ask for the manual check explicitly and wait for the verdict before
  moving to the next step; don't assume a plausible-looking number means
  the step is done.
- When a manual check turns up a problem, check whether the *design* is
  wrong before reaching for a tuning knob — a threshold tweak can hide a
  bad assumption instead of fixing it.

## The stack

Converted to Astro (`comp4020:stack` course default). `astro.config.ts` sets
`site`/`base` from this repo's origin remote; the dev server serves under that
base path too, so a broken relative link shows up locally instead of only on
the deployed URL. There's no shared layout component yet --- if the prototype
grows past one page, factor the shared `<head>` into a `Layout.astro` that
takes `title`/`description`/`card` as props rather than copy-pasting it.

## Astro's scoped styles and JS-created elements don't mix

A page's `<style>` block is scoped by default: Astro stamps a
`data-astro-cid-*` attribute onto the elements in that page's own template
and rewrites the block's selectors to require it. Anything a script creates
at runtime with `document.createElement` never gets that attribute, so any
scoped rule targeting it silently matches nothing — no error, just a page
that looks unstyled. If a component builds part of its DOM in a `<script>`,
give the `<style>` block covering those parts `is:global`, or move those
rules into `global.css`. Check the built page's CSS for an `astro-*` hash on
the rule in question if styles seem to be silently not applying.

## The link-preview card

`public/card.png` (1200x630) is the image a shared link shows; `index.html`'s
head points at it. Replace it and the `description` meta, and copy the head
block into any new page. The card URL resolves against the page that names it,
like any link --- `./card.png` is wrong one directory down, and nothing in CI
checks it, so the deployed head is the only place a broken one shows up.

## The checks

`pnpm check` runs them, and `pnpm check:evidence` is the extra gate before you
ship. CI runs the same plus links, secrets and the deploy.

`spec/README.md`, `PROCESS.md` and `reflections/README.md` are in this repo and
say what they are for.

## Capture process moments as they happen

When a non-obvious approach really helps --- a test flips, a bug stops
recurring, an attempt gets thrown away for a better one --- draft the moment
into `process-notes.md` then, while the why is fresh, not at the end. Note
which kind it is: the strongest moments land the fix in the harness (a
`CLAUDE.md` rule, a wired-up check, a discarded attempt), not in a retry ---
retrying until it passes is the routine case. `PROCESS.md` stays the curated
file --- moments get promoted into it later, by hand, not every draft.

## Phase checkpoints

`plan.md` (once it exists) tracks the stages of the current build. When a
task or phase from it is completed, stop and remind the student to:

1. update `plan.md` with the current state and next steps,
2. run `/clear`,
3. reload context with `@plan.md`.

Do this at each phase boundary, not only at the end.

`plan.md` is a living file with two jobs at once: record the reasoning behind
decisions already made in the code (not just what was built), and hand off
to a fresh agent instance with zero other context — since `/clear` follows
right after every update. Each update should therefore:

- state the current/completed state plus the reasoning behind it, clearly
  enough for a cold reader to understand why, not only what;
- call out the latest agreed-upon direction explicitly, even if
  implementation hasn't started yet;
- give a clear, ordered next step plus the following tasks, so a blank agent
  can act without re-deriving anything;
- stay clearly structured (sections/headings), not a chronological log;
- prune or rewrite stale sections rather than only appending, since the next
  reader has no other context to reconcile against.

## This file is yours

A starting point, not a rulebook: what you add to it is the harness, and the
harness is assessed. This file and the sensors you wire into `check` carry
across the course --- both come with you into next week's repo. The prototype
doesn't: source, and the tests answering this week's published spec, stay
behind. `spec/README.md` draws the line.
