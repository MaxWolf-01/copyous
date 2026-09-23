/**
 * Any sequence of history changes, searches and window moves, checked against a reference: the history sorted
 * naively, and searched the way Copyous searched before the list had a model, with a locale collator compared at
 * every offset of every text.
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

const text = fc.string({ unit: fc.constantFrom('a', 'b', 'A', 'é', 'É', ' '), maxLength: 6 });
const tag = fc.constantFrom<Tag | null>(null, 'red', 'blue');
const type = fc.constantFrom<ItemType>('Text', 'Code', 'Image');
const fields = fc.record({ content: text, type, pinned: fc.boolean(), tag, title: text });
const searchQuery = fc.record({
	text: fc.string({ unit: fc.constantFrom('a', 'b', 'e', 'É', 'ab'), maxLength: 2 }),
	pinned: fc.boolean(),
	excludePinned: fc.boolean(),
	tag,
	excludeTagged: fc.boolean(),
	type: fc.constantFrom<ItemType | null>(null, 'Text', 'Image'),
});

const op = fc.oneof(
	fc.record({ kind: fc.constant('add' as const), time: fc.nat(5), fields }),
	fc.record({ kind: fc.constant('move' as const), pick: fc.nat(), time: fc.nat(5) }),
	fc.record({ kind: fc.constant('remove' as const), pick: fc.nat() }),
	fc.record({ kind: fc.constant('update' as const), pick: fc.nat(), fields }),
	fc.record({ kind: fc.constant('search' as const), query: searchQuery }),
	fc.record({ kind: fc.constant('extend' as const), n: fc.integer({ min: 1, max: 3 }) }),
	fc.record({ kind: fc.constant('extendBack' as const), n: fc.integer({ min: 1, max: 3 }) }),
	fc.record({ kind: fc.constant('toEnd' as const) }),
	fc.record({ kind: fc.constant('toStart' as const) }),
);

test('the window is always a run of the reference matches, in the reference order', () => {
	fc.assert(
		fc.property(
			fc.array(fc.record({ time: fc.nat(5), fields }), { maxLength: 12 }),
			fc.array(op),
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

				const reference = () =>
					[...entries]
						.sort((a, b) => b.datetime.t - a.datetime.t || b.seq - a.seq)
						.filter((e) => refMatches(q, e));

				for (const o of ops) {
					const before = history.shown;
					const wasAtStart = !history.hasBefore;
					const edited = (() => {
						const pick = 'pick' in o ? entries[o.pick % entries.length] : undefined;
						switch (o.kind) {
							case 'add': {
								const e = { id: id++, ...o.fields, datetime: new Time(o.time), seq: ++seq };
								entries.push(e);
								history.add(e);
								return true;
							}
							case 'move':
								if (!pick) return false;
								pick.datetime = new Time(o.time);
								pick.seq = ++seq;
								history.add(pick);
								return true;
							case 'remove':
								if (!pick) return false;
								entries.splice(entries.indexOf(pick), 1);
								history.remove(pick);
								return true;
							case 'update':
								if (!pick) return false;
								Object.assign(pick, o.fields);
								history.update(pick);
								return true;
							case 'search':
								q = o.query;
								history.search(q);
								break;
							case 'extend':
								history.extend(o.n);
								break;
							case 'extendBack':
								history.extendBack(o.n);
								break;
							case 'toEnd':
								history.toEnd();
								break;
							case 'toStart':
								history.toStart();
								break;
						}
						return false;
					})();

					const matches = reference();
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
					assert.equal(history.hasBefore, start > 0);
					assert.equal(history.hasAfter, start + shown.length < matches.length);
					assert.ok(shown.length >= Math.min(WINDOW, matches.length), 'the window is full while it can be');

					if (o.kind === 'search' || o.kind === 'toStart') {
						assert.deepEqual(shown, matches.slice(0, WINDOW));
					} else if (o.kind === 'toEnd') {
						assert.deepEqual(shown, matches.slice(-WINDOW));
					} else if (edited) {
						const length = Math.min(Math.max(before.length, WINDOW), matches.length);
						assert.equal(shown.length, length, 'an edit keeps the length of the window');
						// The window stays where it was; the entry that moved away from it does not take the window along
						const moved = o.kind === 'move' && entries[o.pick % entries.length] === before[0];
						if (wasAtStart) assert.equal(start, 0, 'a window at the start stays there');
						else if (!moved && matches.includes(before[0]!))
							assert.ok(shown.includes(before[0]!), 'keeps its first entry');
					}
				}
			},
		),
		{ numRuns: 2000 },
	);
});
