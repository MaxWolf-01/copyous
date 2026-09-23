// Evaluated inside the perftest shell through the memtest helper's Eval. Installs globalThis.perf:
// frame timing, a virtual pointer, and the scenario steps perftest.py calls one by one.
const UUID = 'copyous@boerdereinar.dev';
const now = () => GLib.get_monotonic_time();
const ext = () => Main.extensionManager.lookup(UUID).stateObj;
// The list of the dialog; builds before the list had a model called it _scrollContainer
const list = () => {
	const view = ext().clipboardDialog._scrollView;
	return view.list ?? view._scrollContainer;
};

globalThis.perf?.stopFrames();

const seat = Clutter.get_default_backend().get_default_seat();
const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

globalThis.perf = {
	frames: [],
	_ids: [],
	_start: 0,

	startFrames() {
		this.stopFrames();
		this.frames = [];
		this._ids.push(global.stage.connect('before-update', () => (this._start = now())));
		this._ids.push(
			global.stage.connect('after-paint', () => {
				const dialog = ext()?.clipboardDialog;
				this.frames.push([this._start, now(), dialog?.visible ? dialog._dialog.opacity : -1]);
			}),
		);
		return now();
	},

	stopFrames() {
		for (const id of this._ids) global.stage.disconnect(id);
		this._ids = [];
		return this.frames;
	},

	/** Records every block of the main thread longer than a frame: a 1 ms timer that should tick on time */
	watchStalls() {
		this.stopStalls();
		this._blocks = [];
		let last = now();
		this._stallId = GLib.timeout_add(GLib.PRIORITY_HIGH, 1, () => {
			const t = now();
			if (t - last > 17000) this._blocks.push([last, t]);
			last = t;
			return GLib.SOURCE_CONTINUE;
		});
		return now();
	},

	stopStalls() {
		if (this._stallId) GLib.source_remove(this._stallId);
		this._stallId = 0;
	},

	/** How long the main thread was blocked, in total and at most at once, in ms; and when, [start, end] in µs */
	stalls() {
		this.stopStalls();
		const blocks = this._blocks ?? [];
		const durations = blocks.map(([start, end]) => (end - start) / 1000);
		return {
			blocked: durations.reduce((a, b) => a + b, 0),
			longest: Math.max(0, ...durations),
			blocks,
			end: now(),
		};
	},

	move(x, y) {
		pointer.notify_absolute_motion(now(), x, y);
		return now();
	},

	/** Opens the dialog at (x, y) the way the shortcut does; returns [before, after] the synchronous part. */
	open(x, y) {
		pointer.notify_absolute_motion(now(), x, y);
		const t0 = now();
		ext().clipboardDialog.open();
		return [t0, now()];
	},

	close() {
		ext().clipboardDialog.close();
		return now();
	},

	pointAtList() {
		const d = ext().clipboardDialog._scrollView;
		const [x, y] = d.get_transformed_position();
		const [w, h] = d.get_transformed_size();
		return this.move(x + w / 2, y + h / 2);
	},

	/** Touchpad-style scroll: n events of dy pixels, one every intervalMs. */
	scroll(n, dy, intervalMs) {
		let i = 0;
		this.scrolling = true;
		GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
			const last = ++i >= n;
			const finish = last ? Clutter.ScrollFinishFlags.VERTICAL : Clutter.ScrollFinishFlags.NONE;
			pointer.notify_scroll_continuous(now(), 0, last ? 0 : dy, Clutter.ScrollSource.FINGER, finish);
			if (last) this.scrolling = false;
			return last ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
		});
		return now();
	},

	listState() {
		const c = list();
		const a = c.vadjustment;
		return {
			children: c.get_n_children(),
			visible: c.get_children().filter((x) => x.visible).length,
			value: Math.round(a.value),
			upper: Math.round(a.upper),
		};
	},

	/** Types `text` into the search entry, one character every intervalMs, then clears it at once */
	typeSearch(text, intervalMs) {
		const entry = ext().clipboardDialog._header.searchEntry;
		this.keys = [];
		this.typing = true;
		let i = 0;
		GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
			const t0 = now();
			entry.text = text.slice(0, ++i % (text.length + 1));
			this.keys.push([t0, now()]);
			if (i <= text.length) return GLib.SOURCE_CONTINUE;
			this.typing = false;
			return GLib.SOURCE_REMOVE;
		});
		return now();
	},

	/** Presses and releases a key (a Clutter keyval) as the keyboard would; returns [before, after] the press */
	key(keyval) {
		const t0 = now();
		keyboard.notify_keyval(t0, keyval, Clutter.KeyState.PRESSED);
		const t1 = now();
		keyboard.notify_keyval(t1, keyval, Clutter.KeyState.RELEASED);
		return [t0, t1];
	},

	/** True once the history is loaded and highlight.js is in, else what is missing */
	ready() {
		const e = ext();
		if (!e?.clipboardDialog) {
			const state = Main.extensionManager.lookup(UUID)?.state;
			return `extension not enabled (state ${state}, session mode ${Main.sessionMode.currentMode})`;
		}
		if (e.hljs === undefined) return 'highlight.js pending';
		const c = list();
		const n = c._history ? c._history.size : c.get_n_children() - 1;
		return n > 0 || `history pending (${n} entries)`;
	},

	/** What a screen lock and unlock do: disable() and enable() on the loaded extension, settings untouched */
	reenable() {
		const manager = Main.extensionManager;
		manager._callExtensionDisable(UUID).then(() => manager._callExtensionEnable(UUID)).catch(logError);
		return now();
	},

	copyText(text) {
		St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
		return now();
	},

	gc() {
		System.gc();
		return now();
	},
};

return now();
