# Crit 5 reflection

**What was the breakthrough that moved the work forward?**

The real breakthrough was realizing I had to stay in the loop at every
step, not just check in at the end. Early on, before there was even a
UI, I sat there and listened to the music while we worked out where
the turning points should go. Left to tune that on its own, the AI
always got something subtly wrong — too many turns packed together, an
opening too hard for a new player. Once I listened by ear and said
exactly what felt off, it fixed the real problem instead of guessing
again. Checking after every small change also kept us solving one
problem at a time instead of several at once.

I also noticed that when its answers drifted from what I actually
asked, that usually meant its attention had gotten thin over a long
conversation — my cue to clear and start fresh. Much of this project
was spent nudging mechanic details by hand instead of writing one
fully-specified prompt up front. Both trade speed against control.

**What did this change about who I want to be as a developer?**

Mostly, how much I trust an AI's own word. Early on I had it wire the
corridor wall to the collision judgment, and that even got written
into PLAN.md as settled. Only once I played the game myself did the
collision still feel off. Chasing that, I went back and forth on the
corner's shape before finally digging into the logic myself — and
found the wall and the collision check had never actually been tied
together. If the AI says something's fixed, that's a claim, not a
fact, and I want to be a developer who checks before believing it.
