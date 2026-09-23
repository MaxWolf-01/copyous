import Gio from 'gi://Gio';

import type CopyousExtension from '../../../extension.js';
import { ItemType } from '../../common/constants.js';
import { ClipboardEntry, LinkMetadata } from '../../database/database.js';
import { CharacterItem } from './characterItem.js';
import { ClipboardItem } from './clipboardItem.js';
import { CodeItem } from './codeItem.js';
import { ColorItem } from './colorItem.js';
import { FileItem, formatFile } from './fileItem.js';
import { FilesItem, parseFiles } from './filesItem.js';
import { ImageItem } from './imageItem.js';
import { LinkItem } from './linkItem.js';
import { TextItem } from './textItem.js';

interface Kind {
	item: new (ext: CopyousExtension, entry: ClipboardEntry) => ClipboardItem;
	/** The texts a search query is matched against, besides the title */
	searchTexts: (entry: ClipboardEntry) => string[];
}

const content = (entry: ClipboardEntry) => [entry.content];

const Kinds: Record<ItemType, Kind> = {
	[ItemType.Text]: { item: TextItem, searchTexts: content },
	[ItemType.Code]: { item: CodeItem, searchTexts: content },
	[ItemType.Image]: { item: ImageItem, searchTexts: () => [] },
	[ItemType.File]: {
		item: FileItem,
		searchTexts: (entry) => [
			entry.content.substring('file://'.length),
			formatFile(Gio.File.new_for_uri(entry.content)),
		],
	},
	[ItemType.Files]: {
		item: FilesItem,
		searchTexts: (entry) => {
			const files = parseFiles(entry.content);
			return [...files.map((file) => file.get_path()!), ...files.map(formatFile)];
		},
	},
	[ItemType.Link]: {
		item: LinkItem,
		searchTexts: (entry) => {
			const metadata = entry.metadata as Partial<LinkMetadata> | null;
			return [entry.content, metadata?.title, metadata?.description].filter((text) => text != null);
		},
	},
	[ItemType.Character]: { item: CharacterItem, searchTexts: content },
	[ItemType.Color]: { item: ColorItem, searchTexts: content },
};

/** The item that shows an entry, or null for an entry of an unknown type */
export function tryCreateItem(ext: CopyousExtension, entry: ClipboardEntry): ClipboardItem | null {
	const kind = Kinds[entry.type] as Kind | undefined;
	return kind ? new kind.item(ext, entry) : null;
}

export function searchTexts(entry: ClipboardEntry): string[] {
	return (Kinds[entry.type] as Kind | undefined)?.searchTexts(entry) ?? content(entry);
}
