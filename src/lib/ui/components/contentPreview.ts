import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import type CopyousExtension from '../../../extension.js';
import { ActiveState } from '../../common/constants.js';
import { enumParamSpec, flagsParamSpec, registerClass } from '../../common/gjs.js';
import { Icon, loadIcon } from '../../common/icons.js';
import { BackgroundSize, FilePreviewType } from '../../common/settings.js';
import { CodeLabel, CodeLabelConstructorProps } from './codeLabel.js';

export const FileType = {
	Unknown: 'Unknown',
	Directory: 'Directory',
	Text: 'Text',
	Image: 'Image',
	Audio: 'Audio',
	Video: 'Video',
} as const;

export type FileType = (typeof FileType)[keyof typeof FileType];

@registerClass()
export class ContentPreview extends St.BoxLayout {
	constructor() {
		super({
			style_class: 'content-preview',
			orientation: Clutter.Orientation.VERTICAL,
			x_expand: true,
			y_expand: true,
		});
	}
}

Gio._promisify(Gio.File.prototype, 'read_async');

async function decodeAtSize(
	file: Gio.File,
	width: number,
	height: number,
	cancellable: Gio.Cancellable,
): Promise<GdkPixbuf.Pixbuf> {
	const stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
	try {
		// Decodes in a worker thread
		return await new Promise((resolve, reject) => {
			GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, width, height, false, cancellable, (_, result) => {
				try {
					resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(result));
				} catch (error) {
					reject(error as Error);
				}
			});
		});
	} finally {
		stream.close(null);
	}
}

/**
 * Size at which an image fills (cover) or fits inside (contain) a box
 */
function scaledSize(width: number, height: number, boxWidth: number, boxHeight: number, cover: boolean) {
	const scale = (cover ? Math.max : Math.min)(boxWidth / width, boxHeight / height);
	const round = cover ? Math.ceil : Math.floor;
	return [Math.max(1, round(width * scale)), Math.max(1, round(height * scale))] as const;
}

/**
 * Loads an image the way CSS paints a centered `background-image` into a box: scaled to cover or to be contained,
 * what overflows cropped, the rest transparent.
 * @returns a pixbuf of exactly `boxWidth` by `boxHeight` with an alpha channel
 */
async function loadIntoBox(
	file: Gio.File,
	[width, height]: readonly [number, number],
	[boxWidth, boxHeight]: readonly [number, number],
	cover: boolean,
	cancellable: Gio.Cancellable,
): Promise<GdkPixbuf.Pixbuf> {
	const load = async (w: number, h: number) => {
		const pixbuf = await decodeAtSize(file, w, h, cancellable);
		return pixbuf.apply_embedded_orientation() ?? pixbuf;
	};

	const [w, h] = scaledSize(width, height, boxWidth, boxHeight, cover);
	let pixbuf = await load(w, h);
	if (pixbuf.width !== w) {
		// The orientation tag turned the image by a quarter, which only shows once it is decoded
		const [turnedWidth, turnedHeight] = scaledSize(height, width, boxWidth, boxHeight, cover);
		pixbuf = await load(turnedHeight, turnedWidth);
	}

	const box = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, boxWidth, boxHeight);
	box.fill(0);
	const copyWidth = Math.min(pixbuf.width, boxWidth);
	const copyHeight = Math.min(pixbuf.height, boxHeight);
	pixbuf.copy_area(
		Math.floor((pixbuf.width - copyWidth) / 2),
		Math.floor((pixbuf.height - copyHeight) / 2),
		copyWidth,
		copyHeight,
		box,
		Math.floor((boxWidth - copyWidth) / 2),
		Math.floor((boxHeight - copyHeight) / 2),
	);
	return box;
}

/**
 * Makes the RGBA pixels outside rounded corners transparent
 * @param radii The radius of each corner in pixels, indexed by `St.Corner`
 */
function roundCorners(pixels: Uint8Array, width: number, height: number, rowstride: number, radii: number[]) {
	radii.forEach((cornerRadius, corner) => {
		const radius = Math.min(cornerRadius, width / 2, height / 2);
		const right = corner === (St.Corner.TOPRIGHT as number) || corner === (St.Corner.BOTTOMRIGHT as number);
		const bottom = corner === (St.Corner.BOTTOMLEFT as number) || corner === (St.Corner.BOTTOMRIGHT as number);

		for (let y = 0; y < radius; y++) {
			for (let x = 0; x < radius; x++) {
				const distance = Math.hypot(radius - x - 0.5, radius - y - 0.5);
				const coverage = Math.clamp(radius - distance + 0.5, 0, 1);
				const column = right ? width - 1 - x : x;
				const row = bottom ? height - 1 - y : y;
				pixels[row * rowstride + column * 4 + 3]! *= coverage;
			}
		}
	});
}

/**
 * Shows an image file as a texture of exactly the size it is drawn at.
 *
 * A CSS `background-image` would go through `St.TextureCache`, which decodes on the main thread at the full image
 * size times the scale factor and keeps the result until the shell exits, even after the file is deleted.
 */
@registerClass()
class ImageBox extends St.Widget {
	private _cover: boolean = true;
	private _cancellable: Gio.Cancellable | null = null;

	// What the content, or the load in flight, was made for
	private _shown: string = '';

	constructor(
		private readonly _file: Gio.File,
		private readonly _imageSize: readonly [number, number],
		private readonly _onError: (error: unknown) => void,
	) {
		super({
			style_class: 'image-box',
			x_align: Clutter.ActorAlign.FILL,
			y_align: Clutter.ActorAlign.FILL,
			x_expand: true,
			y_expand: true,
		});

		this.connect('notify::mapped', this.update.bind(this));
		this.connect('style-changed', this.update.bind(this));
		this.connect('resource-scale-changed', this.update.bind(this));
		this.connect('destroy', () => this._cancellable?.cancel());
	}

	set cover(cover: boolean) {
		this._cover = cover;
		this.update();
	}

	/** Whether the content shown is the one for the current size, scale and corners */
	get loaded(): boolean {
		return this._shown !== '' && this._cancellable === null;
	}

	override vfunc_allocate(box: Clutter.ActorBox): void {
		super.vfunc_allocate(box);
		this.update();
	}

	private update() {
		// The theme node and the resource scale are only known on the stage
		if (!this.mapped) return;

		const scale = this.get_resource_scale();
		const width = Math.ceil(this.width * scale);
		const height = Math.ceil(this.height * scale);
		if (width === 0 || height === 0) return;

		const themeNode = this.get_theme_node();
		const corners = [St.Corner.TOPLEFT, St.Corner.TOPRIGHT, St.Corner.BOTTOMRIGHT, St.Corner.BOTTOMLEFT];
		const radii = corners.map((corner) => themeNode.get_border_radius(corner) * scale);

		const shown = [width, height, this._cover, ...radii].join();
		if (shown === this._shown) return;
		this._shown = shown;

		this._cancellable?.cancel();
		const cancellable = new Gio.Cancellable();
		this._cancellable = cancellable;
		loadIntoBox(this._file, this._imageSize, [width, height], this._cover, cancellable)
			.then((pixbuf) => {
				if (cancellable.is_cancelled()) return;

				const pixels = pixbuf.get_pixels();
				roundCorners(pixels, width, height, pixbuf.rowstride, radii);

				const content = new St.ImageContent({ preferred_width: this.width, preferred_height: this.height });
				const context = global.stage.context.get_backend().get_cogl_context();
				content.set_bytes(context, pixels, Cogl.PixelFormat.RGBA_8888, width, height, pixbuf.rowstride);
				this.set_content(content);
				this._cancellable = null;
			})
			.catch((error) => {
				if (!cancellable.is_cancelled()) this._onError(error);
			});
	}
}

@registerClass({
	Properties: {
		'background-size': enumParamSpec(
			'background-size',
			GObject.ParamFlags.READWRITE,
			BackgroundSize,
			BackgroundSize.Cover,
		),
		'active': flagsParamSpec('active', GObject.ParamFlags.WRITABLE, ActiveState, ActiveState.None),
	},
})
export class ImagePreview extends ContentPreview {
	private _backgroundSize: BackgroundSize = BackgroundSize.Cover;
	private _ratio: number | null = null;
	private _imageBox: ImageBox | undefined;
	private _effect: Clutter.BrightnessContrastEffect | undefined;

	constructor(
		private readonly ext: Extension,
		image: Gio.File,
	) {
		super();

		this.add_style_class_name('image-preview');

		if (image.query_exists(null)) {
			try {
				const [, width, height] = GdkPixbuf.Pixbuf.get_file_info(image.get_path()!);
				this._ratio = height / width;

				this._imageBox = new ImageBox(image, [width, height], (error) => {
					ext.getLogger().error(error);
					this.showMissingImage();
				});
				this.add_child(this._imageBox);

				this._effect = new Clutter.BrightnessContrastEffect();
				this._imageBox.add_effect(this._effect);
				return;
			} catch {
				// Ignore
			}
		}

		this.showMissingImage();
	}

	private showMissingImage() {
		this._imageBox?.destroy();
		this._imageBox = undefined;
		this._effect = undefined;
		this._ratio = null;

		this.add_style_class_name('missing-image');
		this.add_child(
			new St.Icon({
				gicon: loadIcon(this.ext, Icon.MissingImage),
				x_align: Clutter.ActorAlign.CENTER,
				y_align: Clutter.ActorAlign.CENTER,
				x_expand: true,
				y_expand: true,
				min_height: 0,
			}),
		);
	}

	get backgroundSize() {
		return this._backgroundSize;
	}

	set backgroundSize(backgroundSize: BackgroundSize) {
		this._backgroundSize = backgroundSize;
		this.notify('background-size');

		if (this._imageBox) this._imageBox.cover = backgroundSize === BackgroundSize.Cover;
	}

	set active(active: ActiveState) {
		if (!this._effect) return;

		if ((active & ActiveState.Active) > 0) {
			this._effect.set_brightness(0.2);
		} else if ((active & ActiveState.FocusHover) === (ActiveState.FocusHover as number)) {
			this._effect.set_brightness(0.1);
		} else if (active & ActiveState.Focus || active & ActiveState.Hover) {
			this._effect.set_brightness(0.05);
		} else {
			this._effect.enabled = false;
			return;
		}

		this._effect.enabled = true;
	}

	override vfunc_get_preferred_height(for_width: number): [number, number] {
		if (this._ratio === null) return super.vfunc_get_preferred_height(for_width);

		const [min] = super.vfunc_get_preferred_height(for_width);
		return [min, Math.round(for_width * Math.clamp(this._ratio, 0.3, 1))];
	}
}

@registerClass()
export class ThumbnailPreview extends ImagePreview {}

@registerClass({
	Properties: {
		'syntax-highlighting': GObject.ParamSpec.boolean(
			'syntax-highlighting',
			null,
			null,
			GObject.ParamFlags.READWRITE,
			true,
		),
		'show-line-numbers': GObject.ParamSpec.boolean(
			'show-line-numbers',
			null,
			null,
			GObject.ParamFlags.READWRITE,
			true,
		),
		'tab-width': GObject.ParamSpec.int('tab-width', null, null, GObject.ParamFlags.READWRITE, 1, 8, 4),
	},
})
export class TextPreview extends ContentPreview {
	declare syntaxHighlighting: boolean;
	declare showLineNumbers: boolean;
	declare tabWidth: number;

	constructor(ext: CopyousExtension, text: string, language?: string) {
		super();

		this.add_style_class_name('text-preview');

		const props: Partial<CodeLabelConstructorProps> = { code: text };
		if (language) props.language = { id: language, name: language };
		const label = new CodeLabel(ext, props);
		this.add_child(label);

		this.bind_property('syntax-highlighting', label, 'syntax-highlighting', null);
		this.bind_property('show-line-numbers', label, 'show-line-numbers', null);
		this.bind_property('tab-width', label, 'tab-width', null);
	}
}

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

/**
 * Creates a text preview by reading the first 4096 bytes
 * @returns The text preview
 */
async function createTextPreview(ext: CopyousExtension, file: Gio.File): Promise<TextPreview> {
	const extension = file.get_uri().match(/\.(\w+)$/)?.[1];
	const stream = await file.read_async(GLib.PRIORITY_DEFAULT, null);
	const bytes = await stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null);
	const text = new TextDecoder().decode(bytes.toArray());
	return new TextPreview(ext, text, extension);
}

/**
 * Gets the thumbnail for a file
 * @param file The file to get the thumbnail for
 * @returns The thumbnail or null if no thumbnail was found
 */
async function tryGetThumbnail(file: Gio.File): Promise<Gio.File | null> {
	const uri = file.get_uri();
	const md5 = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, uri, uri.length);

	const homeDir = GLib.get_home_dir();
	const thumbnailDir = Gio.File.new_build_filenamev([homeDir, '.cache', 'thumbnails']);

	try {
		const enumerator = await thumbnailDir.enumerate_children_async(
			'standard::*',
			Gio.FileQueryInfoFlags.NONE,
			GLib.PRIORITY_DEFAULT,
			null,
		);
		for await (const f of enumerator) {
			if (f.get_file_type() !== Gio.FileType.DIRECTORY) continue;

			const thumbnailFile = thumbnailDir.get_child(f.get_name()).get_child(`${md5}.png`);
			if (thumbnailFile.query_exists(null)) {
				return thumbnailFile;
			}
		}
	} catch {
		return null;
	}

	return null;
}

/**
 * Gets the content type of a file
 * @param file The file to guess the content type of
 * @returns The content type or null if no content type was found
 */
async function getContentType(file: Gio.File): Promise<string | null> {
	const info = await file.query_info_async(
		'standard::content-type',
		Gio.FileQueryInfoFlags.NONE,
		GLib.PRIORITY_DEFAULT,
		null,
	);
	const contentType = info.get_content_type();
	if (contentType !== null) {
		return contentType;
	}

	let data: GLib.Bytes | null = null;
	try {
		const stream = await file.read_async(GLib.PRIORITY_DEFAULT, null);
		data = await stream.read_bytes_async(64, GLib.PRIORITY_DEFAULT, null);
	} catch {
		return null;
	}

	return Gio.content_type_guess(file.get_path(), data?.toArray())[0];
}

/**
 * Gets the file type for a file
 * @param file The file to find the file type for
 * @returns The file type and a Gio.File if a thumbnail was found for the file
 */
export async function getFileType(file: Gio.File): Promise<[FileType, Gio.File | null]> {
	if (!file.query_exists(null)) return [FileType.Unknown, null];

	const fileType = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null);
	if (fileType === Gio.FileType.DIRECTORY) return [FileType.Directory, null];

	if (fileType !== Gio.FileType.REGULAR) return [FileType.Unknown, null];

	// First check if the file has thumbnail
	const thumbnail = await tryGetThumbnail(file);

	// Then check if the file has any of the allowed types
	const contentType = await getContentType(file);
	if (!contentType) return [FileType.Unknown, thumbnail];

	// Check image before text since svg is also classified as text/plain
	if (Gio.content_type_is_a(contentType, 'image/*')) return [FileType.Image, thumbnail];
	if (Gio.content_type_is_a(contentType, 'audio/*')) return [FileType.Audio, thumbnail];
	if (Gio.content_type_is_a(contentType, 'video/*')) return [FileType.Video, thumbnail];
	if (Gio.content_type_is_a(contentType, 'text/plain')) return [FileType.Text, thumbnail];

	return [FileType.Unknown, thumbnail];
}

/**
 * Try to create a file preview for a file type
 * @param ext The extension
 * @param file The file to create a preview for
 * @param fileType The type of the file
 * @param thumbnail The thumbnail of the file if it exists
 * @returns the created file preview or null if either the file preview could not be created or if it is not allowed
 */
export async function tryCreateFilePreview(
	ext: CopyousExtension,
	file: Gio.File,
	fileType: FileType,
	thumbnail: Gio.File | null,
): Promise<ContentPreview | null> {
	const allowedTypes = ext.settings.get_child('file-item').get_flags('file-preview-types');

	try {
		if (!file.query_exists(null)) return null;

		switch (fileType) {
			case FileType.Text:
				return allowedTypes & FilePreviewType.Text ? await createTextPreview(ext, file) : null;
			case FileType.Image:
				return allowedTypes & FilePreviewType.Image ? new ImagePreview(ext, file) : null;
		}

		return thumbnail && allowedTypes & FilePreviewType.Thumbnail ? new ThumbnailPreview(ext, file) : null;
	} catch (error) {
		ext.logger.error(error);
		return null;
	}
}
