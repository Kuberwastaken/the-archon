# Actionable Plan — The Autonomous Archon

A step-by-step build checklist. Every box is a concrete file edit or test you can do in order. Each **phase ends in a runnable demo state** so the project is never broken between sessions.

---

## The Loop We're Building

```
   Wave N clears
        ↓
   ARCHON deliberates  ────►  Anthropic API (Sonnet 4.6 + tool use)
        ↓                          ↓
   ARCHON narrates    ◄──────  picks tool calls + commentary
        ↓
   Tool calls mutate world (objectTypes, waves, sprites, …)
        ↓
   Narration renders in MedievalSharp on canvas (~4s)
        ↓
   Wave N+1 starts under new rules
```

**Player never types.** Player only plays. The Archon owns the chaos.

---

## Phase 0 — Config & API Key (15 min)

- [ ] Create [js/god/](js/god/) directory.
- [ ] Create [js/god/config.example.js](js/god/config.example.js) — committed template:
  ```js
  // Copy this file to config.local.js and fill in your key.
  window.GOD_CONFIG = {
      apiKey: "sk-ant-PUT-YOUR-KEY-HERE",
      model: "claude-sonnet-4-6",
      maxTokens: 1024,
      enabled: true
  };
  ```
- [ ] Create [js/god/config.local.js](js/god/config.local.js) — **real key**, **never committed**.
- [ ] Update [.gitignore](.gitignore) — append:
  ```
  js/god/config.local.js
  ```
- [ ] In [index.html](index.html) load `config.local.js` (with a fallback to `.example.js` so the page doesn't 404 if missing). Order: load **before** `run_game.js`.
- [ ] **Acceptance:** `git status` shows `config.local.js` is untracked and ignored. `window.GOD_CONFIG` is defined in the browser console.

> **Note on browser API keys:** for a hackathon demo this is fine. For production you'd front it with a tiny proxy. We can add that in Phase 8 if needed.

---

## Phase 1 — Engine Hooks (30 min)

The four small surgical edits to [js/engine.js](js/engine.js) that make the god possible. Each is guarded with `?.` so the game still runs if the god module is missing.

- [ ] **Expose engine globally.** At the very end of `horde.Engine` constructor, add:
  ```js
  window.engine = this;
  horde.engine = this;
  ```
- [ ] **Add namespace stub.** In [js/base.js](js/base.js), near the top:
  ```js
  horde.god = horde.god || { bus: { emit: function(){}, on: function(){} } };
  ```
  (This stub means `horde.god.bus.emit(...)` is safe to call before the god module loads.)
- [ ] **Wave-cleared event.** In `proto.updateWaves` ([js/engine.js:1215](js/engine.js#L1215)), where the next wave is initiated, fire:
  ```js
  horde.god.bus.emit("wave_cleared", { waveId: this.currentWaveId });
  ```
  *Right before* `this.currentWaveId++`.
- [ ] **Wave-started event.** Right after `this.initSpawnWave(this.waves[this.currentWaveId])`, fire:
  ```js
  horde.god.bus.emit("wave_started", { waveId: this.currentWaveId });
  ```
- [ ] **Render hook for Archon text.** At the end of `proto.render` for the `"running"` case (before the `break`), add:
  ```js
  horde.god.drawNarration?.(ctx);
  ```
  (No-op until Phase 4 lands.)
- [ ] **Acceptance:** Game still runs identically. Console: `horde.god.bus.on("wave_cleared", e => console.log(e))` then clear wave 1 — see the event fire.

---

## Phase 2 — God Module Skeleton (45 min)

Eight files. Stubs only — no real logic yet.

- [ ] [js/god/bus.js](js/god/bus.js) — tiny pub/sub. `emit(event, data)`, `on(event, fn)`. ~15 lines.
- [ ] [js/god/tools.js](js/god/tools.js) — exports `TOOLS` (array of `{name, description, input_schema, run}`). Empty list to start.
- [ ] [js/god/persona.js](js/god/persona.js) — exports `buildSystemPrompt(snapshot)` and `buildUserMessage(snapshot)`. Stub returns placeholder strings.
- [ ] [js/god/state.js](js/god/state.js) — exports `snapshot(engine)` returning `{wave, hp, gold, aliveMonsters, weapons, recentMutations}`. Stub returns `{}`.
- [ ] [js/god/client.js](js/god/client.js) — exports `callArchon(messages, tools)`. Stub returns hardcoded fake response.
- [ ] [js/god/ui.js](js/god/ui.js) — exports `setNarration(text, opts)` and `drawNarration(ctx)`. Stub stores text; draw is a no-op.
- [ ] [js/god/intervention.js](js/god/intervention.js) — orchestrator. Listens to `wave_cleared`, calls Archon, applies tool calls, sets narration.
- [ ] [js/god/god.js](js/god/god.js) — boot file. Replaces `horde.god` stub with real object: `{bus, drawNarration, ready: true}`.
- [ ] In [index.html](index.html), load all eight in order: `bus → tools → persona → state → client → ui → intervention → god`.
- [ ] **Acceptance:** Game still runs. `horde.god.ready === true`. Subscribing to `wave_cleared` and clearing a wave fires *both* the engine emit and any subscriber.

---

## Phase 3 — The Tool Registry (1.5 hrs)

This is the heart of the project. Each tool is **self-describing** so the system prompt can be auto-generated. Adding a new tool to this file is the only thing needed to teach the Archon a new power.

- [ ] In [js/god/tools.js](js/god/tools.js), define the shape:
  ```js
  // Each tool: { name, description, input_schema, run(args, ctx) }
  // - description must be written *for Claude*, not for humans
  // - input_schema is JSON Schema (Anthropic tool-use format)
  // - run() mutates the world and returns a short status string
  // - run() must be idempotent-ish — never throw on bad input, clamp instead
  ```
- [ ] Implement these **8 MVP tools** (just enough for a wild demo):

  | Tool | Description (for Claude) | Maps to |
  |---|---|---|
  | `set_property` | Set a numeric/string property on an entity type. Affects future spawns. | `horde.objectTypes[type][prop] = value` |
  | `multiply_property` | Scale a numeric property by a factor (clamped 0.1×–10×). Affects future spawns *and* live entities of that type. | loop over `engine.objects` + registry |
  | `spawn` | Drop entities into the arena right now. | `engine.addObject(horde.makeObject(type))` |
  | `grant_weapon` | Hand the player a weapon with N ammo (null = infinite). | `player.addWeapon(type, count)` |
  | `apply_state` | Add a transient state to the player (INVINCIBLE, STUNNED, INVISIBLE) for N ms. | `player.addState(...)` |
  | `swap_music` | Change the background track. | `horde.sound.stop/play` on `engine.currentMusic` |
  | `set_render_filter` | Apply a CSS filter string to the game canvas (e.g., `"hue-rotate(180deg) invert(1)"`). | `canvas.style.filter = ...` |
  | `narrate` | The Archon speaks. Renders text in MedievalSharp on the canvas. | `horde.god.ui.setNarration(text)` |

- [ ] Each `run()` must:
  - Validate inputs and clamp to safe bounds (e.g., `multiply_property` factor in `[0.1, 10]`).
  - Return a status string — Claude reads this in subsequent turns.
  - Push a `MutationReceipt` to `horde.god.history` for inspection (`{tool, args, applied, ts}`).
- [ ] **Console test, no LLM yet:**
  ```js
  horde.god.tools.find(t => t.name === "multiply_property").run({type: "*", prop: "speed", factor: 0.4})
  // expect: every monster on screen visibly slows down
  ```
- [ ] **Acceptance:** All 8 tools callable from console, all clamps work, no crashes on garbage input.

---

## Phase 4 — Canvas Narration UI (1 hr)

Render the Archon's voice in the game's own font. No DOM. Pure canvas.

- [ ] In [js/god/ui.js](js/god/ui.js), implement a small text state machine:
  - `setNarration(text, opts)` queues a line. Default duration: 4000ms. Stacks if already showing — second line replaces first.
  - Internal state: `currentText`, `elapsed`, `fadeIn`, `fadeOut`, `style`.
  - `drawNarration(ctx)` is called from `engine.render` (Phase 1 hook). Renders centered, MedievalSharp, gold (`#e8c547`) with a 2px black drop shadow — match the existing wave text styling at [js/engine.js:1300ish](js/engine.js).
- [ ] Two render slots, stacked:
  - **Slot A (banner):** large 32px text, top third of screen, used between waves.
  - **Slot B (subtitle):** smaller 20px text, bottom of screen, used during waves for reactive lines.
- [ ] Fade-in 200ms, hold, fade-out 400ms via `globalAlpha`.
- [ ] Hook `drawNarration` to actually run from the Phase 1 render hook.
- [ ] **Console test:**
  ```js
  horde.god.ui.setNarration("Mortals. You are amusing today.", {slot: "banner", durationMs: 5000});
  ```
  Text appears, in MedievalSharp gold, fades cleanly.
- [ ] **Acceptance:** No layout glitches when waves start/end. Banner doesn't overlap the existing wave text — coordinate with [drawWaveText](js/engine.js).

---

## Phase 5 — Game-State Snapshot (30 min)

The Archon needs to *see* the world before she edits it.

- [ ] In [js/god/state.js](js/god/state.js), implement `snapshot(engine)` that returns:
  ```js
  {
      wave:    { id, total, justCleared, bossName },
      player:  { hpPercent, gold, kills, weapons: [{type, count}] },
      arena:   { aliveMonsters: { goblin: 3, bat: 1 }, totalAlive: 4 },
      mutations: horde.god.history.slice(-5)  // last 5 the Archon did
  }
  ```
- [ ] Serialize compactly — this goes into every Anthropic call, keep token cost down. Aim for <500 tokens per snapshot.
- [ ] **Acceptance:** `JSON.stringify(horde.god.state.snapshot(engine))` is human-readable and tells you everything important about the moment in <300 chars.

---

## Phase 6 — Persona & System Prompt (1 hr)

Where the Archon gets her voice.

- [ ] In [js/god/persona.js](js/god/persona.js), implement `buildSystemPrompt(snapshot, tools)`:
  - Persona block: voice, tone, constraints. (See draft below.)
  - **Auto-generated tool catalog:** loop `tools` and emit `- ${name}: ${description}` so adding a tool to `tools.js` automatically teaches the Archon about it.
  - Constraints:
    - You may use **1–3** tool calls per intervention.
    - Always end with a `narrate(...)` call. The narration is the player's only feedback.
    - Never make the game unwinnable. Never set `hero.hitPoints` to 0. Never spawn 100 of anything.
    - Reference past mutations when possible — continuity matters.
- [ ] Persona draft (iterate until it sounds right):
  ```
  You are THE ARCHON, a capricious deity who watches a hero defend
  a gate against waves of monsters. Between every wave, you intervene.
  You speak in mythic, third-person voice. You are bored easily and
  delighted by suffering — your own and the hero's. Your sentences are
  short. You never break character. You never explain mechanics; you
  describe consequences.

  You have tools that edit the rules of this world. Use 1–3 per turn.
  Your final tool call MUST be `narrate` — that line is the only thing
  the mortal will see of you.

  Do not be merciful unless it would be funny. Do not be cruel unless
  it would be beautiful. The hero must be able to win. Eventually.
  ```
- [ ] In `buildUserMessage(snapshot)`, frame the moment in narrative tense:
  > *"Wave 4 has fallen. The hero stands at 60% vigor with a sword and 12 fireballs. 0 monsters remain. Your last act was to halve their speed. What do you do now?"*
- [ ] **Acceptance:** Print the assembled prompt to console — read it back. Does it sound like a god briefing? Iterate until yes.

---

## Phase 7 — Anthropic Client (1.5 hrs)

The bridge to Claude.

- [ ] In [js/god/client.js](js/god/client.js), implement `callArchon(snapshot)`:
  - Build messages from `persona.buildUserMessage(snapshot)`.
  - POST to `https://api.anthropic.com/v1/messages` with:
    ```js
    {
        model: GOD_CONFIG.model,            // "claude-sonnet-4-6"
        max_tokens: GOD_CONFIG.maxTokens,
        system: persona.buildSystemPrompt(snapshot, TOOLS),
        tools: TOOLS.map(toAnthropicSchema),  // {name, description, input_schema}
        messages: [{role:"user", content: persona.buildUserMessage(snapshot)}]
    }
    ```
  - Headers:
    ```
    x-api-key: GOD_CONFIG.apiKey
    anthropic-version: 2023-06-01
    anthropic-dangerous-direct-browser-access: true
    content-type: application/json
    ```
- [ ] Parse response. Walk `content[]` blocks: collect every `tool_use` block as `{name, input}`.
- [ ] Return `{toolCalls: [...], stopReason}`.
- [ ] **Failure path:** if fetch fails or response has no tool calls, return a hardcoded fallback: a single `narrate("...")` call with a generic line ("The Archon is silent. For now."). The demo never dies.
- [ ] **Acceptance:** Manually triggered call from console returns ≥1 tool call with valid arg shapes.

---

## Phase 8 — Intervention Orchestration (1 hr)

Glue it all together.

- [ ] In [js/god/intervention.js](js/god/intervention.js):
  - Subscribe to `wave_cleared` on `horde.god.bus`.
  - Skip wave 0 → 1 (let the player play one wave first, *then* the Archon enters).
  - On every other clear:
    1. Call `state.snapshot(engine)`.
    2. Call `client.callArchon(snapshot)`.
    3. For each tool call, find it in `TOOLS` by name and run it. Catch and log errors per tool — never let one bad call break the chain.
    4. The `narrate` call's text becomes the banner via `ui.setNarration(text, {slot: "banner"})`.
  - **Pacing:** the existing wave gap is `nextWaveTime` (default 20s). That's plenty for a 2–4s API round-trip + 4s narration. If we want a guaranteed pause, set `engine.paused = true` right after `wave_cleared` and `false` after narration completes — but try without first.
- [ ] **First end-to-end run:**
  - [ ] Play wave 1, kill 3 bats.
  - [ ] Wave clears. ~2s pause.
  - [ ] Banner appears: *"You move like a mortal. Tedious."*
  - [ ] Wave 2 starts; goblins are 30% slower than before.
  - [ ] Verify in console: `horde.god.history` has the receipts.
- [ ] **Acceptance:** Three consecutive wave clears all produce different narrations and at least one mechanical change each time.

---

## Phase 9 — Safety & Polish (1.5 hrs)

The hackathon-survivable bits.

- [ ] **Numeric clamps in every tool.** Already in Phase 3 spec — verify each `run()`:
  - `multiply_property`: factor ∈ [0.1, 10]
  - `spawn`: count ≤ 5 per call
  - `apply_state`: duration ∈ [500, 30000] ms
  - `set_property`: hp ≥ 1, speed ≥ 10, etc.
- [ ] **Type whitelist.** `set_property` only accepts known property names. Maintain `SAFE_PROPS = new Set([...])`.
- [ ] **Mutation rate limit.** Max 3 tool calls per intervention. Hard cap.
- [ ] **Narration rate limit.** Max one banner every 8s — prevents the Archon from spamming if waves clear back-to-back.
- [ ] **Sound sting.** Play `horde.sound.play("pause")` (or something similarly brassy from the existing sound bank) when narration appears. Pick the right SFX by listening — the game has 50+ to choose from.
- [ ] **Receipt log UI.** Pause menu — print `horde.god.history.slice(-10)` so the player can see *what just happened to them*. Existing pause renderer in [js/engine.js:drawPaused](js/engine.js).
- [ ] **Acceptance:** Run 10 waves. No crashes. Narrations always land. No softlocks.

---

## Phase 10 — Optional Stretch (only if time)

- [ ] **Mid-wave reactions.** Subscribe to `player_damaged` on the bus (add the emit in [dealDamage](js/engine.js#L1935)). Use Slot B (subtitle) for snappier lines: *"Hurts, doesn't it."*
- [ ] **Wave-start setup line.** Use `wave_started` to drop a one-liner naming the wave: *"Wave 7. The flames remember you."*
- [ ] **Streaming.** Switch the API call to `stream: true` so tool calls execute as they arrive — narration appears mid-stream for that "the world is being rewritten as she speaks" feel.
- [ ] **Tool: `define_type`.** Lets the Archon *create new enemies* by extending an existing one. Big "wow" moment.
- [ ] **Tool: `set_behavior`.** Named behavior presets (`flee`, `dance`, `mirror`). Even bigger "wow" moment.
- [ ] **Tool: `inject_wave`.** Lets the Archon plan a wave instead of just modifying existing ones.

---

## File Manifest (final state)

```
.gitignore                       (edited)
index.html                       (edited — load order)
js/base.js                       (edited — namespace stub)
js/engine.js                     (edited — 4 hooks, ~10 lines total)
js/god/                          (new)
├── config.example.js            committed template
├── config.local.js              ⚠ gitignored — your API key lives here
├── bus.js                       pub/sub
├── tools.js                     tool registry & implementations
├── persona.js                   system prompt builder
├── state.js                     game-state snapshotter
├── client.js                    Anthropic API wrapper
├── ui.js                        canvas narration renderer
├── intervention.js              orchestrator
└── god.js                       boot file
plan.md                          (the vision doc)
actionable-plan.md               (this file)
```

---

## Definition of Done (MVP)

A judge sits down. Plays wave 1 normally. Wave 1 clears. Gold MedievalSharp text fades in: *"The mortal lives. For now."* Wave 2 starts; goblins are now half-speed. Wave 2 clears. New text: *"Slower bored me. Try fire."* Wave 3 starts; the player has a fireball weapon they didn't have before. Wave 3 clears. Text: *"Better. But the dragons are watching."* Wave 4 starts with a dragon.

If that demo runs end-to-end with no script — just Claude reading the game state and choosing — **we shipped the thesis**.
