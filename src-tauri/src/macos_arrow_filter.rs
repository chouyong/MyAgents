//! Filter macOS AppKit function-key text leaks at runtime.
//!
//! ## What leaks
//!
//! On macOS Tauri/WKWebView, pressing left/right/up/down arrow keys at a
//! textarea boundary causes a control codepoint to be inserted into the
//! input value, rendered as a tofu glyph. NSEvent.characters carries the
//! arrow key in TWO bands:
//!
//!   - `U+F700-U+F74F` — NSFunctionKey (Cocoa naming)
//!   - `U+001C-U+001F` — ASCII C0 controls (FS/GS/RS/US, legacy ANSI)
//!
//! Empirically WebKit's silent insert path leaks the **C0 control**
//! codepoint into the textarea value, NOT the NSFunctionKey one. A filter
//! that only matches U+F700-F74F (as wry's pre-objc2 fix did) misses the
//! actual leak. Both ranges must be treated as function-key text.
//!
//! ## Defense layers
//!
//! 1. **JS document-level capture** (`renderer/utils/macFunctionKeyGuard.ts`)
//!    — primary defense. `keydown` capture schedules a post-mutation scrub
//!    across micro-task / rAF / setTimeout boundaries that strips the leak
//!    codepoints from `el.value` after WebKit's silent DOM mutation.
//!
//! 2. **ObjC `insertText:` filter** (this file) — defensive belt against
//!    the legacy AppKit responder route (`NSResponder.keyDown:` →
//!    `interpretKeyEvents:` → `insertText:`). Empirically zero hits on
//!    current WebKit (the leak goes through the silent path, layer 1
//!    handles it), but kept in case macOS ever reverts to that route.
//!
//! ## Background
//!
//! Older wry versions fixed this by swallowing arrow `keyDown:` events
//! before AppKit could fall through to `insertText:`. That fix was lost
//! during wry's objc2 migration and has NOT been reintroduced in any
//! released version up to wry 0.55.0 (2026-03-26). We have
//! `tauri/unstable` enabled (needed for child webviews) so we hit the
//! regression. Tracking: tauri-apps/wry#1175, tauri-apps/tauri#10194.
//!
//! See `specs/tech_docs/macos_arrow_key_leak_investigation.md` for the
//! full investigation log and the C0-control-codepoint discovery.

#![cfg(target_os = "macos")]

use std::sync::Once;

use objc2::ffi::{class_addMethod, class_getSuperclass, objc_msgSendSuper, objc_super};
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{msg_send, sel};

static INSTALL: Once = Once::new();

pub fn install_arrow_key_filter() {
    INSTALL.call_once(|| unsafe {
        install_inner();
    });
}

unsafe fn install_inner() {
    let cls = match find_wry_webview_class() {
        Some(c) => c,
        None => {
            crate::ulog_warn!("[macos_arrow_filter] wry WKWebView subclass not found; insertText filter not installed");
            return;
        }
    };

    install_insert_text_filter(cls);
    install_insert_text_replacement_range_filter(cls);
}

unsafe fn install_insert_text_filter(cls: &AnyClass) {
    let sel: Sel = sel!(insertText:);
    let types = c"v@:@";
    let imp_fn: extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) = insert_text_filter;
    let imp: Imp = std::mem::transmute(imp_fn);

    let added = class_addMethod(
        (cls as *const AnyClass) as *mut AnyClass,
        sel,
        imp,
        types.as_ptr(),
    );

    if added.as_bool() {
        crate::ulog_info!("[macos_arrow_filter] insertText: filter installed");
    } else {
        crate::ulog_info!("[macos_arrow_filter] WryWebView already overrides insertText:; skipping");
    }
}

unsafe fn install_insert_text_replacement_range_filter(cls: &AnyClass) {
    let sel: Sel = sel!(insertText:replacementRange:);
    if cls.instance_method(sel).is_none() {
        return;
    }

    let types = c"v@:@{_NSRange=QQ}";
    let imp_fn: extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, NSRange) =
        insert_text_replacement_range_filter;
    let imp: Imp = std::mem::transmute(imp_fn);

    let added = class_addMethod(
        (cls as *const AnyClass) as *mut AnyClass,
        sel,
        imp,
        types.as_ptr(),
    );

    if added.as_bool() {
        crate::ulog_info!("[macos_arrow_filter] insertText:replacementRange: filter installed");
    }
}

fn find_wry_webview_class() -> Option<&'static AnyClass> {
    // wry <= 0.54.2 used an explicit ObjC class name.
    if let Some(cls) = AnyClass::get(c"WryWebView") {
        return Some(cls);
    }

    // wry 0.54.4 removed `#[name = "WryWebView"]`. objc2 then generates a
    // version-suffixed class name such as
    // `wry::wkwebview::class::wry_web_view::WryWebView0.54.4`.
    let mut generated = None;
    let mut kvo_subclass = None;
    for cls in AnyClass::classes().iter().copied() {
        let name = cls.name().to_string_lossy();
        if !is_wry_webview_class_name(&name) {
            continue;
        }
        if name.starts_with("..NSKVONotifying_") {
            kvo_subclass = Some(cls);
        } else {
            generated = Some(cls);
        }
    }

    generated.or(kvo_subclass)
}

fn is_wry_webview_class_name(name: &str) -> bool {
    let tail = name.rsplit("::").next().unwrap_or(name);
    if tail == "WryWebView" {
        return true;
    }
    let Some(version) = tail.strip_prefix("WryWebView") else {
        return false;
    };
    version.chars().next().is_some_and(|c| c.is_ascii_digit())
}

#[repr(C)]
#[derive(Clone, Copy)]
struct NSRange {
    location: usize,
    length: usize,
}

extern "C" fn insert_text_filter(this: *mut AnyObject, _sel: Sel, insert_string: *mut AnyObject) {
    unsafe {
        if object_is_pure_function_key_text(insert_string) {
            return;
        }
        let super_struct = super_struct(this);
        type SuperInsertText = extern "C" fn(*const objc_super, Sel, *mut AnyObject);
        let send_super: SuperInsertText = std::mem::transmute(objc_msgSendSuper as *const ());
        send_super(&super_struct, sel!(insertText:), insert_string);
    }
}

extern "C" fn insert_text_replacement_range_filter(
    this: *mut AnyObject,
    _sel: Sel,
    insert_string: *mut AnyObject,
    replacement_range: NSRange,
) {
    unsafe {
        if object_is_pure_function_key_text(insert_string) {
            return;
        }
        let super_struct = super_struct(this);
        type SuperInsertTextReplacementRange =
            extern "C" fn(*const objc_super, Sel, *mut AnyObject, NSRange);
        let send_super: SuperInsertTextReplacementRange =
            std::mem::transmute(objc_msgSendSuper as *const ());
        send_super(
            &super_struct,
            sel!(insertText:replacementRange:),
            insert_string,
            replacement_range,
        );
    }
}

unsafe fn super_struct(this: *mut AnyObject) -> objc_super {
    let cls: *const AnyClass = msg_send![this, class];
    objc_super {
        receiver: this,
        super_class: class_getSuperclass(cls),
    }
}

// macOS keyboard paths leak unprintable codepoints into textareas:
//   - U+F700-U+F74F (NSFunctionKey, Cocoa naming)
//   - U+001C-U+001F (ASCII C0 controls for arrow keys, legacy ANSI)
//   - U+0016 SYN and other C0 controls (Cmd+V on empty clipboard etc)
// Tab (U+0009), LF (U+000A), CR (U+000D) are the ONLY legitimate C0
// controls in user input. Everything else in C0/DEL/C1/NSFunctionKey
// is a leak.
fn is_function_key_codepoint(ch: u16) -> bool {
    if (0xf700..=0xf74f).contains(&ch) {
        return true;
    }
    if ch == 0x09 || ch == 0x0a || ch == 0x0d {
        return false;
    }
    ch <= 0x1f || (0x7f..=0x9f).contains(&ch)
}

unsafe fn object_is_pure_function_key_text(obj: *mut AnyObject) -> bool {
    let Some(units) = text_code_units(obj) else {
        return false;
    };
    !units.is_empty() && units.iter().all(|ch| is_function_key_codepoint(*ch))
}

unsafe fn text_code_units(obj: *mut AnyObject) -> Option<Vec<u16>> {
    if obj.is_null() {
        return None;
    }

    let responds_to_length: Bool = msg_send![&*obj, respondsToSelector: sel!(length)];
    let responds_to_character_at_index: Bool =
        msg_send![&*obj, respondsToSelector: sel!(characterAtIndex:)];
    if !responds_to_length.as_bool() {
        return None;
    }
    if !responds_to_character_at_index.as_bool() {
        // NSAttributedString and similar wrap a backing string we can read.
        let responds_to_string: Bool = msg_send![&*obj, respondsToSelector: sel!(string)];
        if responds_to_string.as_bool() {
            let string_obj: *mut AnyObject = msg_send![&*obj, string];
            if string_obj != obj {
                return text_code_units(string_obj);
            }
        }
        return None;
    }

    let len: usize = msg_send![&*obj, length];
    let mut units = Vec::with_capacity(len.min(64));
    for i in 0..len {
        let ch: u16 = msg_send![&*obj, characterAtIndex: i];
        units.push(ch);
    }
    Some(units)
}
