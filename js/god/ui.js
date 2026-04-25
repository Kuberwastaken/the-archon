/**
 * THE ARCHON — narration UI.
 *
 * Renders the Archon's voice as canvas text in MedievalSharp (the same font
 * the rest of the game uses for wave headers and copyright). Two render
 * slots: a large BANNER (top third, between waves) and a smaller SUBTITLE
 * (bottom, mid-wave reactions). Both fade in/out.
 *
 * Public API:
 *   ArchonUI.setNarration(text, opts)  -> queue / replace narration
 *   ArchonUI.drawNarration(ctx)        -> called from engine.render()
 *   ArchonUI.tick(now)                 -> internal clock; called by drawNarration
 */
(function () {

	var SCREEN_WIDTH = 640;
	var SCREEN_HEIGHT = 480;

	// Defaults tuned by eye against the existing wave text.
	var DEFAULTS = {
		banner:   { y: 110, fontSize: 26, fadeIn: 250, hold: 4500, fadeOut: 600, color: "rgb(232, 197, 71)" },
		subtitle: { y: 380, fontSize: 16, fadeIn: 150, hold: 2200, fadeOut: 350, color: "rgb(232, 197, 71)" }
	};

	function makeSlot(name) {
		return {
			name: name,
			active: false,
			text: "",
			startedAt: 0,
			fadeIn: 0,
			hold: 0,
			fadeOut: 0,
			color: "",
			fontSize: 0,
			y: 0
		};
	}

	function ArchonUI() {
		this.slots = {
			banner: makeSlot("banner"),
			subtitle: makeSlot("subtitle")
		};
	}

	/**
	 * Display narration text.
	 * @param {string} text - The line to render. Wraps to ~38 chars per line.
	 * @param {object} opts - { slot: "banner"|"subtitle", durationMs?, color? }
	 */
	ArchonUI.prototype.setNarration = function (text, opts) {
		opts = opts || {};
		var slotName = opts.slot || "banner";
		var d = DEFAULTS[slotName] || DEFAULTS.banner;
		var slot = this.slots[slotName];
		var hold = (opts.durationMs != null) ? opts.durationMs : d.hold;

		slot.active = true;
		slot.text = String(text || "");
		slot.startedAt = (typeof performance !== "undefined" ? performance.now() : Date.now());
		slot.fadeIn = d.fadeIn;
		slot.hold = hold;
		slot.fadeOut = d.fadeOut;
		slot.color = opts.color || d.color;
		slot.fontSize = d.fontSize;
		slot.y = d.y;
	};

	ArchonUI.prototype.clear = function (slotName) {
		if (slotName) {
			this.slots[slotName] && (this.slots[slotName].active = false);
		} else {
			this.slots.banner.active = false;
			this.slots.subtitle.active = false;
		}
	};

	// Wrap text by character count. Crude, but MedievalSharp is roughly
	// monospaced enough at this size that a char limit reads cleanly.
	function wrap(text, charsPerLine) {
		var words = text.split(/\s+/);
		var lines = [];
		var line = "";
		for (var i = 0; i < words.length; i++) {
			var w = words[i];
			if (!line) {
				line = w;
			} else if ((line + " " + w).length <= charsPerLine) {
				line += " " + w;
			} else {
				lines.push(line);
				line = w;
			}
		}
		if (line) lines.push(line);
		return lines;
	}

	ArchonUI.prototype.drawNarration = function (ctx) {
		var now = (typeof performance !== "undefined" ? performance.now() : Date.now());
		this._drawSlot(ctx, this.slots.banner, now);
		this._drawSlot(ctx, this.slots.subtitle, now);
	};

	ArchonUI.prototype._drawSlot = function (ctx, slot, now) {
		if (!slot.active || !slot.text) return;

		var elapsed = now - slot.startedAt;
		var total = slot.fadeIn + slot.hold + slot.fadeOut;
		if (elapsed >= total) {
			slot.active = false;
			return;
		}

		var alpha;
		if (elapsed < slot.fadeIn) {
			alpha = elapsed / slot.fadeIn;
		} else if (elapsed < slot.fadeIn + slot.hold) {
			alpha = 1;
		} else {
			alpha = 1 - ((elapsed - slot.fadeIn - slot.hold) / slot.fadeOut);
		}
		alpha = Math.max(0, Math.min(1, alpha));

		var charsPerLine = (slot.name === "banner") ? 32 : 56;
		var lines = wrap(slot.text, charsPerLine);
		var lineHeight = slot.fontSize + 6;

		ctx.save();
		ctx.globalAlpha = alpha;
		ctx.font = "Bold " + slot.fontSize + "px MedievalSharp";
		ctx.textAlign = "center";
		ctx.textBaseline = "top";

		var startY = slot.y - ((lines.length - 1) * lineHeight) / 2;

		for (var i = 0; i < lines.length; i++) {
			var y = startY + i * lineHeight;

			// Drop shadow / outline (the existing wave text uses this style).
			ctx.fillStyle = "rgb(0, 0, 0)";
			ctx.fillText(lines[i], SCREEN_WIDTH / 2 + 2, y + 2);

			// Foreground gold.
			ctx.fillStyle = slot.color;
			ctx.fillText(lines[i], SCREEN_WIDTH / 2, y);
		}

		ctx.restore();
	};

	window.HORDE_GOD = window.HORDE_GOD || {};
	window.HORDE_GOD.ArchonUI = ArchonUI;

}());
