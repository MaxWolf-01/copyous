import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Width and height of an image file, without decoding it and without blocking the main thread.
 *
 * GdkPixbuf.Pixbuf.get_file_info blocks: where GdkPixbuf loads images through glycin, each call starts a sandboxed
 * loader process, about 80 ms. PNG, the format copied images arrive in, is read from its header instead.
 */
export async function getImageSize(
	file: Gio.File,
	cancellable: Gio.Cancellable | null,
): Promise<readonly [number, number]> {
	const png = await readPngSize(file, cancellable);
	if (png) return png;

	return new Promise((resolve, reject) => {
		GdkPixbuf.Pixbuf.get_file_info_async(file.get_path()!, cancellable, (_, result) => {
			try {
				const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info_finish(result);
				if (format === null) throw new Error(`Not an image: ${file.get_uri()}`);
				resolve([width, height]);
			} catch (error) {
				reject(error as Error);
			}
		});
	});
}

async function readPngSize(file: Gio.File, cancellable: Gio.Cancellable | null) {
	const stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
	try {
		// Signature, then the IHDR chunk: length, type, width, height (big-endian)
		const bytes = (await stream.read_bytes_async(24, GLib.PRIORITY_DEFAULT, cancellable)).toArray();
		if (bytes.length < 24 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;

		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		return [view.getUint32(16), view.getUint32(20)] as const;
	} finally {
		stream.close(null);
	}
}
