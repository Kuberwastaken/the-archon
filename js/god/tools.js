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
		damage:     { min: 0,     max: 100,   type: "number" },
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

	// 6. swap_music -------------------------------------------------------------
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

	// 7. set_render_filter ------------------------------------------------------
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

	// 8. narrate ----------------------------------------------------------------
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
				try { horde.sound.play("wizard_reappear"); } catch (_) {}
			}
			var result = "narrated [" + slot + "]: " + text;
			record("narrate", args, result);
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
