# Crit 5 reflection

**What was the breakthrough that moved the work forward?**

The real breakthrough was realizing I had to stay in the loop at every
step, not just check in at the end. Early on, before there was even a
UI, I sat there and listened to the music while we worked out where
the turning points should go. When I left the AI to tune the turning points on its own, it always got something subtly wrong - too many turns packed together, and opening too hard for a new player. Once I listened by ear and pointed out exactly what felt off, the AI could fixed the real problem instead of guessing again. Checking after every small change also kept us solving one problem at a time instead of several at once.

I also noticed that when claude's responses started drifting from what I actually asked, that usually meant its attention had gotten thin over a long conversation - my cue to clear and start fresh. Much of this project was spent nudging mechanic details by hand instead of writing one fully-specified prompt up front. Both approaches have their own advantages and trade-offs.

**What did this change about who I want to be as a developer?**

Mostly, how much I trust an AI's own word. Early on I had it connect the corridor wall to the collision judgment, and that even got written
into PLAN.md as harness. But when I played the game myself, the collision still felt wrong. Chasing that, I went back and forth on the
corner's shape before finally digging into the logic myself - and
found the wall and the collision check had never actually been tied
together. If the AI says something's fixed, that's a claim, not a
fact, and I want to be a developer who checks before believing it.
