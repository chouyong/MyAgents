//! Filter macOS AppKit function-key text leaks at runtime.
//!
//! ## Why this exists
//!
//! On macOS Tauri/WKWebView, pressing left/right (and up/down) arrow keys
//! at a textarea boundary causes a Unicode private-use codepoint
//! (U+F700-F74F, AppKit's `NSFunctionKey` family) to be inserted into
//! the input value as a tofu glyph. The codepoint reaches the value via
//! AppKit's responder chain default — `NSResponder.keyDown:` →
//! `interpretKeyEvents:` → `insertText:` — bypassing WebCore's edit
//! pipeline entirely (no `beforeinput`, no `input` event), which means
//! a JS-side guard cannot catch it.
//!
//! Older wry versions fixed this by swallowing arrow `keyDown:` events
//! before AppKit could fall through to `insertText:`. Current WKWebView
//! versions still need that same `keyDown:` path for normal caret movement,
//! so swallowing arrows makes the cursor stop moving.
//!
//! A narrow `insertText:` filter catches the legacy AppKit route when it is
//! used. On current WKWebView builds the leak can also land inside the DOM
//! during WebKit's `keyDown:` handling, without calling `insertText:` on the
//! wry view. For that path we forward `keyDown:` normally so the caret still
//! moves, then evaluate a small cleanup script that removes AppKit's private
//! NSFunctionKey codepoints from the focused text control.
//!
//! That fix was lost during wry's objc2 migration and has NOT been
//! reintroduced in any released version up to wry 0.55.0 (2026-03-26).
//! Tracking: tauri-apps/wry#1175, tauri-apps/tauri#10194 — both OPEN.
//!
//! Since we have `tauri/unstable` enabled (needed for child webviews
//! used by the in-app browser), we hit the regression. Until upstream
//! relands a fix, we install our own `insertText:` IMPs at startup.

#![cfg(target_os = "macos")]

use std::sync::Once;

use objc2::ffi::{class_addMethod, class_getSuperclass, objc_msgSendSuper, objc_super};
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{msg_send, sel};
use objc2_foundation::NSString;
use objc2_web_kit::WKWebView;

static INSTALL: Once = Once::new();

const FUNCTION_KEY_DOM_CLEANUP_JS: &str = r#"
(() => {
  const containsFunctionKey = /[\uF700-\uF74F]/;
  const functionKeyRange = /[\uF700-\uF74F]/g;
  const textInputTypes = new Set(['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url']);

  const stripFunctionKeys = (value) => String(value).replace(functionKeyRange, '');
  const cleanedIndex = (value, index) => {
    if (typeof index !== 'number' || index < 0) return index;
    return stripFunctionKeys(String(value).slice(0, index)).length;
  };

  const dispatchInput = (el) => {
    try {
      if (typeof InputEvent === 'function') {
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: false,
          composed: true,
          data: null,
          inputType: 'deleteContentBackward',
        }));
      } else {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (_) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  const nativeValueSetter = (el) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
    return proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
  };

  const setValue = (el, value) => {
    const setter = nativeValueSetter(el);
    if (setter) setter.call(el, value);
    else el.value = value;
  };

  const cleanTextControl = (el) => {
    if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLInputElement)) return 0;
    if (el instanceof HTMLInputElement && !textInputTypes.has((el.getAttribute('type') || '').toLowerCase())) return 0;
    const value = String(el.value ?? '');
    if (!containsFunctionKey.test(value)) return 0;

    let start = null;
    let end = null;
    let direction = 'none';
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
      direction = el.selectionDirection || 'none';
    } catch (_) {}

    const nextValue = stripFunctionKeys(value);
    setValue(el, nextValue);

    try {
      if (typeof start === 'number' && typeof end === 'number') {
        el.setSelectionRange(cleanedIndex(value, start), cleanedIndex(value, end), direction);
      }
    } catch (_) {}

    dispatchInput(el);
    return value.length - nextValue.length;
  };

  const nodeOffsetLimit = (node) => {
    if (!node) return 0;
    return node.nodeType === Node.TEXT_NODE
      ? String(node.nodeValue ?? '').length
      : node.childNodes.length;
  };

  const cleanContentEditable = (root) => {
    if (!root?.isContentEditable) return 0;

    const selection = window.getSelection?.();
    const anchorNode = selection?.anchorNode ?? null;
    const focusNode = selection?.focusNode ?? null;
    let anchorOffset = selection?.anchorOffset ?? 0;
    let focusOffset = selection?.focusOffset ?? 0;
    let removed = 0;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const value = String(node.nodeValue ?? '');
      if (containsFunctionKey.test(value)) {
        if (node === anchorNode) anchorOffset = cleanedIndex(value, anchorOffset);
        if (node === focusNode) focusOffset = cleanedIndex(value, focusOffset);
        const nextValue = stripFunctionKeys(value);
        node.nodeValue = nextValue;
        removed += value.length - nextValue.length;
      }
      node = walker.nextNode();
    }

    if (removed > 0) {
      try {
        if (selection && anchorNode && focusNode && root.contains(anchorNode) && root.contains(focusNode)) {
          const range = document.createRange();
          range.setStart(anchorNode, Math.min(anchorOffset, nodeOffsetLimit(anchorNode)));
          range.setEnd(focusNode, Math.min(focusOffset, nodeOffsetLimit(focusNode)));
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } catch (_) {}
      dispatchInput(root);
    }

    return removed;
  };

  const activeElement = () => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };

  const candidates = () => {
    const active = activeElement();
    const fields = [active, ...document.querySelectorAll('textarea,input')].filter(Boolean);
    return Array.from(new Set(fields));
  };

  const run = () => {
    let removed = 0;
    for (const el of candidates()) removed += cleanTextControl(el);
    removed += cleanContentEditable(activeElement());
    return removed;
  };

  const total = run();
  if (typeof queueMicrotask === 'function') queueMicrotask(run);
  else Promise.resolve().then(run);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  setTimeout(run, 0);
  setTimeout(run, 32);
  return total;
})();
"#;

pub fn install_arrow_key_filter() {
    INSTALL.call_once(|| unsafe {
        install_inner();
    });
}

unsafe fn install_inner() {
    let cls = match find_wry_webview_class() {
        Some(c) => c,
        None => {
            crate::ulog_warn!("[macos_arrow_filter] wry WKWebView subclass not found; arrow-key filter not installed (leak workaround inactive)");
            return;
        }
    };

    crate::ulog_info!(
        "[macos_arrow_filter] installing diagnostics on class chain: {}",
        class_chain(cls)
    );

    install_key_down_probe(cls);
    install_insert_text_filter(cls);
    install_insert_text_replacement_range_filter(cls);
}

unsafe fn install_key_down_probe(cls: &AnyClass) {
    let sel: Sel = sel!(keyDown:);
    let types = c"v@:@";
    let imp_fn: extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) = key_down_probe;
    let imp: Imp = std::mem::transmute(imp_fn);

    let added = class_addMethod(
        (cls as *const AnyClass) as *mut AnyClass,
        sel,
        imp,
        types.as_ptr(),
    );

    if added.as_bool() {
        crate::ulog_info!("[macos_arrow_filter] WryWebView keyDown: diagnostic probe installed");
    } else {
        crate::ulog_info!("[macos_arrow_filter] WryWebView already has a direct keyDown: method; keyDown diagnostic probe not installed");
    }
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
        crate::ulog_info!("[macos_arrow_filter] WryWebView insertText: filter installed");
    } else {
        crate::ulog_info!("[macos_arrow_filter] WryWebView already has a direct insertText: method; skipping legacy insertText filter");
    }
}

unsafe fn install_insert_text_replacement_range_filter(cls: &AnyClass) {
    let sel: Sel = sel!(insertText:replacementRange:);
    if cls.instance_method(sel).is_none() {
        crate::ulog_info!("[macos_arrow_filter] WryWebView superclass chain does not implement insertText:replacementRange:; skipping replacementRange filter");
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
        crate::ulog_info!("[macos_arrow_filter] WryWebView insertText:replacementRange: filter installed");
    } else {
        crate::ulog_info!("[macos_arrow_filter] WryWebView already has a direct insertText:replacementRange: method; skipping replacementRange filter");
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
    let mut matches = Vec::new();
    for cls in AnyClass::classes().iter().copied() {
        let name = cls.name().to_string_lossy();
        if is_wry_webview_class_name(&name) {
            if name.starts_with("..NSKVONotifying_") {
                kvo_subclass = Some(cls);
            } else {
                generated = Some(cls);
            }
            matches.push(name.into_owned());
        }
    }

    let found = generated.or(kvo_subclass);
    if let Some(cls) = found {
        let selected = cls.name().to_string_lossy();
        if matches.len() > 1 {
            crate::ulog_warn!(
                "[macos_arrow_filter] multiple WryWebView-like classes found: {}; using {}",
                matches.join(", "),
                selected
            );
        } else {
            crate::ulog_info!(
                "[macos_arrow_filter] found generated WryWebView class: {selected}"
            );
        }
    }

    found
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
        log_text_if_relevant("insertText:", this, insert_string);

        if object_is_pure_function_key_text(insert_string) {
            crate::ulog_warn!(
                "[macos_arrow_filter] blocked pure function-key insertText: receiver={} text={}",
                object_class_name(this),
                describe_text_object(insert_string)
            );
            return;
        }

        let super_struct = super_struct(this);

        // objc_msgSendSuper has signature `id (struct objc_super *, SEL, ...)`
        // but we want void return on a single id arg. Cast to the right
        // signature before calling.
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
        log_text_if_relevant("insertText:replacementRange:", this, insert_string);

        if object_is_pure_function_key_text(insert_string) {
            crate::ulog_warn!(
                "[macos_arrow_filter] blocked pure function-key insertText:replacementRange: receiver={} range={}:{} text={}",
                object_class_name(this),
                replacement_range.location,
                replacement_range.length,
                describe_text_object(insert_string)
            );
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

extern "C" fn key_down_probe(this: *mut AnyObject, _sel: Sel, event: *mut AnyObject) {
    unsafe {
        let keycode: u16 = msg_send![&*event, keyCode];
        let chars: *mut AnyObject = msg_send![&*event, characters];
        let chars_ignoring_modifiers: *mut AnyObject =
            msg_send![&*event, charactersIgnoringModifiers];
        let is_arrow = (123..=126).contains(&keycode);
        let has_function_text =
            object_contains_function_key_text(chars)
                || object_contains_function_key_text(chars_ignoring_modifiers);

        if is_arrow || has_function_text {
            let modifiers: usize = msg_send![&*event, modifierFlags];
            let repeat: Bool = msg_send![&*event, isARepeat];
            crate::ulog_warn!(
                "[macos_arrow_filter] keyDown probe keycode={} repeat={} modifiers=0x{:x} receiver={} firstResponder={} chars={} charsIgnoringModifiers={}",
                keycode,
                repeat.as_bool(),
                modifiers,
                object_class_name(this),
                first_responder_class_name(this),
                describe_text_object(chars),
                describe_text_object(chars_ignoring_modifiers)
            );
        }

        let super_struct = super_struct(this);
        type SuperKeyDown = extern "C" fn(*const objc_super, Sel, *mut AnyObject);
        let send_super: SuperKeyDown = std::mem::transmute(objc_msgSendSuper as *const ());
        send_super(&super_struct, sel!(keyDown:), event);

        if is_arrow || has_function_text {
            schedule_function_key_dom_cleanup(this, keycode, has_function_text);
        }
    }
}

unsafe fn schedule_function_key_dom_cleanup(
    webview: *mut AnyObject,
    keycode: u16,
    has_function_text: bool,
) {
    if webview.is_null() {
        return;
    }

    crate::ulog_warn!(
        "[macos_arrow_filter] keyDown forwarded; scheduled DOM private-use cleanup keycode={} has_function_text={}",
        keycode,
        has_function_text
    );

    let script = NSString::from_str(FUNCTION_KEY_DOM_CLEANUP_JS);
    let webview = &*(webview as *mut WKWebView);
    webview.evaluateJavaScript_completionHandler(&script, None);
}

unsafe fn super_struct(this: *mut AnyObject) -> objc_super {
    let cls: *const AnyClass = msg_send![this, class];
    objc_super {
        receiver: this,
        super_class: class_getSuperclass(cls),
    }
}

fn class_chain(cls: &AnyClass) -> String {
    let mut names = Vec::new();
    let mut cursor = Some(cls);
    while let Some(current) = cursor {
        names.push(current.name().to_string_lossy().into_owned());
        cursor = current.superclass();
    }
    names.join(" -> ")
}

unsafe fn object_class_name(obj: *mut AnyObject) -> String {
    if obj.is_null() {
        return "nil".to_string();
    }
    let cls: *const AnyClass = msg_send![&*obj, class];
    cls.as_ref()
        .map(|c| c.name().to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown".to_string())
}

unsafe fn first_responder_class_name(view: *mut AnyObject) -> String {
    if view.is_null() {
        return "nil".to_string();
    }
    let window: *mut AnyObject = msg_send![&*view, window];
    if window.is_null() {
        return "nil-window".to_string();
    }
    let first_responder: *mut AnyObject = msg_send![&*window, firstResponder];
    object_class_name(first_responder)
}

unsafe fn log_text_if_relevant(selector: &str, receiver: *mut AnyObject, text: *mut AnyObject) {
    if object_contains_function_key_text(text) {
        crate::ulog_warn!(
            "[macos_arrow_filter] {} saw function-key text receiver={} text={}",
            selector,
            object_class_name(receiver),
            describe_text_object(text)
        );
    }
}

unsafe fn object_contains_function_key_text(obj: *mut AnyObject) -> bool {
    text_code_units(obj)
        .map(|units| units.iter().any(|ch| (0xf700..=0xf74f).contains(ch)))
        .unwrap_or(false)
}

unsafe fn object_is_pure_function_key_text(obj: *mut AnyObject) -> bool {
    let Some(units) = text_code_units(obj) else {
        return false;
    };
    !units.is_empty() && units.iter().all(|ch| (0xf700..=0xf74f).contains(ch))
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

unsafe fn describe_text_object(obj: *mut AnyObject) -> String {
    if obj.is_null() {
        return "nil".to_string();
    }
    let class_name = object_class_name(obj);
    match text_code_units(obj) {
        Some(units) => format!("class={} len={} units={}", class_name, units.len(), format_units(&units)),
        None => format!("class={} non-text-like", class_name),
    }
}

fn format_units(units: &[u16]) -> String {
    if units.is_empty() {
        return "[]".to_string();
    }
    let mut parts: Vec<String> = units
        .iter()
        .take(24)
        .map(|ch| format!("U+{ch:04X}"))
        .collect();
    if units.len() > 24 {
        parts.push(format!("...(+{})", units.len() - 24));
    }
    format!("[{}]", parts.join(" "))
}
