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

function list(entries: Entry[], windowSize = 3) {
	const history = new HistoryList<Entry>((e) => (e.type === 'Image' ? [] : [e.content]), windowSize);
	history.set(entries);
	return history;
}

const names = (entries: readonly Entry[]) => entries.map((e) => e.name);
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

test('the window shows the first matches and extends at either end', () => {
	const history = list([1, 2, 3, 4, 5, 6, 7].map((t) => entry(`e${t}`, t)));
	assert.deepEqual(names(history.shown), ['e7', 'e6', 'e5']);
	assert.equal(history.hasBefore, false);
	assert.equal(history.hasAfter, true);

	history.extend(2);
	assert.deepEqual(names(history.shown), ['e7', 'e6', 'e5', 'e4', 'e3']);

	history.toEnd();
	assert.deepEqual(names(history.shown), ['e3', 'e2', 'e1']);
	assert.equal(history.hasAfter, false);

	history.extendBack(1);
	assert.deepEqual(names(history.shown), ['e4', 'e3', 'e2', 'e1']);
	assert.equal(history.extend(1), false);
});

test('a new entry shows at the top of a window at the start, and the window keeps its length', () => {
	const history = list([1, 2, 3, 4].map((t) => entry(`e${t}`, t)));
	history.add(entry('new', 9));
	assert.deepEqual(names(history.shown), ['new', 'e4', 'e3']);
});

test('a window away from the start keeps showing the same entries when one is added above it', () => {
	const history = list([1, 2, 3, 4, 5, 6].map((t) => entry(`e${t}`, t)));
	history.toEnd();
	history.add(entry('new', 9));
	assert.deepEqual(names(history.shown), ['e3', 'e2', 'e1']);
});

test('removing the first entry of a window away from the start shows its successor first', () => {
	const entries = [1, 2, 3, 4, 5, 6, 7].map((t) => entry(`e${t}`, t));
	const history = list(entries);
	history.extend(1);
	history.toEnd();
	history.extendBack(2);
	assert.deepEqual(names(history.shown), ['e5', 'e4', 'e3', 'e2', 'e1']);

	history.remove(entries[4]!);
	assert.deepEqual(names(history.shown), ['e6', 'e4', 'e3', 'e2', 'e1']);
});

test('a search matches content and title, ignoring case and accents, and resets the window', () => {
	const history = list([
		entry('one', 1, { content: 'Café au lait' }),
		entry('two', 2, { content: 'tea', title: 'CAFE order' }),
		entry('three', 3, { content: 'water' }),
		entry('four', 4, { type: 'Image', content: 'file:///cafe.png' }),
	]);
	history.toEnd();
	history.search(query({ text: 'cafe' }));
	assert.deepEqual(names(history.shown), ['two', 'one']);
	assert.equal(history.hasBefore, false);
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

test('an entry whose content changes is searched again', () => {
	const a = entry('a', 1, { content: 'apple' });
	const history = list([a, entry('b', 2, { content: 'banana' })], 10);
	history.search(query({ text: 'cherry' }));
	assert.equal(history.matchCount, 0);

	a.content = 'cherry pie';
	history.update(a);
	assert.deepEqual(names(history.shown), ['a']);
});
