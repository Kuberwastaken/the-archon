/**
 * THE ARCHON — intervention orchestrator.
 *
 * Subscribes to wave_cleared. On each clear:
 *   1. Take a snapshot of the world.
 *   2. Call the Anthropic API.
 *   3. Run the returned tool calls in order.
 *   4. Render the narration.
 *
 * Honors GOD_CONFIG.awakenAfterWave (waits for first wave to clear before
 * starting) and GOD_CONFIG.minGapMs (rate limits wave-to-wave bursts).
 */
(function () {

	function Intervention(deps) {
		this.deps = deps;          // { bus, state, client, tools, ui }
		this.busy = false;         // an API call is in flight
		this.lastInterventionAt = 0;
		this.totalInterventions = 0;
	}

	Intervention.prototype.start = function () {
		var self = this;
		this.deps.bus.on("wave_cleared", function (data) {
			self.onWaveCleared(data);
		});
		this.deps.bus.on("wave_started", function (data) {
			// Optional: short subtitle line announcing the new wave.
			// Only do this for boss waves so we don't double-narrate.
			if (data && data.boss && data.bossName) {
				self.deps.ui.setNarration(
					"The " + data.bossName + " stirs.",
					{ slot: "subtitle", durationMs: 2400 }
				);
			}
		});
	};

	Intervention.prototype.onWaveCleared = function (data) {
		var cfg = window.GOD_CONFIG || {};
		if (cfg.enabled === false) return;

		// Wait until awakenAfterWave waves have been cleared.
		var awakenAfter = (cfg.awakenAfterWave != null) ? cfg.awakenAfterWave : 1;
		var clearedWaveNumber = (data && typeof data.waveId === "number") ? data.waveId + 1 : 0;
		if (clearedWaveNumber < awakenAfter) {
			console.log("[ARCHON] silent — waiting until wave " + awakenAfter + " clears (just cleared " + clearedWaveNumber + ")");
			return;
		}

		// Rate limit.
		var now = Date.now();
		var gap = cfg.minGapMs || 4000;
		if (now - this.lastInterventionAt < gap) {
			console.log("[ARCHON] skipping — too soon after last intervention");
			return;
		}

		if (this.busy) {
			console.log("[ARCHON] skipping — previous intervention still running");
			return;
		}

		this.lastInterventionAt = now;
		this.busy = true;

		var self = this;
		var engine = window.engine;
		var snap;
		try {
			snap = self.deps.state.snapshot(engine);
		} catch (e) {
			console.error("[ARCHON] snapshot failed:", e);
			self.busy = false;
			return;
		}

		console.log("[ARCHON] intervention #" + (++self.totalInterventions) + " — snapshot:", snap);

		self.deps.client.callArchon(snap).then(function (resp) {
			self.executeToolCalls(resp.toolCalls || []);
		}).catch(function (err) {
			console.error("[ARCHON] intervention failed:", err);
		}).then(function () {
			self.busy = false;
		});
	};

	Intervention.prototype.executeToolCalls = function (calls) {
		if (!calls.length) {
			console.warn("[ARCHON] no tool calls returned. Silent.");
			return;
		}

		// Cap on un-run mutations. (Calls flagged alreadyRun were executed by
		// the client during phase 1, so they don't count toward the cap.)
		var pendingMutations = 0;
		var capped = [];
		for (var j = 0; j < calls.length; j++) {
			var c = calls[j];
			if (c.alreadyRun) { capped.push(c); continue; }
			if (c.name !== "narrate") {
				if (pendingMutations >= 3) {
					console.warn("[ARCHON] dropping excess mutation:", c.name);
					continue;
				}
				pendingMutations++;
			}
			capped.push(c);
		}
		calls = capped;

		var hasNarrate = calls.some(function (c) { return c.name === "narrate"; });
		// Last-resort fallback. Should be rare — client.js does its own follow-up.
		if (!hasNarrate) {
			calls.push({
				name: "narrate",
				input: { text: "The Archon acts in silence. You will not always be so lucky." }
			});
		}

		console.log("[ARCHON] resolving " + calls.length + " tool calls:", calls);

		for (var i = 0; i < calls.length; i++) {
			var call = calls[i];
			if (call.alreadyRun) {
				console.log("[ARCHON]   " + call.name + " (phase1, already applied)");
				continue;
			}
			var result = this.deps.tools.run(call.name, call.input);
			console.log("[ARCHON]   " + call.name + " -> " + result);
		}
	};

	window.HORDE_GOD = window.HORDE_GOD || {};
	window.HORDE_GOD.Intervention = Intervention;

}());
