/**
 * THE ARCHON — game-state snapshot.
 *
 * Builds a compact, human-readable view of the current world for the LLM.
 * Token budget target: ~250 tokens. Keep this lean — every wave clear
 * sends one of these.
 */
(function () {

	function snapshot(engine) {
		if (!engine) {
			return { error: "no engine" };
		}

		var out = {
			wave: snapshotWave(engine),
			player: snapshotPlayer(engine),
			arena: snapshotArena(engine),
			recentMutations: getRecentMutations(5)
		};

		return out;
	}

	function snapshotWave(engine) {
		var total = (engine.waves && engine.waves.length) || 0;
		var current = (typeof engine.currentWaveId === "number") ? engine.currentWaveId : -1;
		var nextWave = engine.waves && engine.waves[current + 1];
		return {
			justClearedWave: current + 1, // 1-based for the LLM
			totalWaves: total,
			nextWaveIsBoss: !!(nextWave && nextWave.bossWave),
			nextWaveBossName: (nextWave && nextWave.bossName) || null,
			nextWaveEnemyTypes: nextWave ? listNextWaveEnemyTypes(nextWave) : []
		};
	}

	function listNextWaveEnemyTypes(wave) {
		var types = {};
		if (!wave || !wave.points) return [];
		for (var i = 0; i < wave.points.length; i++) {
			var pt = wave.points[i];
			for (var j = 0; j < (pt.objects || []).length; j++) {
				var o = pt.objects[j];
				types[o.type] = (types[o.type] || 0) + (o.count || 1);
			}
		}
		return Object.keys(types).map(function (k) {
			return { type: k, count: types[k] };
		});
	}

	function snapshotPlayer(engine) {
		var player = engine.getPlayerObject ? engine.getPlayerObject() : null;
		if (!player) return { error: "no player" };

		var hpMax = player.hitPoints || 1;
		var hpCur = Math.max(0, hpMax - (player.wounds || 0));
		var hpPct = Math.round((hpCur / hpMax) * 100);

		var weapons = (player.weapons || []).map(function (w) {
			return { type: w.type, ammo: (w.count == null ? "infinite" : w.count) };
		});

		return {
			hpPercent: hpPct,
			hp: hpCur,
			hpMax: hpMax,
			gold: player.gold || 0,
			kills: player.kills || 0,
			speed: player.speed || 0,
			weapons: weapons,
			currentWeapon: weapons[player.currentWeaponIndex || 0] || null
		};
	}

	function snapshotArena(engine) {
		var counts = {};
		var totalAlive = 0;
		var objs = engine.objects || {};
		for (var id in objs) {
			var o = objs[id];
			if (!o || o.role !== "monster") continue;
			counts[o.type] = (counts[o.type] || 0) + 1;
			totalAlive++;
		}
		return { aliveMonsters: counts, totalAlive: totalAlive };
	}

	function getRecentMutations(n) {
		var hist = (window.HORDE_GOD && window.HORDE_GOD.history) || [];
		return hist.slice(-n).map(function (r) {
			return { tool: r.tool, args: r.args, result: r.result };
		});
	}

	window.HORDE_GOD = window.HORDE_GOD || {};
	window.HORDE_GOD.state = { snapshot: snapshot };

}());
