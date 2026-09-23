import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ItemType, Tag } from '../src/lib/common/constants.js';
import { HistoryList, MatchAll, SearchQuery } from '../src/lib/common/historyList.js';

class Time {
	constructor(readonly t: number) {}

	compare(other: Time): number {
		return Math.sign(this.t - other.t);
	}
}

interface Entry {
	name: string;
	content: string;
	type: ItemType;
	pinned: boolean;
	tag: Tag | null;
	title: string;
	datetime: Time;
}

function entry(name: string, t: number, fields: Partial<Entry> = {}): Entry {
	return { name, content: name, type: 'Text', pinned: false, tag: null, title: '', datetime: new Time(t), ...fields };
}

/** e1 … en, en the newest */
function entries(n: number): Entry[] {
	return Array.from({ length: n }, (_, i) => entry(`e${i + 1}`, i + 1));
}

function list(items: Entry[], windowSize = 3) {
	const history = new HistoryList<Entry>((e) => (e.type === 'Image' ? [] : [e.content]), windowSize);
	history.set(items);
	return history;
}

const names = (items: readonly Entry[]) => items.map((e) => e.name);
const query = (fields: Partial<SearchQuery>): SearchQuery => ({ ...MatchAll, ...fields });

test('lists the newest entry first; of the same time, in the order given', () => {
	const history = list([entry('a', 1), entry('b', 3), entry('c', 2), entry('d', 3)], 10);
	assert.deepEqual(names(history.shown), ['b', 'd', 'c', 'a']);
});

test('an added entry of the same time as others comes first among them', () => {
	const history = list([entry('a', 1), entry('b', 1)], 10);
	history.add(entry('c', 1));
	assert.deepEqual(names(history.shown), ['c', 'a', 'b']);
});

test('an entry copied again moves to the top', () => {
	const a = entry('a', 1);
	const history = list([a, entry('b', 2), entry('c', 3)], 10);
	a.datetime = new Time(4);
	history.add(a);
	assert.deepEqual(names(history.shown), ['a', 'c', 'b']);
});

test('the window shows the first matches, and extends at either end until there are no more', () => {
	const history = list(entries(7));
	assert.deepEqual(names(history.shown), ['e7', 'e6', 'e5']);

	assert.equal(history.extend(2), true);
	assert.deepEqual(names(history.shown), ['e7', 'e6', 'e5', 'e4', 'e3']);

	history.toEnd();
	assert.deepEqual(names(history.shown), ['e3', 'e2', 'e1']);
	assert.equal(history.extend(1), false);

	assert.equal(history.extendBack(1), true);
	assert.deepEqual(names(history.shown), ['e4', 'e3', 'e2', 'e1']);
	history.toStart();
	assert.equal(history.extendBack(1), false);
});

test('a new entry shows at the top of a window at the start, and the window keeps its length', () => {
	const history = list(entries(4));
	history.add(entry('new', 9));
	assert.deepEqual(names(history.shown), ['new', 'e4', 'e3']);
});

/** A window away from both ends of the list: e3 e2 e1, with e9 … e4 before it and e0 after it */
function middle() {
	const all = entries(9);
	const history = list(all);
	history.toEnd();
	const oldest = entry('e0', 0);
	history.add(oldest);
	assert.deepEqual(names(history.shown), ['e3', 'e2', 'e1']);
	return { history, all, oldest };
}

test('a window away from the start keeps showing the same entries when one is added above it', () => {
	const { history } = middle();
	history.add(entry('new', 99));
	assert.deepEqual(names(history.shown), ['e3', 'e2', 'e1']);
});

test('removing the first entry of a window away from the start shows its successor first', () => {
	const { history, all } = middle();
	history.remove(all[2]!);
	assert.deepEqual(names(history.shown), ['e2', 'e1', 'e0']);
});

test('the first entry of a window copied again moves away, and the window stays with its successor', () => {
	const { history, all } = middle();
	all[2]!.datetime = new Time(99);
	history.add(all[2]!);
	assert.deepEqual(names(history.shown), ['e2', 'e1', 'e0']);
});

test('a search matches content and title, and puts the window back to the start', () => {
	const history = list([
		entry('one', 1, { content: 'tea' }),
		entry('two', 2, { content: 'green tea' }),
		entry('three', 3, { content: 'water', title: 'TEA break' }),
		entry('four', 4, { content: 'coffee' }),
		entry('five', 5, { content: 'Tea time' }),
		entry('six', 6, { type: 'Image', content: 'file:///tea.png' }),
	]);
	history.toEnd();
	history.search(query({ text: 'tea' }));
	assert.deepEqual(names(history.shown), ['five', 'three', 'two']);
	assert.equal(history.matchCount, 4);
});

test('a search ignores case and accents, and finds what a locale collator would', () => {
	const history = list(
		[
			entry('french', 1, { content: 'Crème Brûlée' }),
			entry('danish', 2, { content: 'Søren Kierkegaard' }),
			entry('polish', 3, { content: 'Łódź' }),
			entry('greek', 4, { content: 'ΛΟΓΟΣ' }),
			entry('katakana', 5, { content: 'カタカナ' }),
			entry('russian', 6, { content: 'Дмитрий' }),
			entry('hindi', 7, { content: 'किताब' }),
		],
		10,
	);
	const found = (text: string) => {
		history.search(query({ text }));
		return names(history.shown);
	};
	assert.deepEqual(found('creme brulee'), ['french']);
	assert.deepEqual(found('soren'), ['danish']);
	assert.deepEqual(found('lodz'), ['polish']);
	assert.deepEqual(found('λογος'), ['greek']);
	assert.deepEqual(found('かたかな'), ['katakana']);
	// Й is not И, and the vowel sign ि is not ा
	assert.deepEqual(found('дмитрии'), []);
	assert.deepEqual(found('काताब'), []);
});

test('a search filters by pinned, tag and type', () => {
	const history = list(
		[
			entry('plain', 1),
			entry('pinned', 2, { pinned: true }),
			entry('tagged', 3, { tag: 'red' }),
			entry('code', 4, { type: 'Code' }),
		],
		10,
	);
	history.search(query({ pinned: true }));
	assert.deepEqual(names(history.shown), ['pinned']);
	history.search(query({ excludePinned: true }));
	assert.deepEqual(names(history.shown), ['code', 'tagged', 'plain']);
	history.search(query({ tag: 'red' }));
	assert.deepEqual(names(history.shown), ['tagged']);
	history.search(query({ excludeTagged: true }));
	assert.deepEqual(names(history.shown), ['code', 'pinned', 'plain']);
	history.search(query({ type: 'Code' }));
	assert.deepEqual(names(history.shown), ['code']);
});

test('replacing the entries keeps the search query', () => {
	const history = list([entry('apple', 1)], 10);
	history.search(query({ text: 'an' }));
	history.set([entry('banana', 1), entry('cherry', 2), entry('mango', 3)]);
	assert.deepEqual(names(history.shown), ['mango', 'banana']);
});

test('an entry whose content changes is searched again', () => {
	const a = entry('a', 1, { content: 'apple' });
	const history = list([a, entry('b', 2, { content: 'banana' })], 10);
	history.search(query({ text: 'cherry' }));
	assert.equal(history.matchCount, 0);

	a.content = 'cherry pie';
	history.update(a);
	assert.deepEqual(names(history.shown), ['a']);
	assert.equal(history.matched(a), true);
});

test('around reaches from before the window to after it', () => {
	const history = list(entries(9));
	history.extend(1);
	history.toEnd();
	history.extendBack(2);
	assert.deepEqual(names(history.shown), ['e5', 'e4', 'e3', 'e2', 'e1']);
	assert.deepEqual(names(history.around(-2, 0)), ['e7', 'e6', 'e5', 'e4', 'e3', 'e2', 'e1']);
	assert.deepEqual(names(history.around(1, -2)), ['e4', 'e3']);
});
