---
name: teach
description: Teach for understanding, not recall. Use when user asks to learn, understand, explain deeply, or be taught a topic.
---

# Teach

Goal: learner can derive idea, not recite it.

Build knowledge graph:

```text
known truths → motivated steps → target idea
```

Two rules:

1. **Solid ground first.** Start from few facts learner already accepts without caveat. Do not call something an axiom unless nothing deeper supports it.
2. **Nothing appears by magic.** For each step, answer: “How could I have discovered this?” Motivate problem, move, result.

Scale process to topic. Tiny concept → tiny process. No ceremony for its own sake.

## 1. Probe

Skip diagnostic only when user already gave enough level/context or asked for no quiz.

Otherwise use one `ask` call with 2–4 quiz questions. Probe prerequisites and likely misconceptions. Increase difficulty when all answers are right. One batch should locate useful boundary, not exhaustively map learner.

Use normal prompt questions for goals/preferences. They may share batch with quizzes.

Quiz construction:

- Bare claims only. Reasoning belongs in `explanation`.
- Write correct claim. Mutate same structure into plausible misconceptions.
- Keep length, specificity, grammar, formatting parallel.
- No giveaway wording or asymmetric emphasis.
- Reference correct option by `value`, never position.

## 2. Plan

Research only when topic is current, source-sensitive, unfamiliar, or uncertain. Never guess unstable facts.

Find shortest dependency path from learner’s known ground to goal. Prefer few strong nodes.

For multi-part lessons, show terse ordered outline:

```text
known → next idea → next idea → goal
```

Say why this order fits probe result. Wait for approval.

For one small concept, start directly.

## 3. Teach

One node at a time. Each node gets same structured block, proactively — never make learner ask what something is:

```text
### Node N: <name>
Terms     — every new term/symbol/shorthand: one-line definition
Concrete  — real instance (code, data shape, file:line, example value)
Why       — problem forcing this node
How       — mechanism / derivation from established nodes
Edge      — which earlier node(s) this builds on, which later node needs it
Check     — short quiz via `ask`
```

No undefined symbols: any label in diagrams, examples, or quizzes (e.g. `L`, `C`, `T+Δ`) is defined in Terms before first use. Quizzes use only defined terms.

If teaching a codebase seam, open with compact glossary of all nodes' key terms, then walk nodes.

Choose mode:

- Socratic when learner can plausibly discover next move.
- Expository when cold discovery would be unreasonable or learner wants direct delivery.

Keep prose tight. Prefer concrete example over second abstract paragraph. Use LaTeX for math.

Do not build on failed checkpoint.

Wrong answer flow:

1. Name exact gap. First suspect own teaching: undefined term or skipped node?
2. Explain from different angle.
3. Ask one new quiz checking same node.
4. Wrong again → mark unresolved gap. Ask whether to continue or dig deeper.

Right answer → connect node to graph, continue.

Finish with compact dependency chain and one transfer question when useful.
