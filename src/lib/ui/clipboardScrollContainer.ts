import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import type CopyousExtension from '../../extension.js';
import { registerClass } from '../common/gjs.js';
import {
	get_first_visible_child,
	get_last_visible_child,
	get_n_visible_children,
	get_next_visible_sibling,
	get_previous_visible_sibling,
} from '../misc/actor.js';
import { ClipboardItem } from './items/clipboardItem.js';
import { State, StatusItem } from './items/statusItem.js';
import { SearchChange, SearchQuery } from './searchEntry.js';

// Number of matched items shown when the dialog opens: enough to fill it. Only
// windowed items become actors on screen; mapping and laying out the full
// history on every open is what froze the shell (#150).
const WINDOW_START = 10;

// Matched items revealed per frame once the dialog is open, until all are. An
// item shown for the first time costs a few ms of style, layout and paint;
// revealing twenty in one frame froze scrolling for over 100 ms.
const REVEAL_STEP = 2;

@registerClass()
export class ClipboardScrollContainer extends St.BoxLayout {
	private readonly _statusItem: StatusItem;
	private _lastFocus: Clutter.Actor | null = null;
	private _lastQuery: SearchQuery | null = null;
	private _revealed: number = WINDOW_START;
	private _revealLaterId: number = 0;
	private _prewarmId: number = 0;

	constructor(ext: CopyousExtension) {
		super({
			style_class: 'clipboard-item-list',
			x_align: Clutter.ActorAlign.START,
			x_expand: false,
		});

		this._statusItem = new StatusItem(ext);
		this.updateVisible();

		this.connect('destroy', () => {
			this.stopRevealing();
			if (this._prewarmId) GLib.source_remove(this._prewarmId);
			this._prewarmId = 0;
		});
	}

	private applyWindow(): void {
		let rank = 0;
		for (const child of this.get_children()) {
			if (!(child instanceof ClipboardItem)) continue;
			child.visible = child.matched && rank < this._revealed;
			if (child.matched) rank++;
		}
	}

	private setRevealed(revealed: number): void {
		this.removePseudoclasses();
		this._revealed = revealed;
		this.applyWindow();
		this.updateVisible();
	}

	public revealMore(): void {
		if (!this.hasHiddenMatches()) return;
		this.setRevealed(this._revealed + REVEAL_STEP);
	}

	public revealAll(): void {
		if (!this.hasHiddenMatches()) return;
		this.setRevealed(Number.MAX_SAFE_INTEGER);
	}

	/** Reveals the hidden matches a few per frame, before each frame's layout, for as long as the list is shown */
	public revealProgressively(): void {
		if (this._revealLaterId || !this.mapped || !this.hasHiddenMatches()) return;

		this._revealLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
			if (this.mapped && this.hasHiddenMatches()) {
				this.setRevealed(this._revealed + REVEAL_STEP);
				return GLib.SOURCE_CONTINUE;
			}

			this._revealLaterId = 0;
			return GLib.SOURCE_REMOVE;
		});
	}

	private stopRevealing(): void {
		if (this._revealLaterId) global.compositor.get_laters().remove(this._revealLaterId);
		this._revealLaterId = 0;
	}

	public resetWindow(): void {
		this.stopRevealing();
		this.setRevealed(WINDOW_START);
	}

	/**
	 * Computes the styles and text layouts of the items the next open shows, one item per idle, while the dialog is
	 * hidden. Items created by enable(), which every screen unlock calls, otherwise all pay for them in the first
	 * frame of the next open.
	 */
	public prewarm(): void {
		if (this._prewarmId || this.mapped) return;

		// Items keep arriving while enable() loads the history, so the list is looked up again on every step
		let next = 0;
		this._prewarmId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
			const items = this.get_children().filter((c) => c instanceof ClipboardItem && c.visible);
			const item = items[next++];
			if (item instanceof ClipboardItem && !this.mapped) {
				item.prewarm();
				return GLib.SOURCE_CONTINUE;
			}

			this._prewarmId = 0;
			return GLib.SOURCE_REMOVE;
		});
	}

	private hasHiddenMatches(): boolean {
		let matched = 0;
		for (const child of this.get_children()) {
			if (child instanceof ClipboardItem && child.matched && ++matched > this._revealed) return true;
		}
		return false;
	}

	private updateVisible() {
		const n = get_n_visible_children(this);
		if (n === 0) {
			this.add_child(this._statusItem);
			this.x_align = Clutter.ActorAlign.CENTER;
			this.x_expand = true;

			if (this.get_n_children() === 1) {
				this._statusItem.state = State.Empty;
			} else {
				this._statusItem.state = State.NoResults;
			}
		} else if (n >= 2 && this._statusItem.get_parent() !== null) {
			this.remove_child(this._statusItem);
			this.x_align = Clutter.ActorAlign.START;
			this.x_expand = false;
		}

		this.updatePseudoclasses();
	}

	private removePseudoclasses(): void {
		(get_first_visible_child(this) as St.Widget | null)?.remove_style_pseudo_class('first-child');
		(get_last_visible_child(this) as St.Widget | null)?.remove_style_pseudo_class('last-child');
	}

	private updatePseudoclasses(): void {
		(get_first_visible_child(this) as St.Widget | null)?.add_style_pseudo_class('first-child');
		(get_last_visible_child(this) as St.Widget | null)?.add_style_pseudo_class('last-child');
	}

	private nextFocus(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		const newFocus = get_next_visible_sibling(child) ?? get_previous_visible_sibling(child);
		if (newFocus && newFocus !== this._statusItem) {
			this.focusChild(newFocus, animate);
		} else {
			// Navigate to the search entry
			global.focus_manager.get_group(this).grab_key_focus();
		}
	}

	public focusChild(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		this._lastFocus = child;
		child.grab_key_focus();
		this.scrollToChild(child, animate);
	}

	public scrollToFocus(animate: boolean = true): void {
		for (const child of this.get_children()) {
			if (child.has_key_focus()) {
				this._lastFocus = child;
				this.scrollToChild(child, animate);
				return;
			}
		}
	}

	public scrollToChild(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		const box = child.get_allocation_box();
		let adjustment: St.Adjustment;
		let value: number;
		if (this.orientation === Clutter.Orientation.HORIZONTAL) {
			adjustment = this.hadjustment;
			value = box.x1 + box.get_width() * 0.5 - adjustment.page_size * 0.5;
		} else {
			adjustment = this.vadjustment;
			value = box.y1 + box.get_height() * 0.5 - adjustment.page_size * 0.5;
		}

		if (this.text_direction === Clutter.TextDirection.RTL) {
			value = adjustment.get_upper() - adjustment.page_size - value;
		}

		if (animate) {
			adjustment.ease(value, { duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
		} else {
			adjustment.value = value;
		}
	}

	public addItem(item: ClipboardItem): void {
		this.insertOrMoveItem(item);

		// The connections go with the item: a destroyed item must not be re-inserted or searched
		item.entry.connectObject(
			// Move item when datetime changes
			'notify::datetime',
			() => this.insertOrMoveItem(item, false),
			// Delete item when deleted
			'delete',
			() => this.removeItem(item),
			// Update search only when properties used by search can change.
			'notify::content',
			() => this.updateSearch(item),
			'notify::pinned',
			() => this.updateSearch(item),
			'notify::tag',
			() => this.updateSearch(item),
			'notify::type',
			() => this.updateSearch(item),
			'notify::metadata',
			() => this.updateSearch(item),
			'notify::title',
			() => this.updateSearch(item),
			item,
		);
	}

	private insertOrMoveItem(item: ClipboardItem, search: boolean = true): void {
		this.removePseudoclasses();

		if (item.get_parent() === this) this.remove_child(item);

		let i = 0;
		for (const c of this.get_children()) {
			if (c instanceof ClipboardItem && c.entry.datetime.compare(item.entry.datetime) <= 0) {
				this.insert_child_at_index(item, i);
				break;
			}
			i++;
		}

		if (i === this.get_n_children()) {
			this.add_child(item);
		}

		if (search && this._lastQuery) {
			this.updateSearch(item);
		} else {
			this.applyWindow();
			this.updateVisible();
		}
	}

	public clearItems(): void {
		this._revealed = WINDOW_START;
		let focus = false;
		for (const child of this.get_children()) {
			if (child instanceof ClipboardItem) {
				focus ||= child.has_key_focus();
				// Destroyed, not just removed: an item still connected to the settings never gets collected
				child.destroy();
			}
		}
		this.updateVisible();

		if (focus) {
			// Navigate to the search entry
			global.focus_manager.get_group(this).navigate_focus(this, St.DirectionType.UP, true);
		}
	}

	public removeItem(child: ClipboardItem): void {
		if (child.get_parent() !== this) return;

		const hasKeyFocus = child.has_key_focus();
		const index = this.get_children().indexOf(child);

		child.destroy();
		this.applyWindow();
		this.updateVisible();

		if (hasKeyFocus) {
			// Pick the new focus only after the window is reapplied: removing the
			// last revealed item reveals its successor, which should get the focus
			const children = this.get_children();
			let newFocus: Clutter.Actor | null = null;
			for (let i = index; i < children.length && !newFocus; i++) {
				if (children[i]!.visible) newFocus = children[i]!;
			}
			for (let i = Math.min(index, children.length) - 1; i >= 0 && !newFocus; i--) {
				if (children[i]!.visible) newFocus = children[i]!;
			}

			if (newFocus && newFocus !== this._statusItem) {
				this.focusChild(newFocus);
			} else {
				this._lastFocus = null;

				// Navigate to the search entry
				global.focus_manager.get_group(this).navigate_focus(this, St.DirectionType.UP, true);
			}
		}
	}

	public selectItem(index: number): boolean {
		let i = 0;
		for (const child of this.get_children()) {
			if (child instanceof ClipboardItem && child.visible) {
				if (i === index) {
					this.focusChild(child);
					return true;
				}

				i++;
			}
		}

		return false;
	}

	public selectNextItem() {
		let focusChild: ClipboardItem | null = null;

		for (const child of this.get_children()) {
			if (focusChild === null && child instanceof ClipboardItem && child.visible) {
				focusChild = child;
			}

			if (child.has_key_focus()) {
				this.nextFocus(child);
				return;
			}
		}

		if (focusChild !== null) {
			this.focusChild(focusChild);
		}
	}

	public search(query: SearchQuery): void {
		// Copy search query, but with SearchChange.Different to always force re-search
		this._lastQuery = query.withChange(SearchChange.Different);

		this.removePseudoclasses();
		let focusChild: ClipboardItem | null = null;
		for (const child of this.get_children()) {
			if (child instanceof ClipboardItem) {
				if (child.has_key_focus()) focusChild = child;
				child.search(query);
			}
		}

		this._revealed = WINDOW_START;
		this.applyWindow();
		this.revealProgressively();

		let firstVisible: ClipboardItem | null = null;
		for (const child of this.get_children()) {
			if (child instanceof ClipboardItem && child.visible) {
				firstVisible = child;
				break;
			}
		}
		this.updateVisible();

		if (focusChild && focusChild.visible) {
			this.focusChild(focusChild, false);
		} else if (this._lastFocus && this._lastFocus.visible) {
			this.scrollToChild(this._lastFocus, false);
		} else if (this._lastFocus instanceof ClipboardItem && this._lastFocus.matched) {
			// Still matching, only outside the window: don't steal key focus
		} else if (firstVisible !== null) {
			this.focusChild(firstVisible, false);
		}
	}

	private updateSearch(item: ClipboardItem): void {
		if (!this._lastQuery) return;

		const hasKeyFocus = item.has_key_focus();
		this.removePseudoclasses();
		item.search(this._lastQuery);
		this.applyWindow();
		this.updateVisible();
		if (hasKeyFocus && !item.visible) this.nextFocus(item, false);
	}

	public activateFirst(): void {
		const first = get_first_visible_child(this);
		if (first instanceof St.Button) {
			first.vfunc_clicked(1);
		}
	}

	override vfunc_navigate_focus(from: Clutter.Actor | null, direction: St.DirectionType): boolean {
		// Navigation from the search entry
		if (from?.get_parent() !== this) {
			// If tab navigation is used, then focus on first or last child
			if (direction === St.DirectionType.TAB_FORWARD || direction === St.DirectionType.TAB_BACKWARD) {
				this._lastFocus = null;
				const child =
					direction === St.DirectionType.TAB_BACKWARD
						? get_last_visible_child(this)
						: get_first_visible_child(this);
				if (child !== this._statusItem) {
					this._lastFocus = child;
				}
			}

			// If the last focus is null or not visible, then focus the first visible child
			if (this._lastFocus === null || !this._lastFocus.visible || this._lastFocus.get_parent() !== this) {
				this._lastFocus = null;
				const child = get_first_visible_child(this);
				if (child !== this._statusItem) {
					this._lastFocus = child;
				}
			}

			// Navigate to the search entry
			if (!this._lastFocus) return Clutter.EVENT_PROPAGATE;

			this._lastFocus.grab_key_focus();
			this.scrollToChild(this._lastFocus);
			return Clutter.EVENT_STOP;
		}

		// Keyboard navigation past the last revealed item extends the window
		const forwardKey =
			this.orientation === Clutter.Orientation.HORIZONTAL ? St.DirectionType.RIGHT : St.DirectionType.DOWN;
		if (
			from === get_last_visible_child(this) &&
			(direction === St.DirectionType.TAB_FORWARD || direction === forwardKey)
		) {
			this.revealMore();
		}

		const first = get_first_visible_child(this);
		const last = get_last_visible_child(this);
		if (this.orientation === Clutter.Orientation.HORIZONTAL) {
			// If up or shift tab navigation then focus the search entry
			if (direction === St.DirectionType.UP) {
				this._lastFocus = from;
				// Navigate to the search entry
				return Clutter.EVENT_PROPAGATE;
			}

			// Ignore down navigation
			if (direction === St.DirectionType.DOWN) {
				return Clutter.EVENT_STOP;
			}
		} else {
			// If on the first child then focus the search entry
			if (from === first && direction === St.DirectionType.UP) {
				this._lastFocus = from;
				// Navigate to the search entry
				return Clutter.EVENT_PROPAGATE;
			}

			// If on the last child then focus on footer
			if (from === last && direction === St.DirectionType.DOWN) {
				this._lastFocus = from;
				return Clutter.EVENT_PROPAGATE;
			}

			// Ignore left and right navigation
			if (direction === St.DirectionType.LEFT || direction === St.DirectionType.RIGHT) {
				return Clutter.EVENT_STOP;
			}
		}

		// If on first child and shift tab navigation then focus the search entry
		if (from === first && direction === St.DirectionType.TAB_BACKWARD) {
			this._lastFocus = from;
			// Navigate to the search entry
			return Clutter.EVENT_PROPAGATE;
		}

		// If on last child and tab navigation then focus the footer
		if (from === last && direction === St.DirectionType.TAB_FORWARD) {
			this._lastFocus = from;
			// Navigate to footer
			return Clutter.EVENT_PROPAGATE;
		}

		// Otherwise map navigation to tab navigation due to weird behavior for a larger number of items
		const tabDirection =
			direction === St.DirectionType.TAB_FORWARD ||
			direction === St.DirectionType.RIGHT ||
			direction === St.DirectionType.DOWN
				? St.DirectionType.TAB_FORWARD
				: St.DirectionType.TAB_BACKWARD;
		const res = super.vfunc_navigate_focus(from, tabDirection);
		this.scrollToFocus();
		return res;
	}

	override vfunc_map(): void {
		this._lastFocus = null;
		this.hadjustment.value = 0;
		this.vadjustment.value = 0;

		super.vfunc_map();
	}
}
