import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import type CopyousExtension from '../../extension.js';
import { enumParamSpec, registerClass } from '../common/gjs.js';
import { ClipboardEntry } from '../database/database.js';
import { ClipboardScrollContainer } from './clipboardScrollContainer.js';
import { holdImageDecodes } from './components/contentPreview.js';
import { ClipboardItem } from './items/clipboardItem.js';

@registerClass({
	Properties: {
		orientation: enumParamSpec(
			'orientation',
			GObject.ParamFlags.READWRITE,
			Clutter.Orientation,
			Clutter.Orientation.HORIZONTAL,
		),
	},
})
export class ClipboardScrollView extends St.ScrollView {
	private _orientation: Clutter.Orientation = Clutter.Orientation.HORIZONTAL;
	private _itemWidth: number = 0;
	private _itemHeight: number = 0;

	readonly list: ClipboardScrollContainer;

	constructor(
		private ext: CopyousExtension,
		createItem: (entry: ClipboardEntry) => ClipboardItem | null,
	) {
		super({
			style_class: 'clipboard-scroll-view',
			hscrollbar_policy: St.PolicyType.AUTOMATIC,
			vscrollbar_policy: St.PolicyType.NEVER,
			overlay_scrollbars: true,
			min_height: 0,
			effect: new St.ScrollViewFade({
				fade_margins: new Clutter.Margin({
					top: 12,
					bottom: 12,
					left: 12,
					right: 12,
				}),
			}),
		});

		this.list = new ClipboardScrollContainer(ext, createItem);
		this.set_child(this.list);

		this.connect('notify::width', this.scrollbarWorkaround.bind(this));
		this.list.connect('notify::width', this.scrollbarWorkaround.bind(this));

		// Reveal more matches as scrolling approaches either end of the window
		this.hadjustment.connect('notify::value', () => this.onScrolled());
		this.vadjustment.connect('notify::value', () => this.onScrolled());

		// Without overflow there are no scroll events, so hidden matches would be
		// unreachable by mouse; keep revealing until the list overflows or runs out
		this.hadjustment.connect('notify::upper', () => this.list.revealProgressively(0));
		this.vadjustment.connect('notify::upper', () => this.list.revealProgressively(0));
		this.hadjustment.connect('notify::page-size', () => this.list.revealProgressively(0));
		this.vadjustment.connect('notify::page-size', () => this.list.revealProgressively(0));

		// Connect properties
		this.ext.settings.connectObject(
			'changed::show-scrollbar',
			this.updateScrollbar.bind(this),
			'changed::item-width',
			this.updateSize.bind(this),
			'changed::item-height',
			this.updateSize.bind(this),
			this,
		);

		this.updateSize();
		this.updateScrollbar();

		this.bind_property('orientation', this.list, 'orientation', GObject.BindingFlags.SYNC_CREATE);
	}

	get orientation(): Clutter.Orientation {
		return this._orientation;
	}

	set orientation(value: Clutter.Orientation) {
		if (this._orientation === value) return;

		this._orientation = value;
		this.notify('orientation');
		this.updateScrollbar();
	}

	private onScrolled() {
		// Adjustment resets while mapping are not user scrolling
		if (!this.list.mapped) return;

		holdImageDecodes();
		this.list.revealProgressively();
	}

	private updateSize() {
		this._itemWidth = this.ext.settings.get_int('item-width');
		this._itemHeight = this.ext.settings.get_int('item-height');
	}

	private updateScrollbar() {
		const show = this.ext.settings.get_boolean('show-scrollbar');

		if (!show) {
			this.vscrollbarPolicy = St.PolicyType.NEVER;
			this.hscrollbarPolicy = St.PolicyType.NEVER;
		} else if (this._orientation === Clutter.Orientation.HORIZONTAL) {
			this.vscrollbarPolicy = St.PolicyType.NEVER;
			this.hscrollbarPolicy = St.PolicyType.AUTOMATIC;
		} else {
			this.vscrollbarPolicy = St.PolicyType.AUTOMATIC;
			this.hscrollbarPolicy = St.PolicyType.NEVER;
		}
	}

	private scrollbarWorkaround(): void {
		// Workaround for horizontal scrollbar not auto hiding
		const show = this.ext.settings.get_boolean('show-scrollbar');
		if (show && this.orientation === Clutter.Orientation.HORIZONTAL) {
			if (this.allocation.get_width() > this.list.allocation.get_width()) {
				this.hscrollbarPolicy = St.PolicyType.EXTERNAL;
			} else {
				this.hscrollbarPolicy = St.PolicyType.AUTOMATIC;
			}
		}
	}

	override vfunc_key_press_event(event: Clutter.Event): boolean {
		const key = event.get_key_symbol();

		if (key === Clutter.KEY_Home) {
			this.list.home();
			return Clutter.EVENT_STOP;
		}

		if (key === Clutter.KEY_End) {
			this.list.end();
			return Clutter.EVENT_STOP;
		}

		return super.vfunc_key_press_event(event);
	}

	override vfunc_scroll_event(event: Clutter.Event): boolean {
		let delta = 0;
		let animate = false;

		const scrollSource = event.get_scroll_source();
		const direction = event.get_scroll_direction();
		if (scrollSource === Clutter.ScrollSource.WHEEL || scrollSource === Clutter.ScrollSource.UNKNOWN) {
			if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT) {
				delta = -1;
			} else if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.RIGHT) {
				delta = 1;
			}
			animate = true;
		} else if (direction === Clutter.ScrollDirection.SMOOTH) {
			delta = event.get_scroll_delta()[this.orientation]!;
		}

		if (delta === 0) return Clutter.EVENT_STOP;

		const spacing = (this.list.get_layout_manager() as Clutter.BoxLayout).spacing;

		let adjustment: St.Adjustment;
		let step: number;
		if (this._orientation === Clutter.Orientation.HORIZONTAL) {
			adjustment = this.hadjustment;
			step = this._itemWidth + spacing;
		} else {
			adjustment = this.vadjustment;
			step = this._itemHeight + spacing;
		}

		// Extend previous animation or current value
		const transition = adjustment.get_transition('value');
		let start = (transition?.interval.final as unknown as number | undefined) ?? adjustment.value;
		if ((start < adjustment.value && delta > 0) || (start > adjustment.value && delta < 0)) {
			start = adjustment.value;
		}

		const value = Math.clamp(start + delta * step, adjustment.lower, adjustment.upper);

		if (value === adjustment.value) return Clutter.EVENT_STOP;

		if (animate) {
			adjustment.ease(value, {
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});
		} else {
			adjustment.value = value;
		}

		return Clutter.EVENT_STOP;
	}

	override destroy() {
		this.ext.settings.disconnectObject(this);

		super.destroy();
	}
}
