import Gio from 'gi://Gio';

import type CopyousExtension from '../../../extension.js';
import { ItemType } from '../../common/constants.js';
import { ClipboardEntry, LinkMetadata } from '../../database/database.js';
import { CharacterItem } from './characterItem.js';
import { ClipboardItem } from './clipboardItem.js';
import { CodeItem } from './codeItem.js';
import { ColorItem } from './colorItem.js';
import { FileItem, formatFile } from './fileItem.js';
import { FilesItem } from './filesItem.js';
import { ImageItem } from './imageItem.js';
import { LinkItem } from './linkItem.js';
import { TextItem } from './textItem.js';

/** The item that shows an entry of this type, or null for an unknown type */
export function createItem(ext: CopyousExtension, entry: ClipboardEntry): ClipboardItem | null {
	switch (entry.type) {
		case ItemType.Text:
			return new TextItem(ext, entry);
		case ItemType.Code:
			return new CodeItem(ext, entry);
		case ItemType.Image:
			return new ImageItem(ext, entry);
		case ItemType.File:
			return new FileItem(ext, entry);
		case ItemType.Files:
			return new FilesItem(ext, entry);
		case ItemType.Link:
			return new LinkItem(ext, entry);
		case ItemType.Character:
			return new CharacterItem(ext, entry);
		case ItemType.Color:
			return new ColorItem(ext, entry);
		default:
			return null;
	}
}

/** The texts a search query is matched against, besides the title */
export function searchTexts(entry: ClipboardEntry): string[] {
	switch (entry.type) {
		case ItemType.Image:
			return [];
		case ItemType.File:
			return [entry.content.substring('file://'.length), formatFile(Gio.File.new_for_uri(entry.content))];
		case ItemType.Files: {
			const files = entry.content
				.split('\n')
				.map((uri) => Gio.File.new_for_uri(uri))
				.filter((file) => file.get_path() !== null);
			return [...files.map((file) => file.get_path()!), ...files.map(formatFile)];
		}
		case ItemType.Link: {
			const metadata = entry.metadata as Partial<LinkMetadata> | null;
			return [entry.content, metadata?.title, metadata?.description].filter((text) => text != null);
		}
		default:
			return [entry.content];
	}
}
