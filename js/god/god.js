/**
 * THE ARCHON — boot.
 *
 * Replaces the horde.god stub from base.js with a real, fully-wired god.
 * Subscribes to engine events. Once this loads, the game is haunted.
 *
 * Load order (see index.html):
 *   bus -> ui -> state -> tools -> persona -> client -> intervention -> god
 */
(function () {

	function init() {
		var G = window.HORDE_GOD || {};
		if (!G.Bus || !G.ArchonUI || !G.tools || !G.persona ||
			!G.client || !G.state || !G.Intervention) {
			console.error("[ARCHON] cannot boot — missing modules:", {
				Bus: !!G.Bus, ArchonUI: !!G.ArchonUI, tools: !!G.tools,
				persona: !!G.persona, client: !!G.client, state: !!G.state,
				Intervention: !!G.Intervention
			});
			return;
		}

		var bus = new G.Bus();
		var ui = new G.ArchonUI();

		// Expose ui so tools.js can find it for narrate().
		G.ui = ui;
		G.history = G.history || [];

		var intervention = new G.Intervention({
			bus: bus,
			state: G.state,
			client: G.client,
			tools: G.tools,
			ui: ui
		});
		intervention.start();

		// Replace the stub.
		horde.god = {
			ready: true,
			bus: bus,
			ui: ui,
			tools: G.tools,
			state: G.state,
			history: G.history,
			intervention: intervention,
			drawNarration: function (ctx) { ui.drawNarration(ctx); },
			timeScale: 1,

			// Manual trigger for console testing: horde.god.testIntervention()
			testIntervention: function () {
				intervention.onWaveCleared({ waveId: window.engine ? window.engine.currentWaveId : 0 });
			},

			// Quick console helper to inspect what the Archon would say next.
			previewSnapshot: function () {
				return G.state.snapshot(window.engine);
			}
		};

		console.log(
			"%c[THE ARCHON awakens]%c " + horde.god.tools.list.length +
			" verbs at her command.",
			"color: #e8c547; font-weight: bold; font-size: 14px;",
			"color: inherit;"
		);
	}

	// All dependencies are already loaded synchronously by index.html load
	// order, so init can run immediately. This guarantees horde.god is fully
	// wired before run_game.js constructs the engine and the first frame ticks.
	init();

}());
