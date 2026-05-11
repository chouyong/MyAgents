// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/image-generation.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/image-generation.' + fn + '() not implemented in Bridge mode'); }
}

export function createOpenAiCompatibleImageGenerationProvider() { _w('createOpenAiCompatibleImageGenerationProvider'); return undefined; }
export function generatedImageAssetFromBase64() { _w('generatedImageAssetFromBase64'); return undefined; }
export function generatedImageAssetFromDataUrl() { _w('generatedImageAssetFromDataUrl'); return undefined; }
export function generatedImageAssetFromOpenAiCompatibleEntry() { _w('generatedImageAssetFromOpenAiCompatibleEntry'); return undefined; }
export function imageFileExtensionForMimeType() { _w('imageFileExtensionForMimeType'); return undefined; }
export function imageSourceUploadFileName() { _w('imageSourceUploadFileName'); return undefined; }
export function parseImageDataUrl() { _w('parseImageDataUrl'); return undefined; }
export function parseOpenAiCompatibleImageResponse() { _w('parseOpenAiCompatibleImageResponse'); return undefined; }
export function sniffImageMimeType() { _w('sniffImageMimeType'); return undefined; }
export function toImageDataUrl() { _w('toImageDataUrl'); return undefined; }
