// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/media-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/media-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveChannelMediaMaxBytes() { _w('resolveChannelMediaMaxBytes'); return undefined; }
export function normalizeMediaProviderId() { _w('normalizeMediaProviderId'); return ""; }
export function createDirectTextMediaOutbound() { _w('createDirectTextMediaOutbound'); return undefined; }
export function createScopedChannelMediaMaxBytesResolver() { _w('createScopedChannelMediaMaxBytesResolver'); return undefined; }
export function resolveScopedChannelMediaMaxBytes() { _w('resolveScopedChannelMediaMaxBytes'); return undefined; }
export function isVoiceMessageCompatibleAudio() { _w('isVoiceMessageCompatibleAudio'); return false; }
export function isVoiceCompatibleAudio() { _w('isVoiceCompatibleAudio'); return false; }
export const VOICE_MESSAGE_AUDIO_EXTENSIONS = undefined;
export const VOICE_MESSAGE_MIME_TYPES = undefined;
export async function transcodeAudioBufferToOpus() { _w('transcodeAudioBufferToOpus'); return undefined; }
export function estimateBase64DecodedBytes() { _w('estimateBase64DecodedBytes'); return undefined; }
export function canonicalizeBase64() { _w('canonicalizeBase64'); return undefined; }
export function mediaKindFromMime() { _w('mediaKindFromMime'); return undefined; }
export function maxBytesForKind() { _w('maxBytesForKind'); return undefined; }
export const MAX_IMAGE_BYTES = undefined;
export const MAX_AUDIO_BYTES = undefined;
export const MAX_VIDEO_BYTES = undefined;
export const MAX_DOCUMENT_BYTES = undefined;
export async function fetchRemoteMedia() { _w('fetchRemoteMedia'); return undefined; }
export class MediaFetchError { constructor() { _w('MediaFetchError'); } }
export async function runFfprobe() { _w('runFfprobe'); return undefined; }
export async function runFfmpeg() { _w('runFfmpeg'); return undefined; }
export function parseFfprobeCsvFields() { _w('parseFfprobeCsvFields'); return undefined; }
export function parseFfprobeCodecAndSampleRate() { _w('parseFfprobeCodecAndSampleRate'); return undefined; }
export const MEDIA_FFMPEG_MAX_BUFFER_BYTES = undefined;
export const MEDIA_FFPROBE_TIMEOUT_MS = undefined;
export const MEDIA_FFMPEG_TIMEOUT_MS = undefined;
export const MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS = undefined;
export async function getImageMetadata() { _w('getImageMetadata'); return undefined; }
export async function normalizeExifOrientation() { _w('normalizeExifOrientation'); return ""; }
export async function resizeToJpeg() { _w('resizeToJpeg'); return undefined; }
export async function convertHeicToJpeg() { _w('convertHeicToJpeg'); return undefined; }
export async function hasAlphaChannel() { _w('hasAlphaChannel'); return false; }
export async function resizeToPng() { _w('resizeToPng'); return undefined; }
export async function optimizeImageToPng() { _w('optimizeImageToPng'); return undefined; }
export function buildImageResizeSideGrid() { _w('buildImageResizeSideGrid'); return undefined; }
export const IMAGE_REDUCE_QUALITY_STEPS = undefined;
export const MAX_IMAGE_INPUT_PIXELS = undefined;
export function isValidInboundPathRootPattern() { _w('isValidInboundPathRootPattern'); return false; }
export function normalizeInboundPathRoots() { _w('normalizeInboundPathRoots'); return ""; }
export function mergeInboundPathRoots() { _w('mergeInboundPathRoots'); return undefined; }
export function isInboundPathAllowed() { _w('isInboundPathAllowed'); return false; }
export function resolveOutboundMediaLocalRoots() { _w('resolveOutboundMediaLocalRoots'); return undefined; }
export function resolveOutboundMediaAccess() { _w('resolveOutboundMediaAccess'); return undefined; }
export function buildOutboundMediaLoadOptions() { _w('buildOutboundMediaLoadOptions'); return undefined; }
export async function assertLocalMediaAllowed() { _w('assertLocalMediaAllowed'); return undefined; }
export function getDefaultLocalRoots() { _w('getDefaultLocalRoots'); return undefined; }
export class LocalMediaAccessError { constructor() { _w('LocalMediaAccessError'); } }
export function buildMediaLocalRoots() { _w('buildMediaLocalRoots'); return undefined; }
export function getDefaultMediaLocalRoots() { _w('getDefaultMediaLocalRoots'); return undefined; }
export function getAgentScopedMediaLocalRoots() { _w('getAgentScopedMediaLocalRoots'); return undefined; }
export function appendLocalMediaParentRoots() { _w('appendLocalMediaParentRoots'); return undefined; }
export function getAgentScopedMediaLocalRootsForSources() { _w('getAgentScopedMediaLocalRootsForSources'); return undefined; }
export function normalizeMimeType() { _w('normalizeMimeType'); return ""; }
export function sliceMimeSniffBuffer() { _w('sliceMimeSniffBuffer'); return undefined; }
export function getFileExtension() { _w('getFileExtension'); return undefined; }
export function mimeTypeFromFilePath() { _w('mimeTypeFromFilePath'); return undefined; }
export function isAudioFileName() { _w('isAudioFileName'); return false; }
export function detectMime() { _w('detectMime'); return undefined; }
export function extensionForMime() { _w('extensionForMime'); return undefined; }
export function isGifMedia() { _w('isGifMedia'); return false; }
export function imageMimeFromFormat() { _w('imageMimeFromFormat'); return undefined; }
export function kindFromMime() { _w('kindFromMime'); return undefined; }
export const FILE_TYPE_SNIFF_MAX_BYTES = undefined;
export async function resolveOutboundAttachmentFromUrl() { _w('resolveOutboundAttachmentFromUrl'); return undefined; }
export function crc32() { _w('crc32'); return undefined; }
export function pngChunk() { _w('pngChunk'); return undefined; }
export function fillPixel() { _w('fillPixel'); return undefined; }
export function encodePngRgba() { _w('encodePngRgba'); return ""; }
export async function renderQrPngBase64() { _w('renderQrPngBase64'); return undefined; }
export async function renderQrPngDataUrl() { _w('renderQrPngDataUrl'); return undefined; }
export async function writeQrPngTempFile() { _w('writeQrPngTempFile'); return undefined; }
export function formatQrPngDataUrl() { _w('formatQrPngDataUrl'); return ""; }
export async function renderQrTerminal() { _w('renderQrTerminal'); return undefined; }
export async function readResponseWithLimit() { _w('readResponseWithLimit'); return undefined; }
export async function readResponseTextSnippet() { _w('readResponseTextSnippet'); return undefined; }
export async function ensureMediaDir() { _w('ensureMediaDir'); return undefined; }
export async function cleanOldMedia() { _w('cleanOldMedia'); return undefined; }
export async function saveMediaSource() { _w('saveMediaSource'); return undefined; }
export async function saveMediaBuffer() { _w('saveMediaBuffer'); return undefined; }
export async function resolveMediaBufferPath() { _w('resolveMediaBufferPath'); return undefined; }
export async function deleteMediaBuffer() { _w('deleteMediaBuffer'); return undefined; }
export function setMediaStoreNetworkDepsForTest() { _w('setMediaStoreNetworkDepsForTest'); return undefined; }
export function extractOriginalFilename() { _w('extractOriginalFilename'); return undefined; }
export function getMediaDir() { _w('getMediaDir'); return undefined; }
export class SaveMediaSourceError { constructor() { _w('SaveMediaSourceError'); } }
export const MEDIA_MAX_BYTES = undefined;
export async function unlinkIfExists() { _w('unlinkIfExists'); return undefined; }
export function buildAgentMediaPayload() { _w('buildAgentMediaPayload'); return undefined; }
export async function transcribeFirstAudio() { _w('transcribeFirstAudio'); return undefined; }
export function resolveDefaultMediaModel() { _w('resolveDefaultMediaModel'); return undefined; }
export function resolveAutoMediaKeyProviders() { _w('resolveAutoMediaKeyProviders'); return undefined; }
export function providerSupportsNativePdfDocument() { _w('providerSupportsNativePdfDocument'); return undefined; }
export const DEFAULT_MAX_CHARS = undefined;
export const DEFAULT_MAX_CHARS_BY_CAPABILITY = undefined;
export const DEFAULT_MAX_BYTES = undefined;
export const DEFAULT_TIMEOUT_SECONDS = undefined;
export const DEFAULT_PROMPT = undefined;
export const DEFAULT_VIDEO_MAX_BASE64_BYTES = undefined;
export const CLI_OUTPUT_MAX_BUFFER = undefined;
export const DEFAULT_MEDIA_CONCURRENCY = undefined;
export const MIN_AUDIO_FILE_BYTES = undefined;
export const describeImageWithModel = undefined;
export const describeImagesWithModel = undefined;
export const describeImageWithModelPayloadTransform = undefined;
export const describeImagesWithModelPayloadTransform = undefined;
export async function resolveAutoImageModel() { _w('resolveAutoImageModel'); return undefined; }
export async function runCapability() { _w('runCapability'); return undefined; }
export function buildProviderRegistry() { _w('buildProviderRegistry'); return undefined; }
export function resolveMediaAttachmentLocalRoots() { _w('resolveMediaAttachmentLocalRoots'); return undefined; }
export function clearMediaUnderstandingBinaryCacheForTests() { _w('clearMediaUnderstandingBinaryCacheForTests'); return undefined; }
export function createMediaAttachmentCache() { _w('createMediaAttachmentCache'); return undefined; }
export function normalizeMediaAttachments() { _w('normalizeMediaAttachments'); return ""; }
export function resolvePollMaxSelections() { _w('resolvePollMaxSelections'); return undefined; }
export function normalizePollInput() { _w('normalizePollInput'); return ""; }
export function normalizePollDurationHours() { _w('normalizePollDurationHours'); return ""; }
