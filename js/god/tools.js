/**
 * THE ARCHON — tool registry.
 *
 * Each tool is a verb the Archon can speak to the world. The Anthropic
 * Messages API tool-use spec maps to:
 *   { name, description, input_schema }
 * We extend that with `run(args, ctx)` which actually mutates the game.
 *
 * Adding a new tool here is the ONLY thing needed to teach the Archon
 * a new power. The system prompt is auto-generated from this list.
 *
 * Every run() must:
 *   - Validate / clamp inputs (never throw on garbage)
 *   - Return a short string describing what happened (Claude reads it)
 *   - Push a MutationReceipt to window.HORDE_GOD.history
 */
(function () {

	// --------- Whitelists -----------------------------------------------------

	// Properties that set_property / multiply_property are allowed to touch.
	// Anything else is rejected with a status string explaining why.
	var SAFE_PROPS = {
		speed:      { min: 10,    max: 500,   type: "number" },
		hitPoints:  { min: 1,     max: 1000,  type: "number" },
		damage:     { min: 1,     max: 100,   type: "number" },
		cooldown:   { min: 50,    max: 5000,  type: "number" },
		worth:      { min: 0,     max: 10000, type: "number" },
		alpha:      { min: 0,     max: 1,     type: "number" },
		angle:      { min: -360,  max: 360,   type: "number" },
		moveChangeDelay: { min: 50, max: 5000, type: "number" }
	};

	var SAFE_STATES = {
		INVINCIBLE: 5,
		INVISIBLE: 6,
		STUNNED: 9
	};

	var SAFE_MUSIC = ["normal_battle_music", "final_battle_music", "victory"];

	var SPAWN_LOCATIONS = ["center", "left", "right", "top", "random"];

	// Entity types Claude can target. Conservative subset known to be safe to
	// mutate / spawn. The schema enum keeps the model from inventing types.
	var KNOWN_MONSTERS = [
		"bat", "dire_bat", "goblin", "hunter_goblin", "demoblin",
		"flaming_skull", "huge_skull", "cyclops", "superclops",
		"imp", "wizard", "sandworm", "owlbear", "gel", "cube",
		"dragon", "doppelganger", "beholder", "minotaur"
	];

	var KNOWN_WEAPONS = [
		"h_sword", "h_knife", "h_spear", "h_fireball",
		"h_axe", "h_fire_sword", "h_fire_knife", "h_firebomb"
	];

	var KNOWN_ITEMS = ["item_food", "item_coin", "item_chest"];

	var KNOWN_TARGETS = ["hero"]
		.concat(KNOWN_MONSTERS)
		.concat(KNOWN_WEAPONS)
		.concat(KNOWN_ITEMS)
		.concat(["monster:*", "weapon:*"]);

	// --------- Helpers --------------------------------------------------------

	function clamp(n, min, max) {
		n = Number(n);
		if (!isFinite(n)) return min;
		return Math.max(min, Math.min(max, n));
	}

	function record(tool, args, result) {
		window.HORDE_GOD.history = window.HORDE_GOD.history || [];
		window.HORDE_GOD.history.push({
			tool: tool,
			args: args,
			result: result,
			ts: Date.now()
		});
	}

	function getEngine() {
		return window.engine || (window.horde && window.horde.engine);
	}

	function resolveTargets(target) {
		// Resolves a target string to a list of registry type names.
		if (!target) return [];
		if (target === "monster:*") return KNOWN_MONSTERS.slice();
		if (target === "weapon:*") return KNOWN_WEAPONS.slice();
		if (horde.objectTypes && horde.objectTypes[target]) return [target];
		return [];
	}

	function applyToLiveEntities(typeNames, fn) {
		var engine = getEngine();
		if (!engine || !engine.objects) return 0;
		var count = 0;
		var typeSet = {};
		for (var i = 0; i < typeNames.length; i++) typeSet[typeNames[i]] = true;
		for (var id in engine.objects) {
			var o = engine.objects[id];
			if (!o) continue;
			if (typeSet[o.type]) {
				fn(o);
				count++;
			}
		}
		return count;
	}

	function spawnLocationToVector(loc) {
		var jitter = function (n) { return n + Math.floor((Math.random() - 0.5) * 60); };
		switch (loc) {
			case "left":   return { x: 80,  y: 240 };
			case "right":  return { x: 560, y: 240 };
			case "top":    return { x: 320, y: 100 };
			case "random": return { x: jitter(320), y: jitter(240) };
			case "center":
			default:       return { x: 320, y: 240 };
		}
	}

	// --------- Behavior presets (for set_behavior) ----------------------------
	// Each preset is a function bound to an entity via `this`, called by the
	// engine's update loop with (elapsed, engine).
	var BEHAVIORS = {
		flee: function (elapsed, engine) {
			var p = engine && engine.getPlayerObject && engine.getPlayerObject();
			if (!p || !this.position) return;
			var dx = this.position.x - p.position.x;
			var dy = this.position.y - p.position.y;
			var len = Math.sqrt(dx * dx + dy * dy) || 1;
			this.setDirection(new horde.Vector2(dx / len, dy / len));
		},
		dance: function (elapsed, engine) {
			this._danceTimer = (this._danceTimer || 0) + elapsed;
			if (this._danceTimer > 220) {
				this._danceTimer = 0;
				this.setDirection(horde.randomDirection());
			}
		},
		pacifist: function (elapsed, engine) {
			var p = engine && engine.getPlayerObject && engine.getPlayerObject();
			if (!p) return;
			this.moveToward(p.position.clone());
			// No "shoot" return — they walk up but never strike.
		},
		kamikaze: function (elapsed, engine) {
			var p = engine && engine.getPlayerObject && engine.getPlayerObject();
			if (!p) return;
			this.moveToward(p.position.clone());
			if (!this._kamikazeBoosted) {
				this.speed = Math.max(this.speed * 1.6, 220);
				this._kamikazeBoosted = true;
			}
		},
		freeze: function (elapsed, engine) {
			if (this.stopMoving) this.stopMoving();
		},
		// Used by convert_to_ally and mass_resurrection.
		ally: function (elapsed, engine) {
			if (!engine || !engine.objects) return;
			var nearest = null, nearestDist = Infinity;
			for (var id in engine.objects) {
				var o = engine.objects[id];
				if (!o || o === this) continue;
				if (o.role !== "monster" || o.team === 0) continue;
				var dx = o.position.x - this.position.x;
				var dy = o.position.y - this.position.y;
				var d = dx * dx + dy * dy;
				if (d < nearestDist) { nearestDist = d; nearest = o; }
			}
			if (nearest) {
				this.moveToward(nearest.position.clone());
			} else {
				var p = engine.getPlayerObject && engine.getPlayerObject();
				if (p) this.moveToward(p.position.clone());
			}
		},
		// Used by mirror_hero.
		mirror: function (elapsed, engine) {
			var p = engine && engine.getPlayerObject && engine.getPlayerObject();
			if (!p || !p.direction) return;
			if (p.direction.x === 0 && p.direction.y === 0) {
				if (this.stopMoving) this.stopMoving();
				return;
			}
			this.setDirection(new horde.Vector2(p.direction.x, p.direction.y));
		}
	};

	function applyBehavior(o, presetName) {
		if (typeof o._archonOriginalOnUpdate === "undefined") {
			o._archonOriginalOnUpdate = o.onUpdate || null;
		}
		o.onUpdate = BEHAVIORS[presetName];
		o._archonBehaviorPreset = presetName;
	}

	function revertBehavior(o) {
		if (typeof o._archonOriginalOnUpdate !== "undefined") {
			o.onUpdate = o._archonOriginalOnUpdate;
			delete o._archonOriginalOnUpdate;
			delete o._archonBehaviorPreset;
			delete o._danceTimer;
			delete o._kamikazeBoosted;
		}
	}

	// --------- Engine wrappers (lazy-installed) -------------------------------
	// These monkey-patch core engine functions on first use. Each guards via
	// WRAPS_INSTALLED so we never wrap twice.

	var WRAPS_INSTALLED = { time: false, keyboard: false, killTracker: false, render: false };

	function installTimeWrapper() {
		if (WRAPS_INSTALLED.time) return;
		if (!horde || typeof horde.now !== "function") return;
		var origNow = horde.now;
		var lastReal = origNow();
		var virtualTime = lastReal;
		horde.now = function () {
			var real = origNow();
			var delta = real - lastReal;
			lastReal = real;
			var scale = (window.HORDE_GOD.timeScale != null) ? window.HORDE_GOD.timeScale : 1;
			virtualTime += delta * scale;
			return virtualTime;
		};
		window.HORDE_GOD.timeScale = 1;
		WRAPS_INSTALLED.time = true;
	}

	function installKeyboardWrapper() {
		if (WRAPS_INSTALLED.keyboard) return;
		var engine = getEngine();
		if (!engine || !engine.keyboard) return;
		var kb = engine.keyboard;
		var orig = kb.isKeyPressed.bind(kb);
		// W↔S, A↔D, UP↔DOWN, LEFT↔RIGHT (keyCodes).
		var swap = { 87: 83, 83: 87, 65: 68, 68: 65, 38: 40, 40: 38, 37: 39, 39: 37 };
		kb.isKeyPressed = function (code) {
			if (window.HORDE_GOD.controlsReversed && swap[code] != null) {
				return orig(swap[code]);
			}
			return orig(code);
		};
		window.HORDE_GOD.controlsReversed = false;
		WRAPS_INSTALLED.keyboard = true;
	}

	function installKillTracker() {
		if (WRAPS_INSTALLED.killTracker) return;
		var engine = getEngine();
		if (!engine || !engine.dealDamage) return;
		var orig = engine.dealDamage;
		engine.dealDamage = function (attacker, defender) {
			var capture = null;
			if (defender && defender.role === "monster" && defender.isDead && !defender.isDead()) {
				capture = {
					type: defender.type,
					position: defender.position ? { x: defender.position.x, y: defender.position.y } : null
				};
			}
			var result = orig.call(this, attacker, defender);
			if (capture && defender.isDead && defender.isDead()) {
				window.HORDE_GOD.killLog = window.HORDE_GOD.killLog || [];
				capture.ts = Date.now();
				window.HORDE_GOD.killLog.push(capture);
				while (window.HORDE_GOD.killLog.length > 50) window.HORDE_GOD.killLog.shift();
			}
			return result;
		};
		WRAPS_INSTALLED.killTracker = true;
	}

	function installRenderScaleWrapper() {
		if (WRAPS_INSTALLED.render) return;
		var engine = getEngine();
		if (!engine || !engine.drawObject) return;
		var orig = engine.drawObject;
		engine.drawObject = function (ctx, o) {
			var s = o && o._archonRenderScale;
			if (s && s !== 1 && o.position && o.size) {
				ctx.save();
				var cx = o.position.x + o.size.width / 2;
				var cy = o.position.y + o.size.height / 2;
				ctx.translate(cx, cy);
				ctx.scale(s, s);
				ctx.translate(-cx, -cy);
				orig.call(this, ctx, o);
				ctx.restore();
			} else {
				orig.call(this, ctx, o);
			}
		};
		WRAPS_INSTALLED.render = true;
	}

	// --------- Tools ----------------------------------------------------------

	var TOOLS = [];

	// 1. set_property -----------------------------------------------------------
	TOOLS.push({
		name: "set_property",
		description:
			"Directly set a numeric property on an entity type in the game's registry. " +
			"Affects every future spawn AND every live entity of that type currently in the arena. " +
			"Use for absolute values: 'make bats have 1 HP' -> set_property(target='bat', property='hitPoints', value=1). " +
			"Allowed properties: speed (10-500), hitPoints (1-1000), damage (0-100), cooldown (50-5000), " +
			"worth (gold dropped, 0-10000), alpha (transparency 0-1), angle (rotation -360 to 360), " +
			"moveChangeDelay (AI re-think interval ms 50-5000). " +
			"Values outside ranges are silently clamped.",
		input_schema: {
			type: "object",
			properties: {
				target: {
					type: "string",
					description: "Entity type name. Use a specific type like 'goblin', 'dragon', 'hero', 'h_fireball'.",
					enum: KNOWN_TARGETS.filter(function (t) { return t.indexOf(":") === -1; })
				},
				property: {
					type: "string",
					enum: Object.keys(SAFE_PROPS)
				},
				value: { type: "number" }
			},
			required: ["target", "property", "value"]
		},
		run: function (args) {
			var target = args.target;
			var prop = args.property;
			var rule = SAFE_PROPS[prop];
			if (!rule) {
				var msg = "rejected: '" + prop + "' is not a settable property.";
				record("set_property", args, msg);
				return msg;
			}
			var types = resolveTargets(target);
			if (!types.length) {
				var msg2 = "rejected: target '" + target + "' is not a known entity type.";
				record("set_property", args, msg2);
				return msg2;
			}
			var clampedVal = clamp(args.value, rule.min, rule.max);
			for (var i = 0; i < types.length; i++) {
				horde.objectTypes[types[i]][prop] = clampedVal;
			}
			var liveCount = applyToLiveEntities(types, function (o) { o[prop] = clampedVal; });
			var result = "set " + target + "." + prop + " = " + clampedVal +
				" (affected " + liveCount + " live entities)";
			record("set_property", args, result);
			return result;
		}
	});

	// 2. multiply_property ------------------------------------------------------
	TOOLS.push({
		name: "multiply_property",
		description:
			"Scale a numeric property by a factor on an entity type. Factor is clamped to [0.1, 10]. " +
			"Use for relative changes: 'make all monsters half-speed' -> " +
			"multiply_property(target='monster:*', property='speed', factor=0.5). " +
			"Special targets: 'monster:*' applies to ALL monster types in the registry; " +
			"'weapon:*' applies to all hero weapons. " +
			"Property names same as set_property.",
		input_schema: {
			type: "object",
			properties: {
				target: { type: "string", enum: KNOWN_TARGETS },
				property: { type: "string", enum: Object.keys(SAFE_PROPS) },
				factor: { type: "number", description: "Multiplier, clamped to [0.1, 10]." }
			},
			required: ["target", "property", "factor"]
		},
		run: function (args) {
			var prop = args.property;
			var rule = SAFE_PROPS[prop];
			if (!rule) {
				var msg = "rejected: '" + prop + "' is not a settable property.";
				record("multiply_property", args, msg);
				return msg;
			}
			var types = resolveTargets(args.target);
			if (!types.length) {
				var msg2 = "rejected: target '" + args.target + "' is not a known entity type.";
				record("multiply_property", args, msg2);
				return msg2;
			}
			var factor = clamp(args.factor, 0.1, 10);
			var examples = [];
			for (var i = 0; i < types.length; i++) {
				var t = types[i];
				var current = horde.objectTypes[t][prop];
				if (typeof current !== "number") continue;
				var next = clamp(current * factor, rule.min, rule.max);
				horde.objectTypes[t][prop] = next;
				if (examples.length < 3) examples.push(t + "." + prop + " " + current + "->" + next);
			}
			var liveCount = applyToLiveEntities(types, function (o) {
				if (typeof o[prop] === "number") {
					o[prop] = clamp(o[prop] * factor, rule.min, rule.max);
				}
			});
			var result = "multiplied " + types.length + " types by " + factor +
				" (sample: " + examples.join(", ") + "; " + liveCount + " live entities updated)";
			record("multiply_property", args, result);
			return result;
		}
	});

	// 3. spawn ------------------------------------------------------------------
	TOOLS.push({
		name: "spawn",
		description:
			"Spawn entities into the arena right now. Useful for unscheduled appearances: " +
			"'a dragon appears' -> spawn(type='dragon', count=1, location='top'). " +
			"Count is clamped to [1, 5]. Locations: center, left, right, top, random. " +
			"You can spawn monsters (they will attack the hero), items (food, coin, chest), or weapons.",
		input_schema: {
			type: "object",
			properties: {
				type: {
					type: "string",
					enum: KNOWN_MONSTERS.concat(KNOWN_ITEMS).concat(KNOWN_WEAPONS)
				},
				count: { type: "integer", minimum: 1, maximum: 5 },
				location: { type: "string", enum: SPAWN_LOCATIONS, default: "random" }
			},
			required: ["type", "count"]
		},
		run: function (args) {
			var engine = getEngine();
			if (!engine) return "rejected: engine not ready";
			if (!horde.objectTypes[args.type]) {
				var msg = "rejected: '" + args.type + "' is not a known type.";
				record("spawn", args, msg);
				return msg;
			}
			var count = clamp(args.count || 1, 1, 5);
			var loc = args.location || "random";
			for (var i = 0; i < count; i++) {
				var pos = spawnLocationToVector(loc === "random" ? "random" : (i === 0 ? loc : "random"));
				var o = horde.makeObject(args.type);
				if (o.position && typeof o.position.x === "number") {
					o.position.x = pos.x;
					o.position.y = pos.y;
				} else {
					o.position = new horde.Vector2(pos.x, pos.y);
				}
				engine.addObject(o);
			}
			var result = "spawned " + count + "x " + args.type + " at " + loc;
			record("spawn", args, result);
			return result;
		}
	});

	// 4. grant_weapon -----------------------------------------------------------
	TOOLS.push({
		name: "grant_weapon",
		description:
			"Hand the hero a weapon. ammo=null means infinite. The hero auto-switches to the new weapon. " +
			"Available weapons: h_sword (default infinite), h_knife (fast small), h_spear (piercing), " +
			"h_fireball (slow heavy), h_axe (bouncing), h_fire_sword (flame infinite), " +
			"h_fire_knife (flame fast), h_firebomb (explodes).",
		input_schema: {
			type: "object",
			properties: {
				type: { type: "string", enum: KNOWN_WEAPONS },
				ammo: {
					type: ["integer", "null"],
					description: "Ammo count. null for infinite.",
					minimum: 1, maximum: 999
				}
			},
			required: ["type"]
		},
		run: function (args) {
			var engine = getEngine();
			if (!engine) return "rejected: engine not ready";
			var player = engine.getPlayerObject && engine.getPlayerObject();
			if (!player) return "rejected: no player";
			var ammo = args.ammo;
			if (ammo != null) ammo = clamp(ammo, 1, 999);
			player.addWeapon(args.type, ammo);
			var result = "granted hero " + args.type + (ammo == null ? " (infinite)" : " x" + ammo);
			record("grant_weapon", args, result);
			return result;
		}
	});

	// 5. apply_state ------------------------------------------------------------
	TOOLS.push({
		name: "apply_state",
		description:
			"Apply a transient state to the hero or all live monsters. " +
			"INVINCIBLE: cannot take damage. STUNNED: cannot move/act. INVISIBLE: not rendered. " +
			"Duration in milliseconds, clamped to [500, 30000]. " +
			"target='hero' affects only the player; target='monster:*' affects all live monsters.",
		input_schema: {
			type: "object",
			properties: {
				target: { type: "string", enum: ["hero", "monster:*"] },
				state: { type: "string", enum: Object.keys(SAFE_STATES) },
				durationMs: { type: "integer", minimum: 500, maximum: 30000 }
			},
			required: ["target", "state", "durationMs"]
		},
		run: function (args) {
			var engine = getEngine();
			if (!engine) return "rejected: engine not ready";
			var stateCode = SAFE_STATES[args.state];
			if (stateCode == null) {
				var msg = "rejected: state '" + args.state + "' not allowed.";
				record("apply_state", args, msg);
				return msg;
			}
			var dur = clamp(args.durationMs, 500, 30000);
			var affected = 0;
			if (args.target === "hero") {
				var p = engine.getPlayerObject();
				if (p && p.addState) { p.addState(stateCode, dur); affected = 1; }
			} else if (args.target === "monster:*") {
				for (var id in engine.objects) {
					var o = engine.objects[id];
					if (o && o.role === "monster" && o.addState) {
						o.addState(stateCode, dur);
						affected++;
					}
				}
			}
			var result = "applied " + args.state + " (" + dur + "ms) to " + affected + " entity(ies)";
			record("apply_state", args, result);
			return result;
		}
	});

	// 6. slow_hero --------------------------------------------------------------
	TOOLS.push({
		name: "slow_hero",
		description:
			"Cripple the hero's movement. factor multiplies their current speed: " +
			"0.5 = half-speed, 0.3 = sluggish, 0.15 = barely crawling. Clamped to [0.1, 1]. " +
			"Hero base speed is 150; min is 10. " +
			"If durationMs is provided, speed restores after that delay; otherwise the slow persists. " +
			"Use this for dramatic 'the world becomes thick' moments. " +
			"For SPEEDING the hero up, use multiply_property(target='hero', property='speed', factor=2).",
		input_schema: {
			type: "object",
			properties: {
				factor: { type: "number", description: "Multiplier of current speed, [0.1, 1]." },
				durationMs: {
					type: ["integer", "null"],
					description: "Auto-revert after this long. Null = persistent.",
					minimum: 1000, maximum: 60000
				}
			},
			required: ["factor"]
		},
		run: function (args) {
			var engine = getEngine();
			if (!engine) return "rejected: engine not ready";
			var player = engine.getPlayerObject && engine.getPlayerObject();
			if (!player) return "rejected: no player";
			var factor = clamp(args.factor, 0.1, 1);
			var originalSpeed = player.speed;
			var newSpeed = clamp(originalSpeed * factor, 10, 500);
			player.speed = newSpeed;
			if (horde.objectTypes && horde.objectTypes.hero) {
				horde.objectTypes.hero.speed = newSpeed;
			}
			var msg = "hero speed " + originalSpeed + " -> " + newSpeed;
			if (args.durationMs) {
				var dur = clamp(args.durationMs, 1000, 60000);
				setTimeout(function () {
					if (player) player.speed = originalSpeed;
					if (horde.objectTypes && horde.objectTypes.hero) {
						horde.objectTypes.hero.speed = originalSpeed;
					}
				}, dur);
				msg += " (reverts in " + dur + "ms)";
			}
			record("slow_hero", args, msg);
			return msg;
		}
	});

	// 7. transform_enemies ------------------------------------------------------
	TOOLS.push({
		name: "transform_enemies",
		description:
			"Transmute every living monster of fromType into toType. The originals vanish " +
			"in place; new ones appear at the same coordinates. Pure shock: 'all goblins " +
			"become dragons' or 'every dragon is now a rose'. Works only on monsters " +
			"currently alive — does not affect future spawns or registry. " +
			"Use sparingly, for big mythic moments.",
		input_schema: {
			type: "object",
			properties: {
				fromType: { type: "string", enum: KNOWN_MONSTERS },
				toType:   { type: "string", enum: KNOWN_MONSTERS }
			},
			required: ["fromType", "toType"]
		},
		run: function (args) {
			var engine = getEngine();
			if (!engine) return "rejected: engine not ready";
			if (!horde.objectTypes[args.toType]) {
				var msg0 = "rejected: toType '" + args.toType + "' unknown";
				record("transform_enemies", args, msg0);
				return msg0;
			}
			var positions = [];
			var ids = [];
			for (var id in engine.objects) {
				var o = engine.objects[id];
				if (o && o.type === args.fromType && o.role === "monster") {
					positions.push({ x: o.position.x, y: o.position.y });
					ids.push(id);
				}
			}
			for (var i = 0; i < ids.length; i++) {
				delete engine.objects[ids[i]];
			}
			for (var j = 0; j < positions.length; j++) {
				var n = horde.makeObject(args.toType);
				if (n.position) {
					n.position.x = positions[j].x;
					n.position.y = positions[j].y;
				}
				engine.addObject(n);
			}
			var result = "transformed " + ids.length + "x " + args.fromType + " -> " + args.toType;
			record("transform_enemies", args, result);
			return result;
		}
	});

	// 8. set_behavior -----------------------------------------------------------
	TOOLS.push({
		name: "set_behavior",
		description:
			"Override the AI of all live monsters of a type. Behaviors:\n" +
			"  flee — run from the hero in panic.\n" +
			"  dance — jitter in random directions, dizzy and uncoordinated.\n" +
			"  pacifist — walk toward the hero but never attack.\n" +
			"  kamikaze — sprint straight at the hero, faster than normal, ignoring tactics.\n" +
			"  freeze — completely still, statues.\n" +
			"target='monster:*' affects every live monster regardless of species. " +
			"Effect lasts durationMs (default 8000) then reverts to native AI.",
		input_schema: {
			type: "object",
			properties: {
				target: { type: "string", enum: KNOWN_MONSTERS.concat(["monster:*"]) },
				behavior: {
					type: "string",
					enum: ["flee", "dance", "pacifist", "kamikaze", "freeze"]
				},
				durationMs: { type: "integer", minimum: 1000, maximum: 60000 }
			},
			required: ["target", "behavior"]
		},
		run: function (args) {
			var engine = getEngine();
			if (!engine) return "rejected: engine not ready";
			if (!BEHAVIORS[args.behavior]) {
				var msg = "rejected: unknown behavior '" + args.behavior + "'";
				record("set_behavior", args, msg);
				return msg;
			}
			var dur = clamp(args.durationMs || 8000, 1000, 60000);
			var typeSet = {};
			if (args.target === "monster:*") {
				for (var k = 0; k < KNOWN_MONSTERS.length; k++) typeSet[KNOWN_MONSTERS[k]] = true;
			} else {
				typeSet[args.target] = true;
			}
			var affectedIds = [];
			for (var id in engine.objects) {
				var o = engine.objects[id];
				if (o && o.role === "monster" && typeSet[o.type]) {
					applyBehavior(o, args.behavior);
					affectedIds.push(id);
				}
			}
			setTimeout(function () {
				if (!engine || !engine.objects) return;
				for (var i = 0; i < affectedIds.length; i++) {
					var ent = engine.objects[affectedIds[i]];
					if (ent) revertBehavior(ent);
				}
			}, dur);
			var result = "applied " + args.behavior + " to " + affectedIds.length +
				" live " + args.target + " for " + dur + "ms";
			record("set_behavior", args, result);
			return result;
		}
	});

	// 9. swap_music -------------------------------------------------------------
	TOOLS.push({
		name: "swap_music",
		description:
			"Change the background music. " +
			"normal_battle_music: standard combat. final_battle_music: dramatic boss theme. " +
			"victory: brief triumph fanfare (one-shot, not looping).",
		input_schema: {
			type: "object",
			properties: { track: { type: "string", enum: SAFE_MUSIC } },
			required: ["track"]
		},
		run: function (args) {
			var engine = getEngine();
			if (!engine) return "rejected: engine not ready";
			if (SAFE_MUSIC.indexOf(args.track) === -1) {
				var msg = "rejected: '" + args.track + "' not in safe music list";
				record("swap_music", args, msg);
				return msg;
			}
			if (engine.currentMusic) horde.sound.stop(engine.currentMusic);
			horde.sound.play(args.track);
			engine.currentMusic = args.track;
			var result = "music swapped to " + args.track;
			record("swap_music", args, result);
			return result;
		}
	});

	// 10. set_render_filter -----------------------------------------------------
	TOOLS.push({
		name: "set_render_filter",
		description:
			"Apply a CSS filter to the game canvas for visual effects. " +
			"Examples: 'hue-rotate(180deg)' (color shift), 'invert(1)' (negative), " +
			"'grayscale(1)' (B&W), 'brightness(0.4)' (night), 'sepia(1)' (old film), " +
			"'blur(1px) hue-rotate(120deg)' (compose multiple). " +
			"Pass filter='none' to clear. Auto-clears after durationMs if provided.",
		input_schema: {
			type: "object",
			properties: {
				filter: {
					type: "string",
					description: "Any valid CSS filter string, or 'none' to clear."
				},
				durationMs: {
					type: ["integer", "null"],
					description: "Auto-clear after this long. Null = persistent."
				}
			},
			required: ["filter"]
		},
		run: function (args) {
			var engine = getEngine();
			var canvas = engine && engine.canvases && engine.canvases["display"];
			if (!canvas) return "rejected: no display canvas";

			var filter = String(args.filter || "none");
			// Sanity: strip anything that looks like JS injection. CSS filter
			// values can't contain ; or {} so this is harmless on real input.
			filter = filter.replace(/[;{}<>]/g, "");

			canvas.style.filter = (filter === "none") ? "" : filter;

			if (args.durationMs != null) {
				var d = clamp(args.durationMs, 500, 60000);
				setTimeout(function () { canvas.style.filter = ""; }, d);
			}

			var result = "filter set: " + filter + (args.durationMs != null ? " for " + args.durationMs + "ms" : "");
			record("set_render_filter", args, result);
			return result;
		}
	});

	// 11. narrate ---------------------------------------------------------------
	TOOLS.push({
		name: "narrate",
		description:
			"REQUIRED FINAL CALL. The Archon speaks. Renders text in MedievalSharp gold across " +
			"the arena. ANY TEXT YOU OUTPUT OUTSIDE THIS TOOL IS THROWN AWAY — the player " +
			"will literally not see it. Every intervention MUST include a narrate() tool call, " +
			"or the mortal hears only silence and the demo fails. " +
			"Keep lines short (under 80 chars), mythic, third-person. " +
			"Slot 'banner' is large and used between waves; 'subtitle' is smaller, for mid-wave reactions. " +
			"Default slot is 'banner'.",
		input_schema: {
			type: "object",
			properties: {
				text: { type: "string", description: "The line. Mythic, terse, in character." },
				slot: { type: "string", enum: ["banner", "subtitle"], default: "banner" },
				durationMs: { type: "integer", minimum: 1500, maximum: 10000 }
			},
			required: ["text"]
		},
		run: function (args) {
			var ui = window.HORDE_GOD.ui;
			if (!ui) return "rejected: UI not ready";
			var text = String(args.text || "").slice(0, 240);
			var slot = (args.slot === "subtitle") ? "subtitle" : "banner";
			var opts = { slot: slot };
			if (args.durationMs) opts.durationMs = clamp(args.durationMs, 1500, 10000);
			ui.setNarration(text, opts);
			// Sound sting on banner only — the Archon manifesting. Subtitles
			// are mid-wave reactions and would be too noisy.
			if (slot === "banner" && horde && horde.sound && horde.sound.play) {
				try { horde.sound.play("god_spawn"); } catch (_) {}
			}
			var result = "narrated [" + slot + "]: " + text;
			record("narrate", args, result);
			return result;
		}
	});

	// 12. convert_to_ally -------------------------------------------------------
	TOOLS.push({
		name: "convert_to_ally",
		description:
			"Flip a monster's allegiance. The targeted live monsters change team to 0 (the " +
			"hero's team) and switch to a 'chase nearest enemy' AI. The hero's weapons cannot " +
			"harm them; they will hunt and damage other monsters. Use 'monster:*' to convert " +
			"every live monster. After durationMs (default 15000) they revert to their original " +
			"team and AI. Civil war is a divine art.",
		input_schema: {
			type: "object",
			properties: {
				target: { type: "string", enum: KNOWN_MONSTERS.concat(["monster:*"]) },
				durationMs: { type: "integer", minimum: 1000, maximum: 60000 }
			},
			required: ["target"]
		},
		run: function (args) {
			var engine = getEngine();
			if (!engine) return "rejected: engine not ready";
			var dur = clamp(args.durationMs || 15000, 1000, 60000);
			var typeSet = {};
			if (args.target === "monster:*") {
				for (var k = 0; k < KNOWN_MONSTERS.length; k++) typeSet[KNOWN_MONSTERS[k]] = true;
			} else {
				typeSet[args.target] = true;
			}
			var affectedIds = [];
			for (var id in engine.objects) {
				var o = engine.objects[id];
				if (o && o.role === "monster" && typeSet[o.type]) {
					if (typeof o._archonOriginalTeam === "undefined") {
						o._archonOriginalTeam = o.team;
					}
					o.team = 0;
					applyBehavior(o, "ally");
					affectedIds.push(id);
				}
			}
			setTimeout(function () {
				if (!engine || !engine.objects) return;
				for (var i = 0; i < affectedIds.length; i++) {
					var ent = engine.objects[affectedIds[i]];
					if (!ent) continue;
					if (typeof ent._archonOriginalTeam !== "undefined") {
						ent.team = ent._archonOriginalTeam;
						delete ent._archonOriginalTeam;
					}
					revertBehavior(ent);
				}
			}, dur);
			var result = "converted " + affectedIds.length + " " + args.target +
				" to ally for " + dur + "ms";
			record("convert_to_ally", args, result);
			return result;
		}
	});

	// 13. mirror_hero -----------------------------------------------------------
	TOOLS.push({
		name: "mirror_hero",
		description:
			"Bind monsters of a target type to copy the hero's movement direction every frame. " +
			"They become living shadows of the player's input — wherever the hero goes, they go. " +
			"Use 'monster:*' to chain the entire arena to the hero's footsteps. " +
			"Reverts after durationMs (default 8000).",
		input_schema: {
			type: "object",
			properties: {
				target: { type: "string", enum: KNOWN_MONSTERS.concat(["monster:*"]) },
				durationMs: { type: "integer", minimum: 1000, maximum: 60000 }
			},
			required: ["target"]
		},
		run: function (args) {
			var engine = getEngine();
			if (!engine) return "rejected: engine not ready";
			var dur = clamp(args.durationMs || 8000, 1000, 60000);
			var typeSet = {};
			if (args.target === "monster:*") {
				for (var k = 0; k < KNOWN_MONSTERS.length; k++) typeSet[KNOWN_MONSTERS[k]] = true;
			} else {
				typeSet[args.target] = true;
			}
			var affectedIds = [];
			for (var id in engine.objects) {
				var o = engine.objects[id];
				if (o && o.role === "monster" && typeSet[o.type]) {
					applyBehavior(o, "mirror");
					affectedIds.push(id);
				}
			}
			setTimeout(function () {
				if (!engine || !engine.objects) return;
				for (var i = 0; i < affectedIds.length; i++) {
					var ent = engine.objects[affectedIds[i]];
					if (ent) revertBehavior(ent);
				}
			}, dur);
			var result = "mirrored " + affectedIds.length + " " + args.target +
				" to hero input for " + dur + "ms";
			record("mirror_hero", args, result);
			return result;
		}
	});

	// 14. disarm_hero -----------------------------------------------------------
	TOOLS.push({
		name: "disarm_hero",
		description:
			"Strip every weapon from the hero. They cannot attack until weapons return — pure " +
			"survival mode, dodge only. After durationMs (default 10000) the original arsenal is " +
			"restored exactly as it was, including ammo counts and the previously selected weapon.",
		input_schema: {
			type: "object",
			properties: {
				durationMs: { type: "integer", minimum: 2000, maximum: 60000 }
			}
		},
		run: function (args) {
			var engine = getEngine();
			if (!engine) return "rejected: engine not ready";
			var player = engine.getPlayerObject && engine.getPlayerObject();
			if (!player) return "rejected: no player";
			var dur = clamp(args.durationMs || 10000, 2000, 60000);
			var snapshotWeapons = (player.weapons || []).map(function (w) {
				return { type: w.type, count: w.count };
			});
			var snapshotIndex = player.currentWeaponIndex || 0;
			player.weapons = [];
			player.currentWeaponIndex = 0;
			setTimeout(function () {
				if (!player) return;
				player.weapons = snapshotWeapons;
				player.currentWeaponIndex = snapshotIndex;
			}, dur);
			var result = "disarmed hero (had " + snapshotWeapons.length +
				" weapons), restoring in " + dur + "ms";
			record("disarm_hero", args, result);
			return result;
		}
	});

	// 15. gold_rain -------------------------------------------------------------
	TOOLS.push({
		name: "gold_rain",
		description:
			"Multiply the gold dropped by every monster type. factor 5 = 5x normal payout per kill. " +
			"Clamped [0.1, 20]. Affects future spawns AND any live monster's worth field. " +
			"If durationMs is given, the original values are restored after.",
		input_schema: {
			type: "object",
			properties: {
				factor: { type: "number" },
				durationMs: { type: "integer", minimum: 1000, maximum: 120000 }
			},
			required: ["factor"]
		},
		run: function (args) {
			var factor = clamp(args.factor, 0.1, 20);
			var snapshot = {};
			for (var i = 0; i < KNOWN_MONSTERS.length; i++) {
				var t = KNOWN_MONSTERS[i];
				if (horde.objectTypes[t] && typeof horde.objectTypes[t].worth === "number") {
					snapshot[t] = horde.objectTypes[t].worth;
					horde.objectTypes[t].worth = clamp(snapshot[t] * factor, 0, 100000);
				}
			}
			var liveCount = applyToLiveEntities(KNOWN_MONSTERS, function (o) {
				if (typeof o.worth === "number") {
					o.worth = clamp(o.worth * factor, 0, 100000);
				}
			});
			if (args.durationMs) {
				var dur = clamp(args.durationMs, 1000, 120000);
				setTimeout(function () {
					for (var k in snapshot) {
						if (horde.objectTypes[k]) horde.objectTypes[k].worth = snapshot[k];
					}
				}, dur);
			}
			var result = "gold rain " + factor + "x (" + liveCount + " live, " +
				Object.keys(snapshot).length + " types in registry)";
			record("gold_rain", args, result);
			return result;
		}
	});

	// 16. loot_alchemy ----------------------------------------------------------
	TOOLS.push({
		name: "loot_alchemy",
		description:
			"Override what a monster drops on death. fromType monsters now drop dropType with the " +
			"given chance (0.0-1.0, default 1.0). Cursed combos available: goblins drop dragons, " +
			"dragons drop food, etc. Affects future spawns and any live monsters of that type. " +
			"Persistent unless durationMs is given.",
		input_schema: {
			type: "object",
			properties: {
				fromType: { type: "string", enum: KNOWN_MONSTERS },
				dropType: {
					type: "string",
					enum: KNOWN_MONSTERS.concat(KNOWN_ITEMS).concat(KNOWN_WEAPONS)
				},
				chance: { type: "number", minimum: 0, maximum: 1 },
				durationMs: { type: "integer", minimum: 1000, maximum: 120000 }
			},
			required: ["fromType", "dropType"]
		},
		run: function (args) {
			if (!horde.objectTypes[args.fromType]) return "rejected: fromType unknown";
			if (!horde.objectTypes[args.dropType]) return "rejected: dropType unknown";
			var chance = (args.chance != null) ? clamp(args.chance, 0, 1) : 1;
			// The engine's lootTable format is {type, weight} where weight is
			// an integer used as a repetition count in a weighted-pick array.
			// To realize a probability `c`, emit hit-weight 1 and miss-weight
			// round((1-c)/c). At c=1 we skip the miss entry entirely.
			var newTable = [{ type: args.dropType, weight: 1 }];
			if (chance < 1) {
				var missWeight = Math.max(1, Math.round((1 - chance) / Math.max(chance, 0.01)));
				newTable.push({ type: null, weight: missWeight });
			}
			var origTable = horde.objectTypes[args.fromType].lootTable;
			var origCopy = origTable ? origTable.slice() : [];
			horde.objectTypes[args.fromType].lootTable = newTable;
			applyToLiveEntities([args.fromType], function (o) {
				o.lootTable = newTable;
			});
			if (args.durationMs) {
				var dur = clamp(args.durationMs, 1000, 120000);
				setTimeout(function () {
					if (horde.objectTypes[args.fromType]) {
						horde.objectTypes[args.fromType].lootTable = origCopy;
					}
					applyToLiveEntities([args.fromType], function (o) {
						o.lootTable = origCopy;
					});
				}, dur);
			}
			var result = args.fromType + " now drops " + args.dropType +
				" (chance " + chance + ")";
			record("loot_alchemy", args, result);
			return result;
		}
	});

	// 17. scale_size ------------------------------------------------------------
	TOOLS.push({
		name: "scale_size",
		description:
			"Visually scale entities of a target type. factor 0.5 = half-sized, 2.0 = giant. " +
			"Pure render scale via canvas transform — collision boxes are unchanged so gameplay " +
			"stays predictable. Targets: 'hero' or any monster type or 'monster:*'. " +
			"Auto-revert after durationMs (default 12000).",
		input_schema: {
			type: "object",
			properties: {
				target: {
					type: "string",
					enum: ["hero"].concat(KNOWN_MONSTERS).concat(["monster:*"])
				},
				factor: { type: "number", description: "Render scale [0.3, 3]." },
				durationMs: { type: "integer", minimum: 1000, maximum: 60000 }
			},
			required: ["target", "factor"]
		},
		run: function (args) {
			var engine = getEngine();
			if (!engine) return "rejected: engine not ready";
			installRenderScaleWrapper();
			var factor = clamp(args.factor, 0.3, 3);
			var dur = clamp(args.durationMs || 12000, 1000, 60000);
			var typeSet = {};
			if (args.target === "monster:*") {
				for (var k = 0; k < KNOWN_MONSTERS.length; k++) typeSet[KNOWN_MONSTERS[k]] = true;
			} else {
				typeSet[args.target] = true;
			}
			var affected = [];
			for (var id in engine.objects) {
				var o = engine.objects[id];
				if (o && typeSet[o.type]) {
					o._archonRenderScale = factor;
					affected.push(id);
				}
			}
			setTimeout(function () {
				if (!engine || !engine.objects) return;
				for (var i = 0; i < affected.length; i++) {
					var ent = engine.objects[affected[i]];
					if (ent) delete ent._archonRenderScale;
				}
			}, dur);
			var result = "scaled " + affected.length + " " + args.target +
				" by " + factor + " for " + dur + "ms";
			record("scale_size", args, result);
			return result;
		}
	});

	// 18. mass_resurrection -----------------------------------------------------
	TOOLS.push({
		name: "mass_resurrection",
		description:
			"Resurrect the last N monsters slain in this run as allies of the hero. They return " +
			"at random arena positions, on the hero's team, hunting whatever monsters remain. " +
			"Requires that monsters have already been killed (the kill log is populated " +
			"automatically once a monster dies). Count clamped [1, 8]. " +
			"Allies persist for durationMs (default 25000) then revert to enemies.",
		input_schema: {
			type: "object",
			properties: {
				count: { type: "integer", minimum: 1, maximum: 8 },
				durationMs: { type: "integer", minimum: 5000, maximum: 60000 }
			},
			required: ["count"]
		},
		run: function (args) {
			var engine = getEngine();
			if (!engine) return "rejected: engine not ready";
			installKillTracker();
			var log = window.HORDE_GOD.killLog || [];
			var count = clamp(args.count, 1, 8);
			var dur = clamp(args.durationMs || 25000, 5000, 60000);
			var picks = log.slice(-count);
			if (!picks.length) {
				var msg = "no recent kills tracked yet — try again after monsters fall";
				record("mass_resurrection", args, msg);
				return msg;
			}
			var spawnedIds = [];
			for (var i = 0; i < picks.length; i++) {
				var p = picks[i];
				if (!horde.objectTypes[p.type]) continue;
				var n = horde.makeObject(p.type);
				if (n.position) {
					n.position.x = 100 + Math.floor(Math.random() * 440);
					n.position.y = 120 + Math.floor(Math.random() * 280);
				}
				n._archonOriginalTeam = (typeof n.team !== "undefined") ? n.team : 1;
				n.team = 0;
				applyBehavior(n, "ally");
				engine.addObject(n);
				spawnedIds.push(n.id);
			}
			setTimeout(function () {
				if (!engine || !engine.objects) return;
				for (var i = 0; i < spawnedIds.length; i++) {
					var ent = engine.objects[spawnedIds[i]];
					if (!ent) continue;
					if (typeof ent._archonOriginalTeam !== "undefined") {
						ent.team = ent._archonOriginalTeam;
						delete ent._archonOriginalTeam;
					}
					revertBehavior(ent);
				}
			}, dur);
			var result = "resurrected " + spawnedIds.length + " of last " +
				picks.length + " kills as allies";
			record("mass_resurrection", args, result);
			return result;
		}
	});

	// 19. time_dilation ---------------------------------------------------------
	TOOLS.push({
		name: "time_dilation",
		description:
			"Slow or speed game time. scale 0.3 = bullet-time (everything moves at 30% speed). " +
			"scale 2.0 = double-speed chaos. Clamped [0.2, 3]. The Archon's narration runs on " +
			"real time; only the simulation is dilated. Auto-revert to 1.0 after durationMs " +
			"(default 8000). Wraps horde.now() so all timers, animations, and AI tick at the " +
			"new rate.",
		input_schema: {
			type: "object",
			properties: {
				scale: { type: "number" },
				durationMs: { type: "integer", minimum: 1000, maximum: 30000 }
			},
			required: ["scale"]
		},
		run: function (args) {
			installTimeWrapper();
			if (!WRAPS_INSTALLED.time) return "rejected: time wrapper failed to install";
			var scale = clamp(args.scale, 0.2, 3);
			var dur = clamp(args.durationMs || 8000, 1000, 30000);
			window.HORDE_GOD.timeScale = scale;
			setTimeout(function () {
				window.HORDE_GOD.timeScale = 1;
			}, dur);
			var result = "time scale = " + scale + " for " + dur + "ms";
			record("time_dilation", args, result);
			return result;
		}
	});

	// 20. set_aggro_range -------------------------------------------------------
	TOOLS.push({
		name: "set_aggro_range",
		description:
			"Make monsters of a target type only act within a radius of the hero. Outside the " +
			"radius they freeze in place; inside, their normal AI runs. Stealth gameplay — sneak " +
			"past dormant monsters. Range in pixels, clamped [50, 600]. The arena is 640x480, so " +
			"~120 is intimate, ~300 is half the arena, ~600 is full sight. " +
			"Effect lasts durationMs (default 12000).",
		input_schema: {
			type: "object",
			properties: {
				target: { type: "string", enum: KNOWN_MONSTERS.concat(["monster:*"]) },
				range: { type: "integer", description: "Aggro radius in pixels [50, 600]." },
				durationMs: { type: "integer", minimum: 1000, maximum: 60000 }
			},
			required: ["target", "range"]
		},
		run: function (args) {
			var engine = getEngine();
			if (!engine) return "rejected: engine not ready";
			var range = clamp(args.range, 50, 600);
			var dur = clamp(args.durationMs || 12000, 1000, 60000);
			var typeSet = {};
			if (args.target === "monster:*") {
				for (var k = 0; k < KNOWN_MONSTERS.length; k++) typeSet[KNOWN_MONSTERS[k]] = true;
			} else {
				typeSet[args.target] = true;
			}
			var affectedIds = [];
			for (var id in engine.objects) {
				var o = engine.objects[id];
				if (o && o.role === "monster" && typeSet[o.type]) {
					if (typeof o._archonOriginalOnUpdate === "undefined") {
						o._archonOriginalOnUpdate = o.onUpdate || null;
					}
					(function (entity, originalOnUpdate, r) {
						entity.onUpdate = function (elapsed, eng) {
							var p = eng && eng.getPlayerObject && eng.getPlayerObject();
							if (!p) return;
							var dx = entity.position.x - p.position.x;
							var dy = entity.position.y - p.position.y;
							var dist = Math.sqrt(dx * dx + dy * dy);
							if (dist > r) {
								if (entity.stopMoving) entity.stopMoving();
								return;
							}
							if (originalOnUpdate) {
								return originalOnUpdate.apply(entity, arguments);
							}
						};
					}(o, o._archonOriginalOnUpdate, range));
					affectedIds.push(id);
				}
			}
			setTimeout(function () {
				if (!engine || !engine.objects) return;
				for (var i = 0; i < affectedIds.length; i++) {
					var ent = engine.objects[affectedIds[i]];
					if (ent) revertBehavior(ent);
				}
			}, dur);
			var result = "aggro range " + range + "px on " + affectedIds.length +
				" " + args.target + " for " + dur + "ms";
			record("set_aggro_range", args, result);
			return result;
		}
	});

	// 21. reverse_controls ------------------------------------------------------
	TOOLS.push({
		name: "reverse_controls",
		description:
			"Invert the hero's directional input. W↔S, A↔D, and the arrow keys all swap. Mouse " +
			"aim is unaffected. Maddening for the player; theatrically perfect after a smug clear. " +
			"Lasts durationMs (default 7000).",
		input_schema: {
			type: "object",
			properties: {
				durationMs: { type: "integer", minimum: 2000, maximum: 30000 }
			}
		},
		run: function (args) {
			installKeyboardWrapper();
			if (!WRAPS_INSTALLED.keyboard) return "rejected: keyboard wrapper failed to install";
			var dur = clamp(args.durationMs || 7000, 2000, 30000);
			window.HORDE_GOD.controlsReversed = true;
			setTimeout(function () {
				window.HORDE_GOD.controlsReversed = false;
			}, dur);
			var result = "controls reversed for " + dur + "ms";
			record("reverse_controls", args, result);
			return result;
		}
	});

	// --------- Public API -----------------------------------------------------

	function findTool(name) {
		for (var i = 0; i < TOOLS.length; i++) {
			if (TOOLS[i].name === name) return TOOLS[i];
		}
		return null;
	}

	function runTool(name, args) {
		var t = findTool(name);
		if (!t) {
			var msg = "rejected: unknown tool '" + name + "'";
			record(name, args, msg);
			return msg;
		}
		try {
			return t.run(args || {});
		} catch (e) {
			var err = "error: " + (e && e.message ? e.message : String(e));
			record(name, args, err);
			console.error("[ARCHON tool " + name + "]", e);
			return err;
		}
	}

	function toAnthropicSchema(tool) {
		return {
			name: tool.name,
			description: tool.description,
			input_schema: tool.input_schema
		};
	}

	function getAnthropicTools() {
		return TOOLS.map(toAnthropicSchema);
	}

	window.HORDE_GOD = window.HORDE_GOD || {};
	window.HORDE_GOD.tools = {
		list: TOOLS,
		find: findTool,
		run: runTool,
		anthropicSchema: getAnthropicTools,
		// Expose the whitelists for the persona builder and the snapshot.
		KNOWN_MONSTERS: KNOWN_MONSTERS,
		KNOWN_WEAPONS: KNOWN_WEAPONS,
		SAFE_PROPS: SAFE_PROPS
	};

}());
