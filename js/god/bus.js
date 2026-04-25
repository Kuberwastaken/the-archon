/**
 * THE ARCHON — event bus.
 *
 * Tiny pub/sub. The engine emits domain events ("wave_cleared",
 * "wave_started"); the god module subscribes. No deps.
 */
(function () {

	function Bus() {
		this.handlers = {};
	}

	Bus.prototype.on = function (event, fn) {
		if (!this.handlers[event]) this.handlers[event] = [];
		this.handlers[event].push(fn);
	};

	Bus.prototype.off = function (event, fn) {
		var list = this.handlers[event];
		if (!list) return;
		for (var i = list.length - 1; i >= 0; i--) {
			if (list[i] === fn) list.splice(i, 1);
		}
	};

	Bus.prototype.emit = function (event, data) {
		var list = this.handlers[event];
		if (!list) return;
		for (var i = 0; i < list.length; i++) {
			try {
				list[i](data);
			} catch (e) {
				console.error("[ARCHON bus] handler for " + event + " threw:", e);
			}
		}
	};

	window.HORDE_GOD = window.HORDE_GOD || {};
	window.HORDE_GOD.Bus = Bus;

}());
