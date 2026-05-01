// useImageAttachments — shared image-attachment state for helper input surfaces
// (BugReportOverlay floating dialog + SettingsHelperInbox inline entry).
//
// Owns the image list, drag/drop state, and event handlers. Cap enforcement
// happens twice: a synchronous fast-path (`countRef`) at the input boundary
// to preserve selection-order semantics (drop the *later* files when batch
// dropping > maxImages, matching the original BugReportOverlay), plus a
// race-safe check inside `setImages(prev => …)` to handle the case where
// FileReaders complete out of order. Failed reads are silently dropped —
// matching the prior BugReportOverlay behavior; toast surfaces stay caller
// responsibility (SimpleChatInput owns its own toast path).
//
// Lifecycle: callers should treat this hook as fire-and-forget — pending
// FileReaders that complete after unmount no-op via `mountedRef`, so there
// is no `setState on unmounted component` warning even when the user
// navigates away mid-read.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent, ClipboardEvent } from 'react';

import { ALLOWED_IMAGE_MIME_TYPES } from '../../shared/fileTypes';
import type { ImageAttachment } from '@/components/SimpleChatInput';

export interface UseImageAttachmentsOptions {
    /** Maximum number of attached images. Default 5. */
    maxImages?: number;
    /** Maximum per-image byte size. Default 5 MiB. */
    maxImageSize?: number;
}

export interface UseImageAttachmentsResult {
    images: ImageAttachment[];
    /** Add a single file. Silently ignored if it fails MIME/size/count checks. */
    addFile: (file: File) => void;
    /** Add multiple files. Convenience wrapper. */
    addFiles: (files: Iterable<File>) => void;
    /** Remove by id. */
    removeAt: (id: string) => void;
    /** Remove all. */
    clear: () => void;
    /** Whether a drag is currently over the drop target. */
    isDragging: boolean;
    /** Spread onto any container element to accept drag-and-drop image files. */
    dragHandlers: {
        onDragOver: (e: DragEvent) => void;
        onDragLeave: (e: DragEvent) => void;
        onDrop: (e: DragEvent) => void;
    };
    /** Pass to textarea/input `onPaste` to accept clipboard images. */
    pasteHandler: (e: ClipboardEvent) => void;
}

const DEFAULT_MAX_IMAGES = 5;
const DEFAULT_MAX_IMAGE_SIZE = 5 * 1024 * 1024;

function makeId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function useImageAttachments(
    options: UseImageAttachmentsOptions = {},
): UseImageAttachmentsResult {
    const maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;
    const maxImageSize = options.maxImageSize ?? DEFAULT_MAX_IMAGE_SIZE;

    const [images, setImages] = useState<ImageAttachment[]>([]);
    const [isDragging, setIsDragging] = useState(false);

    // Synchronous mirror of `images.length` — used by `addFile` for selection-
    // order cap enforcement (the FileReader-completion ordering would
    // otherwise drop the wrong files when batches > maxImages arrive).
    const countRef = useRef(0);
    useEffect(() => { countRef.current = images.length; }, [images.length]);

    const mountedRef = useRef(true);
    useEffect(() => () => { mountedRef.current = false; }, []);

    const addFile = useCallback((file: File) => {
        // Sync fast-path: matches original BugReportOverlay selection-order
        // semantics, and avoids spinning up a FileReader that would just be
        // discarded.
        if (countRef.current >= maxImages) return;
        if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) return;
        if (file.size > maxImageSize) return;
        countRef.current += 1; // optimistic — backed out below if read fails

        const reader = new FileReader();
        reader.onload = (e) => {
            if (!mountedRef.current) return;
            const dataUrl = e.target?.result as string | undefined;
            if (!dataUrl) {
                countRef.current = Math.max(0, countRef.current - 1);
                return;
            }
            setImages(prev => {
                // Defensive cap re-check: prev.length is the source of truth
                // for actually-rendered state; countRef is only the optimistic
                // sync mirror.
                if (prev.length >= maxImages) {
                    countRef.current = prev.length;
                    return prev;
                }
                return [...prev, { id: makeId(), file, preview: dataUrl }];
            });
        };
        reader.onerror = () => {
            countRef.current = Math.max(0, countRef.current - 1);
        };
        reader.readAsDataURL(file);
    }, [maxImages, maxImageSize]);

    const addFiles = useCallback((files: Iterable<File>) => {
        for (const file of files) addFile(file);
    }, [addFile]);

    const removeAt = useCallback((id: string) => {
        setImages(prev => {
            const next = prev.filter(img => img.id !== id);
            countRef.current = next.length;
            return next;
        });
    }, []);

    const clear = useCallback(() => {
        countRef.current = 0;
        setImages([]);
    }, []);

    const onDragOver = useCallback((e: DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const onDragLeave = useCallback((e: DragEvent) => {
        e.preventDefault();
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsDragging(false);
        }
    }, []);

    const onDrop = useCallback((e: DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const files: File[] = [];
        for (const file of Array.from(e.dataTransfer.files)) {
            if (file.type.startsWith('image/')) files.push(file);
        }
        if (files.length > 0) addFiles(files);
    }, [addFiles]);

    const pasteHandler = useCallback((e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of Array.from(items)) {
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file && file.type.startsWith('image/')) {
                    e.preventDefault();
                    addFile(file);
                    return;
                }
            }
        }
    }, [addFile]);

    return {
        images,
        addFile,
        addFiles,
        removeAt,
        clear,
        isDragging,
        dragHandlers: { onDragOver, onDragLeave, onDrop },
        pasteHandler,
    };
}
