/**
 * THE ARCHON — Anthropic Messages API client.
 *
 * Direct browser-to-Anthropic call (uses anthropic-dangerous-direct-browser-access
 * header). Fine for hackathon demo. For production, front this with a tiny proxy.
 *
 * callArchon(snapshot) -> Promise<{ toolCalls: [{name, input, alreadyRun?}], ... }>
 *
 * Two-phase strategy:
 *   1. First call: tools=auto. Claude picks 1-3 mutations. We run them
 *      immediately so visual effects show fast.
 *   2. If Claude forgot to call `narrate`, do a follow-up call with
 *      tool_choice forced to narrate, passing the real tool_results back so
 *      the narration is grounded in what actually happened.
 * The returned toolCalls list flags first-batch entries with alreadyRun=true
 * so the orchestrator doesn't double-execute.
 */
(function () {

	var API_URL = "https://api.anthropic.com/v1/messages";

	function callArchon(snapshot) {
		var cfg = window.GOD_CONFIG;
		if (!cfg || !cfg.enabled || !cfg.apiKey || cfg.apiKey.indexOf("PUT-YOUR-KEY") !== -1) {
			console.warn("[ARCHON] No API key configured — using fallback narration.");
			return Promise.resolve(fallbackResponse());
		}

		var persona = window.HORDE_GOD.persona;
		var tools = window.HORDE_GOD.tools;
		if (!persona || !tools) return Promise.resolve(fallbackResponse());

		var systemPrompt = persona.buildSystemPrompt();
		var userMessage = persona.buildUserMessage(snapshot);
		var allTools = tools.anthropicSchema();

		// Phase 1 — let Claude choose freely.
		return postMessages({
			cfg: cfg,
			system: systemPrompt,
			tools: allTools,
			messages: [{ role: "user", content: userMessage }]
		}).then(function (firstData) {
			var first = parseResponse(firstData);

			// Run first-batch mutations immediately. We need the results to
			// feed back to Claude in the follow-up call.
			var ranCalls = [];
			var hasNarrate = false;
			for (var i = 0; i < first.toolCalls.length; i++) {
				var tc = first.toolCalls[i];
				if (tc.name === "narrate") hasNarrate = true;
				var result = tools.run(tc.name, tc.input);
				ranCalls.push({
					name: tc.name,
					input: tc.input,
					id: tc.id,
					result: String(result),
					alreadyRun: true
				});
				console.log("[ARCHON]   (phase1) " + tc.name + " -> " + result);
			}

			if (hasNarrate) {
				// Done — Claude obeyed.
				return {
					toolCalls: ranCalls,
					stopReason: first.stopReason,
					raw: firstData
				};
			}

			console.log("[ARCHON] no narrate in phase 1 — forcing follow-up.");

			// Phase 2 — force narrate. Send the prior assistant content (so the
			// API accepts the conversation) plus tool_result blocks for every
			// tool_use, plus a user nudge.
			var assistantContent = (firstData && firstData.content) || [];
			var toolResultBlocks = ranCalls.map(function (rc) {
				return {
					type: "tool_result",
					tool_use_id: rc.id,
					content: rc.result
				};
			});

			return postMessages({
				cfg: cfg,
				system: systemPrompt,
				tools: allTools,
				messages: [
					{ role: "user", content: userMessage },
					{ role: "assistant", content: assistantContent },
					{
						role: "user",
						content: toolResultBlocks.concat([{
							type: "text",
							text: "Now narrate the outcome. Speak in your mythic voice. Use ONLY the narrate tool. One short line."
						}])
					}
				],
				tool_choice: { type: "tool", name: "narrate" }
			}).then(function (secondData) {
				var second = parseResponse(secondData);
				var followupCalls = second.toolCalls.map(function (tc) {
					return { name: tc.name, input: tc.input, id: tc.id };
				});
				if (!followupCalls.length || !followupCalls.some(function (c) { return c.name === "narrate"; })) {
					// Even the forced call didn't produce narrate (rare). Use any
					// text content from either call, or fall back hard.
					var txt = (second.text || first.text || "").trim() ||
						"The Archon acts in silence. You will not always be so lucky.";
					followupCalls.push({ name: "narrate", input: { text: txt } });
				}
				return {
					toolCalls: ranCalls.concat(followupCalls),
					stopReason: second.stopReason,
					raw: { phase1: firstData, phase2: secondData }
				};
			}).catch(function (err) {
				console.error("[ARCHON] follow-up failed:", err);
				// Mutations already applied. Fabricate a narrate from any text
				// we got in phase 1.
				var txt = (first.text || "").trim() ||
					"The Archon acts in silence. You will not always be so lucky.";
				return {
					toolCalls: ranCalls.concat([{ name: "narrate", input: { text: txt } }]),
					stopReason: "followup-failed",
					raw: { phase1: firstData }
				};
			});
		}).catch(function (err) {
			console.error("[ARCHON] phase 1 failed:", err);
			return fallbackResponse(err);
		});
	}

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
			if (!res.ok) {
				return res.text().then(function (t) {
					throw new Error("Anthropic " + res.status + ": " + t);
				});
			}
			return res.json();
		});
	}

	function parseResponse(data) {
		var toolCalls = [];
		var textParts = [];
		var content = (data && data.content) || [];
		for (var i = 0; i < content.length; i++) {
			var block = content[i];
			if (block.type === "tool_use") {
				toolCalls.push({ name: block.name, input: block.input || {}, id: block.id });
			} else if (block.type === "text" && block.text) {
				textParts.push(block.text);
			}
		}
		return {
			toolCalls: toolCalls,
			text: textParts.join(" ").trim(),
			stopReason: data && data.stop_reason
		};
	}

	// Hand-written fallbacks so the demo never dies on a network error or
	// missing key. One is randomly chosen.
	var FALLBACKS = [
		{
			toolCalls: [
				{ name: "multiply_property", input: { target: "monster:*", property: "speed", factor: 0.7 } },
				{ name: "narrate", input: { text: "The mortals slow. I have grown distracted." } }
			]
		},
		{
			toolCalls: [
				{ name: "set_render_filter", input: { filter: "hue-rotate(180deg)", durationMs: 12000 } },
				{ name: "narrate", input: { text: "I have changed the colors of your sky. You are welcome." } }
			]
		},
		{
			toolCalls: [
				{ name: "grant_weapon", input: { type: "h_fireball", ammo: 20 } },
				{ name: "narrate", input: { text: "Take fire, mortal. Do not waste it." } }
			]
		}
	];

	function fallbackResponse(err) {
		var pick = FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
		return {
			toolCalls: pick.toolCalls.slice(),
			stopReason: "fallback",
			raw: { error: err && err.message }
		};
	}

	window.HORDE_GOD = window.HORDE_GOD || {};
	window.HORDE_GOD.client = { callArchon: callArchon };

}());
