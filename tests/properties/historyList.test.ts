/**
 * Any sequence of history changes, searches and window moves, checked against a reference. The reference sorts the
 * history naively and searches it the way Copyous did before the list had a model, with a locale collator compared
 * at every offset of every text. The alphabet reaches the letters where folding and that collator could part ways.
 */
import fc from 'fast-check';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ItemType, Tag } from '../../src/lib/common/constants.js';
import { HistoryList, MatchAll, SearchQuery } from '../../src/lib/common/historyList.js';

class Time {
	constructor(readonly t: number) {}

	compare(other: Time): number {
		return Math.sign(this.t - other.t);
	}
}

interface Entry {
	id: number;
	content: string;
	type: ItemType;
	pinned: boolean;
	tag: Tag | null;
	title: string;
	datetime: Time;
	/** Among entries of the same time, the higher comes first */
	seq: number;
}

const WINDOW = 4;
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

function localeContains(text: string, query: string): boolean {
	for (let offset = 0; offset <= text.length - query.length; offset++) {
		if (collator.compare(text.substring(offset, offset + query.length), query) === 0) return true;
	}
	return false;
}

function refMatches(q: SearchQuery, e: Entry): boolean {
	const pinned = (!q.pinned && !q.excludePinned) || q.pinned === e.pinned;
	const tag = (q.tag === null && !q.excludeTagged) || q.tag === e.tag;
	const type = q.type === null || q.type === e.type;
	const texts = e.type === 'Image' ? [] : [e.content];
	const text = q.text.length === 0 || [...texts, e.title].some((s) => localeContains(s, q.text));
	return pinned && tag && type && text;
}

const byTime = (a: Entry, b: Entry) => b.datetime.t - a.datetime.t || b.seq - a.seq;

/** Mostly the first value, now and then the second */
const rarely = <T>(common: T, rare: T) => fc.constantFrom(common, common, common, rare);

const letters = ['a', 'b', 'A', 'é', 'É', ' ', 'o', 'ø', 'ł', 'l', 'ς', 'σ', 'ア', 'あ', 'का', 'कि', 'й', 'и'];
const text = fc.string({ unit: fc.constantFrom(...letters), maxLength: 6 });
const tag = fc.constantFrom<Tag | null>(null, 'red', 'blue');
const type = fc.constantFrom<ItemType>('Text', 'Code', 'Image');
const fields = fc.record({ content: text, type, pinned: fc.boolean(), tag, title: text });
const searchQuery = fc.record({
	text: fc.string({ unit: fc.constantFrom('a', 'b', 'e', 'É', 'o', 'l', 'σ', 'あ', 'क', 'и'), maxLength: 1 }),
	pinned: rarely(false, true),
	excludePinned: rarely(false, true),
	tag: rarely<Tag | null>(null, 'red'),
	excludeTagged: rarely(false, true),
	type: rarely<ItemType | null>(null, 'Text'),
});

// -1 picks the window's first entry, where the window's rules are the least obvious
const pick = fc.oneof(fc.constant(-1), fc.nat());
const op = fc.oneof(
	fc.record({ kind: fc.constant('add' as const), time: fc.nat(5), fields }),
	fc.record({ kind: fc.constant('move' as const), pick, time: fc.nat(5) }),
	fc.record({ kind: fc.constant('remove' as const), pick }),
	fc.record({ kind: fc.constant('update' as const), pick, fields }),
	fc.record({ kind: fc.constant('search' as const), query: searchQuery }),
	fc.record({ kind: fc.constant('set' as const) }),
	fc.record({ kind: fc.constant('extend' as const), n: fc.integer({ min: 1, max: 3 }) }),
	fc.record({ kind: fc.constant('extendBack' as const), n: fc.integer({ min: 1, max: 3 }) }),
	fc.record({ kind: fc.constant('toEnd' as const) }),
	fc.record({ kind: fc.constant('toStart' as const) }),
);

test('the window is always a run of the reference matches, where its rules say', () => {
	fc.assert(
		fc.property(
			fc.array(fc.record({ time: fc.nat(5), fields }), { maxLength: 30 }),
			fc.array(op, { minLength: 1 }),
			(initial, ops) => {
				let seq = 0;
				let id = 0;
				const entries: Entry[] = initial.map((e, i) => ({
					id: id++,
					...e.fields,
					datetime: new Time(e.time),
					seq: -i,
				}));
				let q: SearchQuery = MatchAll;

				const history = new HistoryList<Entry>((e) => (e.type === 'Image' ? [] : [e.content]), WINDOW);
				history.set(entries);

				const reference = () => [...entries].sort(byTime).filter((e) => refMatches(q, e));
				let previous = reference();

				for (const o of ops) {
					const before = history.shown;
					const startBefore = before.length > 0 ? previous.indexOf(before[0]!) : 0;
					const orderBefore = [...entries].sort(byTime);
					const picked =
						'pick' in o
							? o.pick < 0
								? before[0]
								: entries[o.pick % Math.max(entries.length, 1)]
							: undefined;

					let moved: boolean | undefined;
					let edited = false;
					switch (o.kind) {
						case 'add': {
							const e = { id: id++, ...o.fields, datetime: new Time(o.time), seq: ++seq };
							entries.push(e);
							history.add(e);
							edited = true;
							break;
						}
						case 'move':
							if (!picked) continue;
							picked.datetime = new Time(o.time);
							picked.seq = ++seq;
							history.add(picked);
							edited = true;
							break;
						case 'remove':
							if (!picked) continue;
							entries.splice(entries.indexOf(picked), 1);
							history.remove(picked);
							assert.equal(history.has(picked), false);
							history.remove(picked);
							history.update(picked);
							edited = true;
							break;
						case 'update':
							if (!picked) continue;
							Object.assign(picked, o.fields);
							history.update(picked);
							edited = true;
							break;
						case 'search':
							q = o.query;
							history.search(q);
							break;
						case 'set':
							// In the reference's order: set() keeps the given order of entries of the same time
							history.set([...entries].sort(byTime));
							break;
						case 'extend':
							moved = history.extend(o.n);
							break;
						case 'extendBack':
							moved = history.extendBack(o.n);
							break;
						case 'toEnd':
							history.toEnd();
							break;
						case 'toStart':
							history.toStart();
							break;
					}

					const matches = reference();
					previous = matches;
					const shown = history.shown;
					const start = shown.length > 0 ? matches.indexOf(shown[0]!) : 0;
					assert.ok(start >= 0, 'the first shown entry matches');
					assert.deepEqual(
						shown,
						matches.slice(start, start + shown.length),
						'a run of the matches, in order',
					);
					assert.equal(history.matchCount, matches.length);
					assert.equal(history.size, entries.length);
					assert.equal(history.atStart, start === 0);
					assert.ok(shown.length >= Math.min(WINDOW, matches.length), 'the window is full while it can be');
					for (const e of entries) {
						assert.equal(history.has(e), true);
						assert.equal(history.matched(e), matches.includes(e));
					}
					assert.deepEqual(
						history.around(-2, 3),
						matches.slice(Math.max(0, start - 2), start + shown.length + 3),
						'around reaches either side of the window',
					);

					if (o.kind === 'search' || o.kind === 'toStart' || o.kind === 'set') {
						assert.deepEqual(shown, matches.slice(0, WINDOW), 'back at the start');
					} else if (o.kind === 'toEnd') {
						assert.deepEqual(shown, matches.slice(-WINDOW), 'at the end');
					} else if (o.kind === 'extend') {
						const end = Math.min(startBefore + before.length + o.n, matches.length);
						assert.deepEqual(shown, matches.slice(startBefore, end), 'the end moved by up to n');
						assert.equal(moved, shown.length !== before.length);
					} else if (o.kind === 'extendBack') {
						const from = Math.max(0, startBefore - o.n);
						assert.deepEqual(
							shown,
							matches.slice(from, startBefore + before.length),
							'the start moved by up to n',
						);
						assert.equal(moved, shown.length !== before.length);
					} else if (edited) {
						const length = Math.min(Math.max(before.length, WINDOW), matches.length);
						assert.equal(shown.length, length, 'an edit keeps the length of the window');

						if (startBefore === 0) {
							assert.equal(start, 0, 'a window at the start stays there');
						} else {
							// The first entry, or the next match after where it was, unless it left or moved away; then the
							// window keeps its length, if need be by starting earlier
							const gone = o.kind === 'move' || o.kind === 'remove' ? picked : undefined;
							const from = orderBefore.indexOf(before[0]!);
							const successor = orderBefore.slice(from).find((e) => e !== gone && matches.includes(e));
							const last = Math.max(0, matches.length - length);
							const expected = successor ? Math.min(matches.indexOf(successor), last) : last;
							assert.equal(start, expected, 'keeps its first entry, or what took its place');
						}
					}
				}
			},
		),
		{ numRuns: 3000 },
	);
});
