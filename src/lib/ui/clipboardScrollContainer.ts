import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import type CopyousExtension from '../../extension.js';
import { registerClass } from '../common/gjs.js';
import { HistoryList, SearchQuery } from '../common/historyList.js';
import { ClipboardEntry } from '../database/database.js';
import {
	get_first_visible_child,
	get_last_visible_child,
	get_next_visible_sibling,
	get_previous_visible_sibling,
} from '../misc/actor.js';
import { ClipboardItem } from './items/clipboardItem.js';
import { searchTexts } from './items/items.js';
import { State, StatusItem } from './items/statusItem.js';

// The window shows this many matches from the start or the end of the list, enough to fill the dialog. Only the
// window's entries have their items shown. An item costs about a millisecond to build and holds its widgets and
// textures, so the length of the history must not decide how many exist (#150).
const WINDOW = 10;

// Matches revealed per frame once the dialog is open, while fewer than REVEAL_AHEAD pages of them lie beyond the
// visible part. An item shown for the first time costs a few ms of style, layout and paint; revealing twenty in one
// frame froze scrolling for over 100 ms.
const REVEAL_STEP = 2;
const REVEAL_AHEAD = 3;

// Items are built in idle time for BUILD_AHEAD matches beyond either end of the window, so that revealing them only
// shows them. Of the items that left the window, the KEEP most recently shown stay built for a return; the others
// are destroyed, EVICT_STEP per idle.
const BUILD_AHEAD = 20;
const KEEP = 20;
const EVICT_STEP = 4;

/**
 * The list of the dialog. The history, its search and its window are the HistoryList's; this builds, shows, orders
 * and destroys the items that show the window's entries, and keeps in place what the user looks at while the list
 * changes around it.
 */
@registerClass()
export class ClipboardScrollContainer extends St.BoxLayout {
	private readonly _history = new HistoryList<ClipboardEntry>(searchTexts, WINDOW);
	private readonly _entries = new Set<ClipboardEntry>();
	/** Least recently shown first */
	private readonly _items = new Map<ClipboardEntry, ClipboardItem>();
	private readonly _unbuildable = new WeakSet<ClipboardEntry>();
	private readonly _statusItem: StatusItem;

	/** The items shown, in order */
	private _shown: ClipboardItem[] = [];
	private _first: St.Widget | null = null;
	private _last: St.Widget | null = null;
	private _lastFocus: Clutter.Actor | null = null;
	private _scrollTarget: { child: Clutter.Actor; animate: boolean } | null = null;
	private _revealedBack = false;
	private _revealLaterId = 0;
	private _revealAhead = 0;
	private _buildId = 0;

	constructor(
		ext: CopyousExtension,
		private readonly createItem: (entry: ClipboardEntry) => ClipboardItem | null,
	) {
		super({
			style_class: 'clipboard-item-list',
			x_align: Clutter.ActorAlign.START,
			x_expand: false,
		});

		this._statusItem = new StatusItem(ext);
		this.reconcile(0);

		// The entries' signals are disconnected with the list, which owns them
		this.connect('destroy', () => {
			this.stopRevealing();
			if (this._buildId) GLib.source_remove(this._buildId);
			this._buildId = 0;
			if (this._statusItem.get_parent() === null) this._statusItem.destroy();
		});
	}

	/** Adds entries, a loaded history, to those already there, such as ones copied while it loaded */
	public addEntries(entries: readonly ClipboardEntry[]): void {
		for (const entry of entries) {
			if (!this._entries.has(entry)) this.subscribe(entry);
		}
		this._history.set([...this._entries]);
		this.reconcile(this.buildNow);
	}

	/** Adds a new entry, or one whose content was copied again */
	public addEntry(entry: ClipboardEntry): void {
		if (!this._entries.has(entry)) this.subscribe(entry);
		this.change(entry, () => this._history.add(entry));
	}

	public clear(): void {
		const focused = this.focusedItem() !== null;
		for (const entry of this._entries) entry.disconnectObject(this);
		this._entries.clear();
		for (const [entry, item] of this._items) this.destroyItem(entry, item);

		this._history.set([]);
		this.reconcile(0);
		if (focused) this.focusSearch();
	}

	public search(query: SearchQuery): void {
		const focused = this.focusedItem();
		this._history.search(query);
		this.reconcile(this.buildNow);
		this.revealProgressively();

		const first = this._shown[0];
		if (focused?.visible) {
			this.focusChild(focused, false);
		} else if (this._lastFocus?.visible) {
			this.scrollToChild(this._lastFocus, false);
		} else if (this._lastFocus instanceof ClipboardItem && this._history.matched(this._lastFocus.entry)) {
			// Still matching, only outside the window: don't steal key focus
		} else if (first) {
			this.focusChild(first, false);
		}
	}

	/** Builds the missing items of the window, for the dialog to open */
	public prepare(): void {
		this.reconcile(Infinity);
	}

	/** Back to the first matches, once the dialog is hidden */
	public reset(): void {
		this.stopRevealing();
		this._history.toStart();
		this.reconcile(0);
	}

	public home(): void {
		this._history.toStart();
		this.reconcile(Infinity);
		const first = this._shown[0];
		if (first) this.focusChild(first);
	}

	public end(): void {
		this._history.toEnd();
		this.reconcile(Infinity);
		const last = this._shown.at(-1);
		if (last) this.focusChild(last);
	}

	/**
	 * Reveals more matches a few per frame, before each frame's layout, until `ahead` pages of them are ready beyond
	 * the visible part in either direction
	 */
	public revealProgressively(ahead: number = REVEAL_AHEAD): void {
		if (!this.mapped) return;

		this._revealAhead = Math.max(this._revealAhead, ahead);
		if (this._revealLaterId) return;

		this._revealLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
			if (this.reveal()) return GLib.SOURCE_CONTINUE;

			this._revealLaterId = 0;
			this._revealAhead = 0;
			return GLib.SOURCE_REMOVE;
		});
	}

	/** Focuses the match at `index`, counted from the newest */
	public selectItem(index: number): boolean {
		if (!this._history.atStart) {
			this._history.toStart();
			this.reconcile(Infinity);
		}

		const item = this._shown[index];
		if (!item) return false;

		this.focusChild(item);
		return true;
	}

	public selectNextItem() {
		const focused = this.focusedItem();
		if (focused === null) {
			const first = this._shown[0];
			if (first) this.focusChild(first);
			return;
		}

		if (focused === this._shown.at(-1) && this._history.extend(REVEAL_STEP)) this.reconcile(Infinity);
		this.nextFocus(focused);
	}

	public activateFirst(): void {
		this._shown[0]?.vfunc_clicked(1);
	}

	public focusChild(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		this._lastFocus = child;
		child.grab_key_focus();
		this.scrollToChild(child, animate);
	}

	public scrollToFocus(animate: boolean = true): void {
		const focused = this.focusedItem();
		if (focused === null) return;

		this._lastFocus = focused;
		this.scrollToChild(focused, animate);
	}

	public scrollToChild(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		// A child shown this frame has no allocation yet; it is scrolled to after the layout that gives it one
		if (!child.has_allocation()) {
			this._scrollTarget = { child, animate };
			this.queue_relayout();
			return;
		}

		const adjustment = this.adjustment;
		const [start, end] = this.span(child);
		const value = this.valueAt(adjustment, (start + end) / 2 - adjustment.page_size / 2);

		if (animate) {
			adjustment.ease(value, { duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
		} else {
			adjustment.value = value;
		}
	}

	private get horizontal(): boolean {
		return this.orientation === Clutter.Orientation.HORIZONTAL;
	}

	private get adjustment(): St.Adjustment {
		return this.horizontal ? this.hadjustment : this.vadjustment;
	}

	/** How many missing items to build now: all while the list is shown, none while it is hidden */
	private get buildNow(): number {
		return this.mapped ? Infinity : 0;
	}

	/**
	 * How far the content is moved to scroll it by `value`, in the content's coordinates. A right-to-left horizontal
	 * list starts at its right end, so the value counts from there.
	 */
	private translation(adjustment: St.Adjustment, value: number = adjustment.value): number {
		const rtl = this.horizontal && this.text_direction === Clutter.TextDirection.RTL;
		return rtl ? adjustment.upper - adjustment.page_size - value : value;
	}

	/** The value that moves the content by `translation`, the inverse of translation() */
	private valueAt(adjustment: St.Adjustment, translation: number): number {
		return this.translation(adjustment, translation);
	}

	/** Where a child begins and ends along the list, in the content's coordinates */
	private span(child: Clutter.Actor): [number, number] {
		const box = child.get_allocation_box();
		return this.horizontal ? [box.x1, box.x2] : [box.y1, box.y2];
	}

	/**
	 * One frame's step. Builds up to REVEAL_STEP items the window still lacks, or else reveals REVEAL_STEP more
	 * matches at an end with fewer than `_revealAhead` pages of them ready. Returns whether there is more to do.
	 */
	private reveal(): boolean {
		if (!this.mapped) return false;

		if (this._history.shown.some((entry) => !this._items.has(entry) && !this._unbuildable.has(entry))) {
			this.reconcile(REVEAL_STEP);
			return true;
		}

		// The value counts from the start of the list, in either direction
		const adjustment = this.adjustment;
		const ahead = this._revealAhead * adjustment.page_size;
		const before = adjustment.value;
		const after = adjustment.upper - adjustment.page_size - adjustment.value;

		let revealed = after <= ahead && this._history.extend(REVEAL_STEP);
		if (before <= ahead && this._history.extendBack(REVEAL_STEP)) {
			this._revealedBack = true;
			revealed = true;
		}

		if (revealed) this.reconcile(REVEAL_STEP);
		return revealed;
	}

	private stopRevealing(): void {
		if (this._revealLaterId) global.compositor.get_laters().remove(this._revealLaterId);
		this._revealLaterId = 0;
		this._revealAhead = 0;
	}

	private subscribe(entry: ClipboardEntry): void {
		const update = () => this.change(entry, () => this._history.update(entry));
		this._entries.add(entry);
		entry.connectObject(
			// Copying the same content again gives the entry a new time, and a new place
			'notify::datetime',
			() => this.change(entry, () => this._history.add(entry)),
			// What a search looks at
			'notify::content',
			update,
			'notify::metadata',
			update,
			'notify::title',
			update,
			'notify::type',
			update,
			'notify::pinned',
			update,
			'notify::tag',
			update,
			'delete',
			() => {
				entry.disconnectObject(this);
				this._entries.delete(entry);
				this.change(entry, () => this._history.remove(entry));
			},
			this,
		);
	}

	/** Applies a change of the history; key focus on an item that leaves the list goes to the one in its place */
	private change(entry: ClipboardEntry, apply: () => void): void {
		const item = this._items.get(entry);
		const focus = item?.has_key_focus() ? this._shown.indexOf(item) : -1;

		apply();
		const removed = item !== undefined && !this._history.has(entry);
		if (removed) this.destroyItem(entry, item);
		this.reconcile(0);

		if (focus >= 0 && (removed || !item!.visible)) this.focusAt(focus);
	}

	/**
	 * Shows the items of the window's entries, in order, and hides the others
	 * @param budget How many missing items of the window to build now, first ones first, a few ms each; the others
	 * are built in idle time
	 */
	private reconcile(budget: number): void {
		const shown: ClipboardItem[] = [];
		for (const entry of this._history.shown) {
			let item = this._items.get(entry) ?? null;
			if (!item && budget > 0) {
				budget--;
				item = this.build(entry);
			}
			if (item) shown.push(item);
		}

		this.display(shown);
		this.updateStatus();
		this.updatePseudoclasses();
		this.scheduleBuild();
	}

	/** Makes `shown` the items shown, touching only those that come, go or move */
	private display(shown: ClipboardItem[]): void {
		const was = new Set(this._shown);
		const is = new Set(shown);

		for (const item of this._shown) {
			if (is.has(item)) continue;

			item.visible = false;
			// Least recently shown first
			this._items.delete(item.entry);
			this._items.set(item.entry, item);
		}

		// Items that stay keep their order among themselves, unless one of their entries moved
		const stay = shown.filter((item) => was.has(item));
		const moved = this._shown.filter((item) => is.has(item)).some((item, i) => item !== stay[i]);
		shown.forEach((item, i) => {
			if (was.has(item) && !moved) return;

			const previous = shown[i - 1];
			if (previous) this.set_child_above_sibling(item, previous);
			else this.set_child_below_sibling(item, null);
			item.visible = true;
		});

		this._shown = shown;
	}

	private build(entry: ClipboardEntry): ClipboardItem | null {
		if (this._unbuildable.has(entry)) return null;

		const item = this.createItem(entry);
		if (!item) {
			this._unbuildable.add(entry);
			return null;
		}

		item.visible = false;
		this.add_child(item);
		this._items.set(entry, item);
		return item;
	}

	private destroyItem(entry: ClipboardEntry, item: ClipboardItem): void {
		this._items.delete(entry);
		this._shown = this._shown.filter((shown) => shown !== item);
		if (this._first === item) this._first = null;
		if (this._last === item) this._last = null;
		if (this._lastFocus === item) this._lastFocus = null;
		if (this._scrollTarget?.child === item) this._scrollTarget = null;

		// Destroyed, not just removed: an item still connected to the settings never gets collected
		item.destroy();
	}

	private scheduleBuild(): void {
		if (this._buildId) return;

		this._buildId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
			if (this.buildStep()) return GLib.SOURCE_CONTINUE;

			this._buildId = 0;
			return GLib.SOURCE_REMOVE;
		});
	}

	/**
	 * One item's worth of idle work. Builds a missing item of the window, or else of the matches near it, and gives
	 * it its styles and layout while it is hidden; or else destroys a few items no longer needed. Returns whether
	 * there was work.
	 */
	private buildStep(): boolean {
		const entry = [
			...this._history.around(0, BUILD_AHEAD),
			...this._history.around(-BUILD_AHEAD, 0).toReversed(),
		].find((e) => !this._items.has(e) && !this._unbuildable.has(e));

		if (entry === undefined) return this.evict();

		const item = this.build(entry);
		if (item) {
			this.reconcile(0);
			if (!this.mapped || !item.visible) item.prewarm();
		}
		return true;
	}

	private evict(): boolean {
		const limit = this._shown.length + 2 * BUILD_AHEAD + KEEP;
		if (this._items.size <= limit) return false;

		const near = new Set(this._history.around(-BUILD_AHEAD, BUILD_AHEAD));
		let evicted = 0;
		for (const [entry, item] of this._items) {
			if (evicted === EVICT_STEP || this._items.size <= limit) break;
			if (item.visible || near.has(entry)) continue;

			this.destroyItem(entry, item);
			evicted++;
		}
		return evicted > 0;
	}

	private updateStatus(): void {
		if (this._history.matchCount === 0) {
			if (this._statusItem.get_parent() === null) this.add_child(this._statusItem);
			this._statusItem.state = this._history.size === 0 ? State.Empty : State.NoResults;
			this.x_align = Clutter.ActorAlign.CENTER;
			this.x_expand = true;
		} else if (this._statusItem.get_parent() !== null) {
			this.remove_child(this._statusItem);
			this.x_align = Clutter.ActorAlign.START;
			this.x_expand = false;
		}
	}

	/** Moves :first-child and :last-child to the first and last item shown, restyling only those that change */
	private updatePseudoclasses(): void {
		const status = this._statusItem.get_parent() === this ? this._statusItem : null;
		const first = this._shown[0] ?? status;
		const last = this._shown.at(-1) ?? status;

		if (first !== this._first) {
			this._first?.remove_style_pseudo_class('first-child');
			first?.add_style_pseudo_class('first-child');
			this._first = first;
		}
		if (last !== this._last) {
			this._last?.remove_style_pseudo_class('last-child');
			last?.add_style_pseudo_class('last-child');
			this._last = last;
		}
	}

	private focusedItem(): ClipboardItem | null {
		const focus = global.stage.get_key_focus();
		return focus instanceof ClipboardItem && focus.get_parent() === this ? focus : null;
	}

	private focusAt(index: number): void {
		const item = this._shown[Math.min(index, this._shown.length - 1)];
		if (item) {
			this.focusChild(item);
		} else {
			this._lastFocus = null;
			this.focusSearch();
		}
	}

	private focusSearch(): void {
		global.focus_manager.get_group(this).navigate_focus(this, St.DirectionType.UP, true);
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

		// Keyboard navigation past either end of the window extends it
		const forward =
			direction === St.DirectionType.TAB_FORWARD ||
			direction === (this.horizontal ? St.DirectionType.RIGHT : St.DirectionType.DOWN);
		const backward =
			direction === St.DirectionType.TAB_BACKWARD ||
			direction === (this.horizontal ? St.DirectionType.LEFT : St.DirectionType.UP);
		if (forward && from === this._shown.at(-1) && this._history.extend(REVEAL_STEP)) {
			this.reconcile(Infinity);
		} else if (backward && from === this._shown[0] && this._history.extendBack(REVEAL_STEP)) {
			this._revealedBack = true;
			this.reconcile(Infinity);
		}

		const first = get_first_visible_child(this);
		const last = get_last_visible_child(this);
		if (this.horizontal) {
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

	override vfunc_allocate(box: Clutter.ActorBox): void {
		const adjustment = this.adjustment;
		const translation = this.translation(adjustment);
		const anchor = this._scrollTarget ? null : this.anchor(adjustment, translation);
		const transition = anchor ? adjustment.get_transition('value') : null;
		const animation = transition && {
			to: this.translation(adjustment, transition.interval.final as unknown as number),
			left: transition.get_duration() - transition.get_elapsed_time(),
		};

		super.vfunc_allocate(box);
		this._revealedBack = false;

		if (this._scrollTarget) {
			const { child, animate } = this._scrollTarget;
			this._scrollTarget = null;
			if (child.get_parent() === this && child.visible) this.scrollToChild(child, animate);
			return;
		}
		if (!anchor?.child.visible) return;

		// Content changed in front of what is in view. The view follows it, and a scroll animation in progress goes on
		// to its target, moved as much. In a right-to-left list the value changes even when the child does not move.
		const shift = this.span(anchor.child)[0] - anchor.start;
		const value = this.valueAt(adjustment, translation + shift);
		if (value === adjustment.value) return;

		adjustment.remove_transition('value');
		adjustment.value = value;
		if (animation && animation.left > 0) {
			adjustment.ease(this.valueAt(adjustment, animation.to + shift), {
				duration: animation.left,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});
		}
	}

	/**
	 * The child that keeps its place on screen when the layout changes, the first one in view. There is none at the
	 * start of the list, so that what is added in front shows, unless it was revealed to scroll back into.
	 */
	private anchor(adjustment: St.Adjustment, translation: number): { child: Clutter.Actor; start: number } | null {
		if (!this.mapped || (adjustment.value <= 0 && !this._revealedBack)) return null;

		for (const child of this._shown) {
			if (!child.has_allocation()) continue;

			const [start, end] = this.span(child);
			if (end > translation && start < translation + adjustment.page_size) return { child, start };
		}
		return null;
	}

	override vfunc_map(): void {
		this._lastFocus = null;
		this._scrollTarget = null;
		this.hadjustment.value = 0;
		this.vadjustment.value = 0;

		super.vfunc_map();
	}
}
