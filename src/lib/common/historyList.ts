/**
 * The clipboard history as the dialog lists it. It holds every entry, newest first, which of them match the search
 * query, and the window, the run of matches the dialog shows.
 *
 * Free of GObject, so it runs under node for the tests.
 */
import type { ItemType, Tag } from './constants.js';

export interface Timestamp {
	compare(other: Timestamp): number;
}

/** What the list orders and searches an entry by */
export interface ListEntry {
	readonly type: ItemType;
	readonly pinned: boolean;
	readonly tag: Tag | null;
	readonly title: string;
	readonly datetime: Timestamp;
}

export interface SearchQuery {
	readonly text: string;
	/** Only pinned entries */
	readonly pinned: boolean;
	/** No pinned entries, unless `pinned` */
	readonly excludePinned: boolean;
	/** Only entries with this tag */
	readonly tag: Tag | null;
	/** No tagged entries, unless `tag` */
	readonly excludeTagged: boolean;
	/** Only entries of this type */
	readonly type: ItemType | null;
}

export const MatchAll: SearchQuery = {
	text: '',
	pinned: false,
	excludePinned: false,
	tag: null,
	excludeTagged: false,
	type: null,
};

// The accents a locale collator ignores when it compares base letters, which Unicode decomposition leaves as marks
// after them: those of Latin, Greek and Cyrillic, the voicing of kana, the points of Hebrew, the vowels of Arabic, the
// nukta of Indic scripts. Other marks, such as the vowel signs of Devanagari, change the letter and stay.
/* eslint-disable no-misleading-character-class -- the class holds combining marks alone, on purpose */
const ACCENTS =
	/[\p{M}&&[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f\u3099\u309a\u0591-\u05c7\u064b-\u065f\u0670\u093c\u09bc\u0a3c\u0abc\u0b3c\u0cbc]]/gv;
/* eslint-enable no-misleading-character-class */

// Letters the collator treats as a base letter with an accent, which Unicode does not decompose
const BASE_LETTERS: Record<string, string> = { ø: 'o', ł: 'l', đ: 'd', ħ: 'h', ς: 'σ' };

/**
 * A text in the form search compares, where a substring test finds what a locale collator comparing base letters
 * would. Letters are lower case, without accents and compatibility forms, and katakana are hiragana.
 */
export function fold(text: string): string {
	// eslint-disable-next-line no-control-regex
	if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase();

	return (
		text
			.normalize('NFKD')
			// Й is a letter of its own, not И with a breve
			.replace(/([иИ])\u0306/g, (_, i: string) => (i === 'и' ? 'й' : 'Й'))
			.replace(ACCENTS, '')
			.toLowerCase()
			.replace(/[øłđħς]/g, (letter) => BASE_LETTERS[letter]!)
			.replace(/[\u30a1-\u30f6]/g, (katakana) => String.fromCharCode(katakana.charCodeAt(0) - 0x60))
	);
}

interface Row<E> {
	readonly entry: E;
	matched: boolean;
	/** The texts search looks at, folded, once a search needed them */
	folded: string | undefined;
}

export class HistoryList<E extends ListEntry> {
	private _rows: Row<E>[] = [];
	private _matches: E[] = [];
	private _query: SearchQuery = MatchAll;
	private _needle = '';
	private _start = 0;
	private _end = 0;

	/**
	 * @param texts The texts of an entry a search query is matched against, besides its title
	 * @param windowSize How many matches the window shows from its start or its end
	 */
	constructor(
		private readonly texts: (entry: E) => readonly string[],
		private readonly windowSize: number,
	) {}

	/** The entries in the window, newest first */
	get shown(): readonly E[] {
		return this._matches.slice(this._start, this._end);
	}

	get size(): number {
		return this._rows.length;
	}

	get matchCount(): number {
		return this._matches.length;
	}

	/** Whether the window starts at the first match */
	get atStart(): boolean {
		return this._start === 0;
	}

	/**
	 * The matches from `from` positions after the window's start to `to` positions after its end. A negative `from`
	 * reaches before the window, a negative `to` stops short of its end.
	 */
	around(from: number, to: number): readonly E[] {
		return this._matches.slice(Math.max(0, this._start + from), Math.max(0, this._end + to));
	}

	has(entry: E): boolean {
		return this.rowOf(entry) >= 0;
	}

	/** Whether an entry matches the search query */
	matched(entry: E): boolean {
		return this._matches.includes(entry);
	}

	/** Replaces the entries, which are matched against the current search query; the window goes back to the start */
	set(entries: readonly E[]): void {
		// The sort is stable, so entries of the same time keep their order
		this._rows = [...entries]
			.sort((a, b) => b.datetime.compare(a.datetime))
			.map((entry) => ({ entry, matched: false, folded: undefined }));
		for (const row of this._rows) this.match(row);
		this.relist(-1);
		this.toStart();
	}

	/** Adds a new entry, or moves one whose time changed to its new place */
	add(entry: E): void {
		this.edit((anchor) => {
			const old = this.rowOf(entry);
			const row = old >= 0 ? this._rows.splice(old, 1)[0]! : { entry, matched: false, folded: undefined };
			if (old >= 0 && anchor > old) anchor--;

			// Before the first entry that is not newer, so of entries of the same time the latest added comes first
			let i = 0;
			while (i < this._rows.length && this._rows[i]!.entry.datetime.compare(entry.datetime) > 0) i++;
			this._rows.splice(i, 0, row);
			if (anchor >= i) anchor++;

			this.match(row);
			return anchor;
		});
	}

	remove(entry: E): void {
		const i = this.rowOf(entry);
		if (i < 0) return;

		this.edit((anchor) => {
			this._rows.splice(i, 1);
			return anchor > i ? anchor - 1 : anchor;
		});
	}

	/** Matches an entry again, after a property a search looks at changed */
	update(entry: E): void {
		const i = this.rowOf(entry);
		if (i < 0) return;

		this.edit((anchor) => {
			const row = this._rows[i]!;
			row.folded = undefined;
			this.match(row);
			return anchor;
		});
	}

	/** Matches every entry against the query; the window goes back to the start */
	search(query: SearchQuery): void {
		this._query = query;
		this._needle = fold(query.text);
		for (const row of this._rows) this.match(row);
		this.relist(-1);
		this.toStart();
	}

	/** Moves the window's end by up to `n` matches; returns whether it moved */
	extend(n: number): boolean {
		const end = Math.min(this._end + n, this._matches.length);
		if (end === this._end) return false;
		this._end = end;
		return true;
	}

	/** Moves the window's start back by up to `n` matches; returns whether it moved */
	extendBack(n: number): boolean {
		const start = Math.max(this._start - n, 0);
		if (start === this._start) return false;
		this._start = start;
		return true;
	}

	/** The window shows the first matches */
	toStart(): void {
		this._start = 0;
		this._end = Math.min(this.windowSize, this._matches.length);
	}

	/** The window shows the last matches */
	toEnd(): void {
		this._end = this._matches.length;
		this._start = Math.max(0, this._end - this.windowSize);
	}

	private rowOf(entry: E): number {
		return this._rows.findIndex((row) => row.entry === entry);
	}

	private match(row: Row<E>): void {
		const { entry } = row;
		const query = this._query;
		if ((query.pinned || query.excludePinned) && query.pinned !== entry.pinned) row.matched = false;
		else if ((query.tag !== null || query.excludeTagged) && query.tag !== entry.tag) row.matched = false;
		else if (query.type !== null && query.type !== entry.type) row.matched = false;
		else if (this._needle.length === 0) row.matched = true;
		else {
			row.folded ??= fold([...this.texts(entry), entry.title].join('\0'));
			row.matched = row.folded.includes(this._needle);
		}
	}

	/**
	 * Applies a change to the rows and keeps the window where it was. A window at the start stays there and shows what
	 * is now first. Any other window keeps its length and starts at its first entry, or, if that entry left or moved,
	 * at the next match after where it was.
	 * @param change Changes the rows and returns where the row of the window's first entry went
	 */
	private edit(change: (anchor: number) => number): void {
		const length = Math.max(this._end - this._start, this.windowSize);
		const anchor = this._start > 0 ? this._rows.findIndex((row) => row.entry === this._matches[this._start]) : -1;
		this.relist(change(anchor));

		this._end = Math.min(this._start + length, this._matches.length);
		this._start = Math.max(0, Math.min(this._start, this._end - length));
	}

	/** Lists the matches again; the window starts at the first match at or after the row `anchor` */
	private relist(anchor: number): void {
		this._matches = [];
		this._start = 0;
		this._rows.forEach((row, i) => {
			if (!row.matched) return;
			if (i < anchor) this._start++;
			this._matches.push(row.entry);
		});
	}
}
