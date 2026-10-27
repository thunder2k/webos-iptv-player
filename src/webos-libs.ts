// webOS 3.9 production build exposes hls.js as a global for VOD playback.
// webOS 3.9's native player cannot play MP4 VOD from some Xtream servers,
// so hls.js (via MediaSource Extensions) is used as a fallback.
// MediaSource is available on webOS 3.9 (Chromium 38).
import Hls from 'hls.js';

(window as unknown as Record<string, unknown>).__Hls = Hls;
