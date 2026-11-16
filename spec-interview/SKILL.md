---
name: spec-interview
description: >
  Runs a structured interview with someone who has an idea for an AI agent
  or automation but hasn't written it down yet, and turns the conversation
  into a clear spec document that any AI builder can work from. Generic —
  not tied to any specific methodology, course, or plugin. Trigger when the
  user says things like "I have an idea for an agent", "help me spec this
  out", "I want to characterize what I'm building", "יש לי רעיון לסוכן",
  "תעזור לי לאפיין", "בוא נעשה שיחת אפיון", "I did this with ChatGPT, can you
  do it here", or describes a project in vague/scattered terms and clearly
  needs structure before anyone can build it.
version: 1.0.0
---

# spec-interview — turn a loose idea into a buildable spec

> Generic, standalone. No dependency on any specific agent-building
> methodology — the output is a plain markdown spec any AI (or human) can
> read and build from.

## What this is for
Someone has an idea for an agent/automation but it's still in their head —
scattered, maybe half-written in notes or a voice memo. This skill runs a
short, structured interview and produces ONE spec document at the end.

**Not for:** writing the actual code/agent/prompt (that's a separate step,
done by whatever builder — human, another skill, another tool — reads the
spec afterward). This skill only produces the spec.

## Ground rules (apply throughout)
- **One question at a time.** Never dump the whole list below at once.
- **Plain language.** No jargon. If the person uses a technical term
  incorrectly or vaguely, ask them to explain it in their own words instead
  of correcting them.
- **Don't invent answers.** If something is unclear, ask — don't guess and
  move on. A wrong guess baked into the spec causes a rebuild later.
- **Reflect back what you heard before moving to the next question**, in one
  short sentence, so they can correct you early and cheaply.
- **Concrete beats abstract.** If an answer is vague ("it should be smart
  about X"), ask for one real example ("walk me through one specific case").

## The interview — 8 questions, in this order

1. **One-line pitch.** "What does this do, in one sentence?" — get their own
   words, don't rephrase it into jargon yet.
2. **Type.** Does this react to a person in conversation (a "partner"/
   assistant they talk to), or does it run on its own on a trigger/schedule
   (a "process"/automation with no one watching)? Some ideas are both — split
   them into two specs if so.
3. **The real problem.** Ask "why" up to 3 times on the pain point, like the
   classic 5-whys — until you hit something concrete, not a symptom. Example
   from a real session: "expenses aren't filed" → "no correlation between
   what was charged and what was filed" → "the real root is no independent
   source of truth for actual charges." That last sentence is what goes in
   the spec, not the first one.
4. **Audience.** Just them? A team? Customers? This single answer changes
   tone, what gets built, and what companion documents (if any) make sense
   later — don't assume a team exists.
5. **Scope boundary — what this explicitly does NOT do.** This is the
   question people skip and regret. Ask directly: "what's adjacent to this
   that you're deliberately NOT asking it to do?" Write down where that
   other work belongs (a separate project, a person, "not yet").
6. **What it needs to know, and where that comes from.** List the concrete
   inputs (files, APIs, a person's answers, history to learn from) — and
   flag anything that "doesn't exist yet" honestly, rather than assuming
   it'll appear.
7. **Decision rule: when does it act alone vs. ask first?** Only relevant if
   the thing makes any judgment calls. Get the actual list of situations
   where it should stop and ask a human, in their words — this becomes the
   single most load-bearing section of the spec.
8. **Success, in one real scenario.** "Walk me through the day this is
   working well — what do you see?" One concrete example beats a list of
   abstract goals. Also ask: what's the one existing example of this
   *already working* elsewhere (if any) — and what's the current worst
   symptom of it *not* working?

## Compiling the spec
After all 8 are answered, write ONE markdown file with this structure —
this exact shape is what makes it portable to any builder:

```markdown
# <name> — spec

## One-line pitch
## Type (partner / process / both)
## Root problem (the "why" chain, ending on the real cause)
## Audience
## Scope boundary — explicitly out of scope, and where that work belongs
## Inputs / knowledge needed (and what's missing today)
## Decision rules — acts alone vs. stops and asks (if applicable)
## Success criteria — one concrete scenario
## Open questions — anything still unresolved, flagged, not guessed
```

Read it back to them section by section before calling it done — not the
whole thing dumped at once. Fix anything that doesn't match what they meant.

## Handing off
This spec is the end of this skill's job. It's meant to be pasted into
whatever builds the thing next — a builder agent, another AI session, a
human developer. Don't start building here unless the person explicitly
asks you to continue past the spec.
