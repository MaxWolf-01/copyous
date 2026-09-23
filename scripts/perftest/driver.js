// Evaluated inside the perftest shell through the memtest helper's Eval. Installs globalThis.perf:
// frame timing, a virtual pointer, and the scenario steps perftest.py calls one by one.
const UUID = 'copyous@boerdereinar.dev';
const now = () => GLib.get_monotonic_time();
const ext = () => Main.extensionManager.lookup(UUID).stateObj;

globalThis.perf?.stopFrames();

const seat = Clutter.get_default_backend().get_default_seat();
const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);

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
		const c = ext().clipboardDialog._scrollView._scrollContainer;
		const a = c.vadjustment;
		return {
			children: c.get_n_children(),
			visible: c.get_children().filter((x) => x.visible).length,
			value: Math.round(a.value),
			upper: Math.round(a.upper),
		};
	},

	/** True once the history is loaded and highlight.js is in, else what is missing */
	ready() {
		const e = ext();
		if (!e?.clipboardDialog) {
			const state = Main.extensionManager.lookup(UUID)?.state;
			return `extension not enabled (state ${state}, session mode ${Main.sessionMode.currentMode})`;
		}
		if (e.hljs === undefined) return 'highlight.js pending';
		const n = e.clipboardDialog._scrollView._scrollContainer.get_n_children();
		return n > 1 || `history pending (${n} children)`;
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
