# DEUS EX MACHINA
### A Living God Layer for *Onslaught! Arena*

> "What happens when prompts can change the world itself?"
> — Supercell AI Lab, 2026

This is the plan to bolt an **Anthropic-powered deity** onto a 2010-era HTML5 arena game and let *language* — not patches, not configs, not dev builds — rewrite the game while it's being played.

The pitch in one sentence: **the player prays, Claude answers, and the rules of reality bend in real time.**

---

## 1. The Vision

Most "AI in games" today means scripted dialogue or pathfinding. We're doing the inverse: the **rules themselves are the dialogue**. The player speaks, and the world *becomes* their words.

In Onslaught! Arena, the hero defends a gate against fifty waves of enemies. We're going to put a god on top — call her **THE ARCHON** — who watches the carnage and can be petitioned. When the player invokes her, the game pauses, a prayer is composed, and Claude (Sonnet 4.6 with tool use) returns a sequence of *interventions* — mutations to the live game state — that take effect the moment the player un-pauses.

The trick that makes this hackathon-shaped instead of gimmicky: **we don't sandbox a scripting language**. We expose a deliberate, narrow set of *world-editing primitives* as Claude tools. Claude composes them. The game state is the API.

This is the spirit of the brief: **language is the editor**.

---

## 2. The Archon (Persona)

Not a chatbot. A **character**.

- **Voice:** mythic, capricious, slightly bored. Speaks in the third person about the player. Granted wishes always come with a twist she finds amusing.
- **Visual:** no portrait. She manifests as **golden subtitle text** drawn over the canvas in MedievalSharp, accompanied by a low brass sting.
- **Costs:** every prayer costs *gold* (the existing currency). Bigger miracles cost more. The god is paid.
- **Memory:** remembers prior prayers within a run. References them. ("You asked for fire last time. You drowned in it. Try again.")
- **Whim:** if the player goes too long without praying, the Archon **intervenes unbidden** with a small, often unhelpful change. "You bored me."

This persona constraint is what keeps the system *fun* instead of an admin console with extra steps.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      THE GAME (existing)                  │
│   engine.js  ⇄  horde.objectTypes  ⇄  waves  ⇄  player    │
└───────────────────────▲──────────────────────────┬───────┘
                        │                          │
              snapshot/observe              mutate via tools
                        │                          │
┌───────────────────────┴──────────────────────────▼───────┐
│                    js/god/  (new module)                  │
│                                                           │
│   god.js          orchestrator, public API                │
│   ui.js           prayer overlay + Archon subtitles       │
│   client.js       Anthropic Messages API wrapper          │
│   tools.js        tool schema + primitive mutations       │
│   intervention.js scheduler (prayers + unbidden whims)    │
│   state.js        snapshot / rollback for safety          │
│   presets.js      offline miracle cards (demo fallback)   │
│   persona.js      system prompt + Archon voice            │
│   config.js       API key, model, limits                  │
└───────────────────────────────────────────────────────────┘
```

**Three rules that make this modular:**

1. **The god module never imports from the game.** It only touches `window.horde` and the engine instance. Removing the entire `js/god/` directory leaves the original game running unchanged.
2. **All mutations go through `tools.js`.** No tool, no change. This is the security model *and* the audit log.
3. **The engine exposes hooks, not internals.** We add a thin `horde.god.bus` event bus to engine.js — `wave_started`, `wave_cleared`, `player_damaged`, `enemy_killed` — and the god subscribes. Engine doesn't know who's listening.

---

## 4. The Tool API — the Heart of It

This is where the hackathon thesis lives. Claude doesn't write JavaScript. Claude composes **world-editing primitives** that we've validated, bounded, and made reversible.

Every tool returns a `MutationReceipt` (`{tool, args, undo}`) which the god stores so it can roll back if a prayer breaks the game.

### Core primitives

| Tool | What it does | Example |
|---|---|---|
| `set_property(target, path, value)` | Mutate any property on a registry type or live entity | `set_property("goblin", "speed", 200)` |
| `multiply_property(target, path, factor)` | Scale a numeric stat | `multiply_property("*", "speed", 0.5)` (slow-mo for everyone) |
| `define_type(name, base, overrides)` | Create a new entity type by extending an existing one | `define_type("ghost_goblin", "goblin", {alpha: 0.3, speed: 200})` |
| `spawn(type, x, y, count)` | Drop entities into the arena | `spawn("dragon", 320, 100, 1)` |
| `inject_wave(points)` | Insert a wave at the next slot | `inject_wave([{point: 1, type: "bat", count: 99, delay: 100}])` |
| `grant_weapon(type, ammo)` | Hand the player a weapon | `grant_weapon("h_fireball", 50)` |
| `apply_state(target, state, ms)` | Stun, invincible, invisible | `apply_state("hero", "INVINCIBLE", 10000)` |
| `set_time_scale(factor)` | Bullet-time. Wraps `horde.now()` | `set_time_scale(0.3)` |
| `set_render_filter(name, params)` | CSS filter on the canvas | `set_render_filter("hue-rotate", {deg: 180})` |
| `swap_music(trackId)` | Change the score | `swap_music("final_battle_music")` |
| `remap_input(from, to)` | Mess with controls | `remap_input("W", "S")` |
| `set_loot_table(type, drops)` | Rewrite what dies into what | `set_loot_table("goblin", [{type:"item_food", chance:1}])` |
| `set_behavior(type, behavior)` | Swap an entity's `onUpdate` for a named preset | `set_behavior("bat", "flee")` |
| `narrate(text)` | The Archon speaks | `narrate("You wanted fire. Now you are it.")` |
| `undo(receiptId)` | Reverse a prior mutation | `undo("rcpt_42")` |

### Why this list specifically

Each maps cleanly onto a hook surface I confirmed in the codebase:

- `set_property` / `multiply_property` → `horde.objectTypes` is a plain mutable dict ([js/object_types.js:3](js/object_types.js#L3))
- `define_type` → factory copies properties at spawn ([js/base.js:193](js/base.js#L193))
- `spawn` → `engine.addObject(horde.makeObject(type))` works at any moment
- `inject_wave` → `engine.waves[]` is a plain array; `initSpawnWave` is callable
- `apply_state` → `obj.addState(state, ttl)` already exists ([js/object.js:161](js/object.js#L161))
- `set_time_scale` → wrap `horde.now()` ([js/base.js](js/base.js))
- `set_behavior` → entity `onUpdate` is overridable per-instance
- `swap_music` → `horde.sound.stop` / `play` on `engine.currentMusic`

**No new game logic needed.** The hooks already exist. The god just *uses* them.

### The behavior preset library

`set_behavior` is the most powerful tool. It accepts a *named* preset, not arbitrary code, so Claude can't sandbox-escape. Presets we ship:

- `chase` (default monster behavior)
- `flee` (run from player)
- `patrol` (ignore player, walk in circles)
- `dance` (random direction every 200ms)
- `mirror` (copy player's input direction)
- `kamikaze` (chase + explode on contact)
- `pacifist` (move but never attack)
- `coward` (flee when hp < 50%)
- `swarm` (cluster toward nearest ally)

When the player asks for something we don't have, Claude composes existing presets via `set_property` flags or politely declines in character. ("That is beyond my domain. Ask differently.")

---

## 5. Activation Flows

### Flow A — Prayer (player-initiated)

1. Player presses **`P`** (or yells "GOD" — speech-to-text optional stretch goal).
2. `engine.togglePause()` — game freezes (existing mechanism).
3. UI overlay fades in: a parchment-styled prompt box, gold cost displayed.
4. Player types a prayer: *"make my sword shoot fire"*.
5. We deduct gold (cost scales with prompt length / past prayer frequency).
6. **`client.js`** sends to Claude:
   - System prompt (`persona.js` — establishes Archon voice + lists every tool)
   - Compact game state snapshot (current wave, hp, weapons, alive enemies)
   - Conversation history (prior prayers this run)
   - User's prayer
   - Tool list from `tools.js`
7. Claude streams response. Tool calls execute *as they stream* — the world starts changing before the god finishes speaking.
8. `narrate()` calls render as subtitles. Brass sting on the first one.
9. Pause auto-releases. Game resumes mid-mutation.

### Flow B — Whim (god-initiated)

A heartbeat in `intervention.js` fires every 30–60 seconds of real play. If the Archon is bored (low recent prayer rate), she takes a snapshot of game state, asks Claude *"What would amuse you?"* with the same toolset, and acts. Examples that came out in early testing:

- Replaces every projectile sprite with a coin for 10 seconds. Doesn't change damage.
- Promotes the smallest enemy on screen to a boss. Just that one.
- Inverts the floor. The hero is now upside-down. (`set_property("hero", "angle", 180)`)

### Flow C — Reaction (event-driven)

The bus emits `player_low_hp` at 10%. The god *might* intervene with a heal — for a price added to the running tab, payable next prayer. Or might mock the player. Roll determined by Claude.

---

## 6. The Insanity Catalog

Things that should be possible *on day one* without any new tools, just by composing the primitives above:

### Mechanical
- **"Make me fast"** → `multiply_property("hero", "speed", 2.0)`
- **"All enemies are babies"** → `multiply_property("monster:*", "size", 0.5)` + `multiply_property("monster:*", "hitPoints", 0.3)`
- **"Reverse my controls"** → `remap_input("W","S")`, `remap_input("A","D")`
- **"Pacifist run"** → `set_behavior("monster:*", "pacifist")` + `multiply_property("hero", "damage", 0)` — now you have to *survive*, not kill.
- **"Bullet hell mode"** → `multiply_property("e_*", "speed", 0.4)` + `multiply_property("monster:*", "cooldown", 0.2)` — slower projectiles, way more of them.

### World-bending
- **"Make it night"** → `set_render_filter("brightness", {value: 0.3})` + `swap_music("final_battle_music")`
- **"Underwater"** → `set_render_filter("hue-rotate", {deg: 200})` + `multiply_property("*", "speed", 0.6)`
- **"It's snowing"** → spawn loop of decorative `cloud` objects with downward drift

### Mythic
- **"Boss rush"** → `inject_wave([{point:1, type:"dragon", count:1}, {point:0, type:"cube", count:1}, {point:2, type:"superclops", count:1}])`
- **"Be the dragon"** → `define_type("hero_dragon", "dragon", {team:0, role:"hero"})` + `set_property("hero", "spriteSheet", "characters_dragon")` + grant breath weapon
- **"Resurrect everyone"** → re-spawn last 5 killed enemies but on the player's team. They follow.

### Meta
- **"Show me wave 50"** → `set_property("engine", "currentWaveId", 49)`
- **"Slow time when I'm hit"** → register a bus subscription that calls `set_time_scale(0.3)` for 800ms on `player_damaged`. The god is now scripting the engine *for the duration of the run*.
- **"Make goblins drop dragons"** → `set_loot_table("goblin", [{type:"dragon", chance:0.05}])` — this is genuinely cursed and exactly the point.

The catalog isn't exhaustive. It's a *seed*. The system is generative — the player's prompts will surface combinations we never thought of, and that's the demo.

---

## 7. What We Have to Change in Existing Code

Tightly scoped. The game stays the game.

### `index.html`
- Add `<div id="god-ui">` overlay element.
- Load `js/god/*.js` files after `run_game.js`.

### `js/engine.js`
Three small additions:

1. **Expose engine globally** — `window.engine = this` at end of constructor (or stash on `horde.engine`). Currently it's a closure local. *(~1 line)*
2. **Event bus emit calls** — sprinkle `horde.god?.bus.emit(...)` in: `dealDamage`, `updateWaves` (wave start/end), `objectAttack`, `getPlayerObject().wound`. Guarded by optional chaining so the game runs without the god module. *(~10 lines total)*
3. **Time-scale hook** — replace direct `horde.now()` reads with `horde.god?.timeScaled(now) ?? now` in the main `update()` loop. *(~2 lines)*

### `js/base.js`
- Add `horde.god` namespace stub (`{}`) so `?.` checks resolve cleanly even when the module isn't loaded. *(~1 line)*

### `js/object_types.js` and `js/waves_full.js`
**Zero changes.** The registry is already open. The wave array is already mutable.

That's it. The rest is new code in `js/god/`.

---

## 8. Safety Rails

A god that softlocks the game isn't fun, it's a bug. We bound everything.

- **Numeric clamps in tools.** `set_property("hero", "speed", 99999)` → silently clamped to a sane range. The receipt records both intended and applied values; the Archon may comment on the difference.
- **Type whitelist for `set_property`.** Only known properties on known targets. No clobbering `engine.update`.
- **Mutation budget per prayer.** Default 5 tool calls. Big-prayer flag raises it. Prevents Claude from spiraling.
- **Snapshot before mutation.** `state.js` deep-clones the relevant slice (`objectTypes`, `engine.waves`, live entity stats) before tool execution. `undo` reverts to it.
- **Fatal-state guard.** After each tool call: is the player still alive, is there a path to win, is the framerate above 20fps? If not, auto-undo the last call and have the Archon laugh.
- **Rate limit on whims.** Max 1 unbidden intervention per minute. Player can disable in pause menu.
- **API failure path.** If Anthropic call fails, fall back to `presets.js` — a hand-written list of 20 miracle cards keyed by simple keyword matching. Demo never dies because the network does.

---

## 9. Implementation Phases

### Phase 1 — Foundation (half a day)
- `js/god/` skeleton, all eight files with stubs.
- Engine hooks (the four small edits above).
- Prayer overlay UI in `ui.js` — pure DOM/CSS, no Claude yet.
- Five tools wired and tested manually from the console: `set_property`, `multiply_property`, `spawn`, `apply_state`, `narrate`.
- **Demo-able state:** player presses P, types a hard-coded JSON tool call, world changes.

### Phase 2 — The God Speaks (half a day)
- `client.js` — Anthropic Messages API call with tool use + streaming.
- `persona.js` — system prompt iterated until the Archon sounds *right*.
- All 15 tools from §4 wired.
- Gold cost system. Prayer history. Subtitle rendering.
- **Demo-able state:** player prays in natural language, Archon responds in voice and the world changes.

### Phase 3 — Whims & Reactions (a few hours)
- `intervention.js` — boredom timer + bus subscriptions.
- Behavior preset library in `tools.js`.
- Snapshot/undo plumbing.
- Preset miracle fallback for offline.

### Phase 4 — Polish (a few hours)
- Brass sting + parchment overlay art.
- "Past prayers" UI in pause menu — every mutation is a receipt; the player can read what the Archon did.
- Demo script (see §10).
- README with API key setup.

Total: roughly two days of focused work. Phase 1 is the demo floor; everything after is depth.

---

## 10. The Demo Script

A 90-second pitch. The story is what sells it; the tech is the punchline.

1. **Wave 1 starts.** Three bats. Hero swings a sword. Looks like a 2010 Flash game. (5s)
2. Player presses **P**. Game pauses. Parchment unfurls. Player types: ***"this is too easy"***. (10s)
3. Brass sting. Subtitle in gold MedievalSharp: *"You doubt me? Then doubt yourself."* The hero's controls invert. Three more waves of bats spawn. (10s)
4. Player struggles. Presses P again. ***"give me fire and i'm sorry"***. (10s)
5. Subtitle: *"Apology accepted. Fire is yours. So is the dragon."* Player gets a fireball weapon AND a friendly dragon spawns next to them. Controls revert. The dragon kills the bats. (15s)
6. Wave 5. Player types: ***"make the next boss a goblin but huge and the goblins drop dragons"***. (10s)
7. Two seconds of subtitles. Then: a 4x-scale goblin marches in. Player kills a normal goblin — a dragon falls out. Cascading chaos. (15s)
8. Final beat: presenter steps back. **"None of this was scripted. The game shipped in 2010. The Archon is Claude with twelve tools and a system prompt. The world is a registry; language is the editor."** (15s)

That last line is the deliverable.

---

## 11. Why This is the Right Plan

The brief asks: *what does it look like when language can edit runtime systems?*

Most answers to that question reach for sandboxes — give the LLM a Lua interpreter, a Python eval, a hand-rolled DSL. We're going the other way. We're saying: **the world is already a tree of plain-old data, with a few function pointers for behavior.** A registry of types. An array of waves. A bag of properties on a player object. The engine doesn't need a scripting layer because the engine already *is* the scripting layer — we just have to expose the right verbs.

The tool API is the thesis. Each tool is a sentence the god can say *to the world*. Claude composes sentences into miracles. The player composes prayers into chaos. The game composes chaos into a story.

That's what it looks like when language edits runtime systems. It looks like prayer.

---

*"Praise her, fear her, but do not bore her."* — The Codex of the Archon, vol. I
