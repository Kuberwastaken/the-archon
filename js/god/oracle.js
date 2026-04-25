/**
 * THE ARCHON — Oracle system.
 *
 * Poses riddles, questions, or wishes to the hero between waves.
 * Fires always on wave 2, then ~17% chance on subsequent waves.
 *
 * Flow:
 *   1. generateQuestion(snapshot) — Claude picks format + text via pose_riddle tool
 *   2. presentQuestion(question)  — DOM overlay; player types or clicks a choice
 *   3. reactToAnswer(q, answer)   — Claude judges; returns tool calls for intervention
 */
(function () {

	var API_URL = "https://api.anthropic.com/v1/messages";

	// ---- DOM overlay -----------------------------------------------------------

	var overlay = null;

	function ensureOverlay() {
		if (overlay) return;
		overlay = document.createElement("div");
		overlay.id = "archon-oracle";
		overlay.style.cssText = [
			"position:fixed", "inset:0", "display:none",
			"flex-direction:column", "align-items:center", "justify-content:center",
			"background:rgba(0,0,0,0.87)", "z-index:9999",
			"font-family:MedievalSharp,serif", "color:rgb(232,197,71)",
			"padding:40px", "box-sizing:border-box"
		].join(";");
		document.body.appendChild(overlay);
	}

	function killEvent(e) { e.stopPropagation(); }

	function showOverlay() {
		ensureOverlay();
		overlay.style.display = "flex";
		// Swallow keyboard events so game controls don't fire through the overlay.
		document.addEventListener("keydown", killEvent, true);
		document.addEventListener("keyup",   killEvent, true);
	}

	function hideOverlay() {
		if (!overlay) return;
		overlay.style.display = "none";
		overlay.innerHTML = "";
		document.removeEventListener("keydown", killEvent, true);
		document.removeEventListener("keyup",   killEvent, true);
	}

	function makeEl(tag, css, text) {
		var el = document.createElement(tag);
		if (css) el.style.cssText = css;
		if (text != null) el.textContent = text;
		return el;
	}

	function makeBtn(text, onClick) {
		var btn = makeEl("button", [
			"background:rgba(70,45,8,0.5)", "border:1px solid rgba(232,197,71,0.7)",
			"color:rgb(232,197,71)", "font-family:MedievalSharp,serif",
			"font-size:15px", "padding:11px 20px", "cursor:pointer",
			"text-align:left", "border-radius:2px", "width:100%"
		].join(";"), text);
		btn.onmouseover = function () { this.style.background = "rgba(130,85,15,0.65)"; };
		btn.onmouseout  = function () { this.style.background = "rgba(70,45,8,0.5)"; };
		btn.onclick = onClick;
		return btn;
	}

	var ANSWER_TIMEOUT_MS = 30000;

	// Returns Promise<string> resolving with the player's answer.
	function presentQuestion(question) {
		showOverlay();
		overlay.innerHTML = "";

		overlay.appendChild(makeEl("div",
			"font-size:12px;color:rgba(232,197,71,0.5);letter-spacing:3px;margin-bottom:22px",
			"— THE ARCHON —"));

		overlay.appendChild(makeEl("div", [
			"font-size:21px", "max-width:480px", "line-height:1.7",
			"text-align:center", "margin-bottom:30px",
			"text-shadow:0 0 14px rgba(232,197,71,0.35)"
		].join(";"), question.question));

		return new Promise(function (resolve) {
			var settled = false;
			var timeoutId = null;
			function done(val) {
				if (settled) return;
				settled = true;
				if (timeoutId) clearTimeout(timeoutId);
				hideOverlay();
				resolve(val || "(the mortal remains silent)");
			}

			var isMulti = question.format === "multiple_choice" &&
				Array.isArray(question.choices) && question.choices.length >= 2;

			if (isMulti) {
				var list = makeEl("div",
					"display:flex;flex-direction:column;gap:10px;min-width:340px;max-width:480px");
				question.choices.forEach(function (choice) {
					list.appendChild(makeBtn(choice, function () { done(choice); }));
				});
				overlay.appendChild(list);
			} else {
				overlay.appendChild(makeEl("div",
					"font-size:12px;color:rgba(232,197,71,0.5);margin-bottom:10px",
					"Speak, mortal:"));

				var inp = makeEl("input", [
					"background:rgba(8,4,0,0.85)", "border:1px solid rgba(232,197,71,0.65)",
					"color:rgb(232,197,71)", "font-family:MedievalSharp,serif",
					"font-size:17px", "padding:9px 14px", "width:360px",
					"outline:none", "caret-color:rgb(232,197,71)", "margin-bottom:14px",
					"box-sizing:border-box"
				].join(";"));
				inp.type = "text";
				inp.maxLength = 200;
				inp.placeholder = "...";
				overlay.appendChild(inp);

				function submit() {
					var val = inp.value.trim();
					if (val) done(val);
				}
				inp.onkeydown = function (e) { if (e.keyCode === 13) submit(); };

				var sbtn = makeBtn("So it is written.", submit);
				sbtn.style.cssText += ";text-align:center;width:auto;padding:9px 30px;margin-top:2px";
				overlay.appendChild(sbtn);

				setTimeout(function () { try { inp.focus(); } catch (_) {} }, 90);
			}

			// "Silence is also an answer" footer
			overlay.appendChild(makeEl("div",
				"font-size:11px;color:rgba(232,197,71,0.3);margin-top:20px",
				"Silence is also an answer."));

			// Auto-dismiss after timeout.
			timeoutId = setTimeout(function () { done("(the mortal remains silent)"); }, ANSWER_TIMEOUT_MS);
		});
	}

	// ---- Shared HTTP helper ----------------------------------------------------

	function postMessages(opts) {
		var body = {
			model: opts.cfg.model || "claude-sonnet-4-6",
			max_tokens: opts.cfg.maxTokens || 1024,
			system: opts.system,
			tools: opts.tools,
			messages: opts.messages
		};
		if (opts.tool_choice) body.tool_choice = opts.tool_choice;
		return fetch(API_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": opts.cfg.apiKey,
				"anthropic-version": "2023-06-01",
				"anthropic-dangerous-direct-browser-access": "true"
			},
			body: JSON.stringify(body)
		}).then(function (res) {
			if (!res.ok) return res.text().then(function (t) { throw new Error("Anthropic " + res.status + ": " + t); });
			return res.json();
		});
	}

	// ---- Tool schema for question generation ----------------------------------

	var POSE_RIDDLE_SCHEMA = {
		name: "pose_riddle",
		description:
			"Deliver your riddle, question, or wish to the hero. " +
			"Choose 'text' for open-ended answers, 'multiple_choice' for a three-way dilemma. " +
			"Question: under 110 characters. Each choice: under 65 characters, no leading letters — " +
			"just the option text itself.",
		input_schema: {
			type: "object",
			properties: {
				format: { type: "string", enum: ["text", "multiple_choice"] },
				question: { type: "string" },
				choices: {
					type: "array",
					items: { type: "string" },
					minItems: 3, maxItems: 3,
					description: "Required if format is multiple_choice. Exactly 3 options."
				}
			},
			required: ["format", "question"]
		}
	};

	// ---- Prompts ---------------------------------------------------------------

	function buildQuestionSystemPrompt() {
		return [
			"You are THE ARCHON, capricious deity of this arena. You have chosen to test the hero.",
			"",
			"Pose ONE question, riddle, wish, or bargain. Examples of topics:",
			"  - What they would sacrifice for power",
			"  - Their deepest regret or fear",
			"  - A bargain: I give you X if you accept Y",
			"  - A philosophical trap with no right answer",
			"  - What they fight for — and whether it is worth it",
			"  - An impossible choice between two things they value",
			"  - A wish — granted or denied depending on their soul",
			"",
			"Choose format 'text' for open reflection.",
			"Choose 'multiple_choice' for a three-way dilemma — no option should be clearly 'correct'.",
			"Be mythic, cryptic, brief. Do not explain yourself. The question IS the point.",
			"",
			"Call pose_riddle once. Nothing else."
		].join("\n");
	}

	function buildQuestionUserMessage(snapshot) {
		var w = snapshot.wave || {};
		var p = snapshot.player || {};
		var lines = [
			"Wave " + w.justClearedWave + " has fallen.",
			"The hero: " + p.hpPercent + "% vigor, " + p.gold + " gold, " + p.kills + " kills."
		];
		if (w.nextWaveIsBoss) {
			lines.push("A boss wave looms.");
		} else if (w.nextWaveEnemyTypes && w.nextWaveEnemyTypes.length) {
			lines.push("Coming next: " + w.nextWaveEnemyTypes.map(function (e) {
				return e.count + "x " + e.type;
			}).join(", ") + ".");
		}
		lines.push("", "Pose your riddle, Archon.");
		return lines.join("\n");
	}

	function buildReactionSystemPrompt() {
		var base = window.HORDE_GOD.persona.buildSystemPrompt();
		return base + "\n\n" + [
			"You are now JUDGING the hero's answer to your riddle.",
			"Choose mutations that REFLECT what their answer reveals.",
			"Courage? Test them harder. Fear? Punish or show mercy — your choice.",
			"Silence or a non-answer? Be wrathful. A wise answer? Perhaps reward.",
			"Your narrate() must reference their answer — make them feel judged.",
			"1-3 mutation tools + mandatory narrate(). Two to four tool_use blocks total."
		].join(" ");
	}

	function buildReactionUserMessage(question, answer, snapshot) {
		var w = snapshot.wave || {};
		var p = snapshot.player || {};
		var lines = [
			"You posed: \"" + question.question + "\""
		];
		if (question.format === "multiple_choice" && question.choices) {
			lines.push("Options were: " + question.choices.join(" | "));
		}
		lines.push("The hero answered: \"" + answer + "\"");
		lines.push("");
		lines.push("Hero: " + p.hpPercent + "% health, " + p.gold + " gold, " + p.kills + " kills.");
		var nextWave = w.nextWaveIsBoss ? "BOSS" :
			(w.nextWaveEnemyTypes || []).map(function (e) { return e.count + "x " + e.type; }).join(", ");
		if (nextWave) lines.push("Next wave: " + nextWave + ".");
		lines.push("");
		lines.push("Judge them. 1-3 mutations + narrate() with your verdict on their soul.");
		return lines.join("\n");
	}

	// ---- Fallbacks -------------------------------------------------------------

	var FALLBACK_QUESTIONS = [
		{
			format: "multiple_choice",
			question: "What do you fight for, mortal?",
			choices: ["Survival. Nothing more.", "Glory and gold.", "Those who cannot fight."]
		},
		{
			format: "text",
			question: "Name one thing you fear more than death."
		},
		{
			format: "multiple_choice",
			question: "A bargain. Choose one.",
			choices: ["Double power, half my speed.", "Full health, all weapons stripped.", "I refuse your bargain."]
		},
		{
			format: "text",
			question: "If you could change one thing about yourself, what would it be?"
		},
		{
			format: "multiple_choice",
			question: "Three boons. You may take one.",
			choices: ["Invincibility for one wave.", "Endless fire.", "To know what comes after death."]
		},
		{
			format: "text",
			question: "What would you sacrifice everything for?"
		},
		{
			format: "multiple_choice",
			question: "Your weapon, your armor, or your mind — one must go. Which?",
			choices: ["My weapon. I will find another.", "My armor. I am fast enough.", "My mind. It only slows me."]
		}
	];

	function fallbackQuestion() {
		return FALLBACK_QUESTIONS[Math.floor(Math.random() * FALLBACK_QUESTIONS.length)];
	}

	function fallbackReaction(answer) {
		var silent = !answer || answer.trim().length < 4 || answer === "(the mortal remains silent)";
		if (silent) {
			return {
				toolCalls: [
					{ name: "multiply_property", input: { target: "monster:*", property: "speed", factor: 1.35 } },
					{ name: "narrate", input: { text: "Silence. The Archon does not forget." } }
				]
			};
		}
		return {
			toolCalls: [
				{ name: "narrate", input: { text: "The Archon has heard you. Act accordingly." } }
			]
		};
	}

	// ---- API calls -------------------------------------------------------------

	function generateQuestion(snapshot) {
		var cfg = window.GOD_CONFIG;
		if (!cfg || !cfg.enabled || !cfg.apiKey || cfg.apiKey.indexOf("PUT-YOUR-KEY") !== -1) {
			return Promise.resolve(fallbackQuestion());
		}
		return postMessages({
			cfg: cfg,
			system: buildQuestionSystemPrompt(),
			tools: [POSE_RIDDLE_SCHEMA],
			messages: [{ role: "user", content: buildQuestionUserMessage(snapshot) }],
			tool_choice: { type: "tool", name: "pose_riddle" }
		}).then(function (data) {
			var content = (data && data.content) || [];
			for (var i = 0; i < content.length; i++) {
				var b = content[i];
				if (b.type === "tool_use" && b.name === "pose_riddle" && b.input && b.input.question) {
					return b.input;
				}
			}
			return fallbackQuestion();
		}).catch(function (err) {
			console.error("[ARCHON oracle] generateQuestion failed:", err);
			return fallbackQuestion();
		});
	}

	function reactToAnswer(question, answer, snapshot) {
		var cfg = window.GOD_CONFIG;
		if (!cfg || !cfg.enabled || !cfg.apiKey || cfg.apiKey.indexOf("PUT-YOUR-KEY") !== -1) {
			return Promise.resolve(fallbackReaction(answer));
		}
		var tools = window.HORDE_GOD.tools;
		var persona = window.HORDE_GOD.persona;
		if (!tools || !persona) return Promise.resolve(fallbackReaction(answer));

		return postMessages({
			cfg: cfg,
			system: buildReactionSystemPrompt(),
			tools: tools.anthropicSchema(),
			messages: [{ role: "user", content: buildReactionUserMessage(question, answer, snapshot) }]
		}).then(function (data) {
			var toolCalls = [];
			var hasNarrate = false;
			var content = (data && data.content) || [];
			for (var i = 0; i < content.length; i++) {
				var b = content[i];
				if (b.type === "tool_use") {
					toolCalls.push({ name: b.name, input: b.input || {}, id: b.id });
					if (b.name === "narrate") hasNarrate = true;
				}
			}
			if (!hasNarrate) {
				toolCalls.push({ name: "narrate", input: { text: "The Archon has judged you. Prepare." } });
			}
			return { toolCalls: toolCalls };
		}).catch(function (err) {
			console.error("[ARCHON oracle] reactToAnswer failed:", err);
			return fallbackReaction(answer);
		});
	}

	// ---- Main entry point ------------------------------------------------------

	function getEngine() {
		return window.engine || (window.horde && window.horde.engine);
	}

	function runOracle(snapshot) {
		var ui = window.HORDE_GOD && window.HORDE_GOD.ui;
		var engine = getEngine();

		// Freeze the simulation immediately — the oracle holds time still.
		if (engine) engine.paused = true;

		function unpause() {
			if (engine) engine.paused = false;
		}

		return generateQuestion(snapshot).then(function (question) {
			console.log("[ARCHON oracle] question:", question);

			if (ui) {
				ui.setNarration("The Archon turns its gaze upon you.", {
					slot: "banner",
					durationMs: 1600
				});
			}
			if (horde && horde.sound && horde.sound.play) {
				try { horde.sound.play("god_spawn"); } catch (_) {}
			}

			return new Promise(function (resolve) {
				setTimeout(function () {
					presentQuestion(question).then(function (answer) {
						resolve({ question: question, answer: answer });
					});
				}, 1400);
			});
		}).then(function (qa) {
			console.log("[ARCHON oracle] answer received:", qa.answer);
			return reactToAnswer(qa.question, qa.answer, snapshot);
		}).then(function (result) {
			unpause();
			return result;
		}, function (err) {
			unpause();
			console.error("[ARCHON oracle] runOracle failed:", err);
			return { toolCalls: [{ name: "narrate", input: { text: "The Archon speaks from silence." } }] };
		});
	}

	// Decides whether the oracle fires for a given cleared wave number.
	function shouldFire(clearedWaveNumber) {
		if (clearedWaveNumber === 2) return true;
		if (clearedWaveNumber > 2) return Math.random() < 0.18;
		return false;
	}

	window.HORDE_GOD = window.HORDE_GOD || {};
	window.HORDE_GOD.oracle = {
		runOracle: runOracle,
		shouldFire: shouldFire
	};

}());
