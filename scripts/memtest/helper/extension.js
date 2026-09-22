import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import System from 'system';

const BUS_NAME = 'org.copyous.Memtest';
const OBJECT_PATH = '/org/copyous/Memtest';
const INTERFACE = `
<node>
	<interface name="org.copyous.Memtest">
		<method name="Eval">
			<arg type="s" direction="in" name="expression"/>
			<arg type="s" direction="out" name="json"/>
		</method>
		<method name="CopyImage">
			<arg type="s" direction="in" name="path"/>
		</method>
		<method name="StallStart"/>
		<method name="StallStop">
			<arg type="d" direction="out" name="longest_ms"/>
		</method>
		<method name="Screenshot">
			<arg type="s" direction="in" name="path"/>
		</method>
		<method name="SetScale">
			<arg type="d" direction="in" name="scale"/>
			<arg type="d" direction="out" name="applied"/>
		</method>
	</interface>
</node>`;

const DISPLAY_CONFIG = ['org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig'];

function callDisplayConfig(method, parameters) {
	return new Promise((resolve, reject) => {
		Gio.DBus.session.call(...DISPLAY_CONFIG, method, parameters, null, Gio.DBusCallFlags.NONE, -1, null, (bus, res) => {
			try {
				resolve(bus.call_finish(res));
			} catch (e) {
				reject(e);
			}
		});
	});
}

export default class MemtestHelper extends Extension {
	enable() {
		this._exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE, this);
		this._exported.export(Gio.DBus.session, OBJECT_PATH);
		this._ownerId = Gio.DBus.session.own_name(BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
	}

	disable() {
		this.StallStop();
		Gio.DBus.session.unown_name(this._ownerId);
		this._exported.unexport();
		this._exported = null;
	}

	// The expression sees the shell's modules by these names; its value comes back as JSON.
	Eval(expression) {
		const fn = new Function('Main', 'St', 'Clutter', 'Gio', 'GLib', 'System', `return (${expression});`);
		return JSON.stringify(fn(Main, St, Clutter, Gio, GLib, System)) ?? 'null';
	}

	// Puts a PNG on the clipboard the way an application would, so Copyous records it.
	CopyImage(path) {
		const [, contents] = Gio.File.new_for_path(path).load_contents(null);
		St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(contents));
	}

	// Between StallStart and StallStop a 1 ms timer runs on the shell's main loop. The longest gap
	// between two of its ticks is the longest time the main thread, which is also the compositor's,
	// spent in one piece of work.
	StallStart() {
		this.StallStop();
		this._longestGap = 0;
		let last = GLib.get_monotonic_time();
		this._stallId = GLib.timeout_add(GLib.PRIORITY_HIGH, 1, () => {
			const now = GLib.get_monotonic_time();
			this._longestGap = Math.max(this._longestGap, now - last);
			last = now;
			return GLib.SOURCE_CONTINUE;
		});
	}

	StallStop() {
		if (this._stallId) GLib.source_remove(this._stallId);
		this._stallId = 0;
		return (this._longestGap ?? 0) / 1000;
	}

	// Writes the stage as a PNG.
	ScreenshotAsync([path], invocation) {
		const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
		new Shell.Screenshot().screenshot(false, stream, (screenshot, result) => {
			try {
				screenshot.screenshot_finish(result);
				stream.close(null);
				invocation.return_value(null);
			} catch (e) {
				invocation.return_dbus_error('org.copyous.Memtest.Error', `${e}`);
			}
		});
	}

	// Rescales the first monitor to the supported scale nearest to the request.
	async SetScaleAsync([scale], invocation) {
		try {
			const state = await callDisplayConfig('GetCurrentState', null);
			const [serial, monitors, , properties] = state.recursiveUnpack();
			const [[connector], modes] = monitors[0];
			const [modeId, , , , , supportedScales] = modes.find((mode) => mode[6]['is-current']);
			const applied = supportedScales.reduce((a, b) => (Math.abs(b - scale) < Math.abs(a - scale) ? b : a));

			const logicalMonitors = [[0, 0, applied, 0, true, [[connector, modeId, {}]]]];
			const config = { 'layout-mode': new GLib.Variant('u', properties['layout-mode'] ?? 1) };
			await callDisplayConfig(
				'ApplyMonitorsConfig',
				new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [serial, 1, logicalMonitors, config]),
			);
			invocation.return_value(new GLib.Variant('(d)', [applied]));
		} catch (e) {
			invocation.return_dbus_error('org.copyous.Memtest.Error', `${e}`);
		}
	}
}
