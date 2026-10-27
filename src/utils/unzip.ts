import { createLogger } from './logger';
import { unzipSync, strFromU8 } from 'fflate';

const log = createLogger('Unzip');
const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;

/** Extract the first subtitle file's UTF-8 text from a zip byte array.
 *  Returns null when the archive has no subtitle entry or can't be read. */
export async function firstSubtitleFromZip(bytes: Uint8Array): Promise<{ name: string; text: string } | null> {
  try {
    const files = unzipSync(bytes);
    for (const name of Object.keys(files)) {
      if (SUB_EXT.test(name)) return { name, text: strFromU8(files[name]) };
    }
    return null;
  } catch (e) {
    log.warn('unzip failed:', e);
    return null;
  }
}

/** Like firstSubtitleFromZip but returns the raw bytes, so the caller can pick
 *  the text encoding (e.g. GB18030 for Chinese subs). Null when none/failure. */
export async function firstSubtitleBytesFromZip(bytes: Uint8Array): Promise<{ name: string; bytes: Uint8Array } | null> {
  try {
    const files = unzipSync(bytes);
    for (const name of Object.keys(files)) {
      if (SUB_EXT.test(name)) return { name, bytes: files[name] };
    }
    return null;
  } catch (e) {
    log.warn('unzip (bytes) failed:', e);
    return null;
  }
}
