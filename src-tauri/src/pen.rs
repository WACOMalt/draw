// Pen pressure for engines that do not give it to web pages.
//
// WebKitGTK (Linux) and WKWebView (macOS) report a tablet pen as a mouse with no pressure
// (WebKit bug 204115; the GTK and Mac event factories set force 0 and pointerType "mouse").
// The operating system does know the pen: this module reads the pen events in the native
// layer, before the web engine gets them, and calls window.__drawPen(pressure, eraser) in the
// page. The script is sent before the engine forwards the same event, so the page already
// has the pressure when its pointer event arrives. __drawPen(null) means "no pen now".
//
// WebView2 (Windows) is Chromium and reports pens itself, so it needs nothing here.

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn script(pen: Option<(f64, bool)>) -> String {
    match pen {
        Some((p, eraser)) => format!("window.__drawPen&&__drawPen({:.4},{eraser})", p.clamp(0.0, 1.0)),
        None => "window.__drawPen&&__drawPen(null,false)".to_string(),
    }
}

#[cfg(target_os = "linux")]
pub fn attach(webview: webkit2gtk::WebView) {
    use gtk::{gdk, glib, prelude::*};
    use std::{cell::Cell, rc::Rc};
    use webkit2gtk::WebViewExt;

    let pen_active = Rc::new(Cell::new(false));
    let on_event = Rc::new(move |wv: &webkit2gtk::WebView, ev: &gdk::Event| {
        let pen = match ev.source_device().map(|d| d.source()) {
            Some(gdk::InputSource::Pen) => Some(false),
            Some(gdk::InputSource::Eraser) => Some(true),
            _ => None,
        };
        let js = match pen {
            Some(eraser) => {
                pen_active.set(true);
                // No pressure axis (rare): treat the pen as pressed fully.
                script(Some((ev.axis(gdk::AxisUse::Pressure).unwrap_or(1.0), eraser)))
            }
            // The first non-pen event after the pen: tell the page once, then stay quiet.
            None if pen_active.replace(false) => script(None),
            None => return,
        };
        wv.evaluate_javascript(&js, None, None, None::<&gtk::gio::Cancellable>, |_| {});
    });

    // Connected handlers run before WebKitWebView's own handler (the signals are RUN_LAST).
    let f = on_event.clone();
    webview.connect_motion_notify_event(move |wv, ev| {
        f(wv, ev);
        glib::Propagation::Proceed
    });
    let f = on_event.clone();
    webview.connect_button_press_event(move |wv, ev| {
        f(wv, ev);
        glib::Propagation::Proceed
    });
    webview.connect_button_release_event(move |wv, ev| {
        on_event(wv, ev);
        glib::Propagation::Proceed
    });
}

#[cfg(target_os = "macos")]
pub fn attach(webview: *mut std::ffi::c_void) {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventSubtype, NSEventType, NSPointingDeviceType};
    use objc2_foundation::NSString;
    use objc2_web_kit::WKWebView;
    use std::{cell::Cell, ptr::NonNull};

    let Some(wk) = (unsafe { Retained::retain(webview.cast::<WKWebView>()) }) else {
        return;
    };
    let eval = move |js: String| unsafe { wk.evaluateJavaScript_completionHandler(&NSString::from_str(&js), None) };
    let pen_active = Cell::new(false);
    let eraser = Cell::new(false);

    // A local monitor sees each event of this app before AppKit sends it to the WKWebView.
    let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let ev = unsafe { event.as_ref() };
        let ty = ev.r#type();
        if ty == NSEventType::TabletProximity {
            // Which end of the pen comes near: the tip or the eraser.
            if ev.isEnteringProximity() {
                eraser.set(ev.pointingDeviceType() == NSPointingDeviceType::Eraser);
            } else if pen_active.replace(false) {
                eval(script(None));
            }
            return event.as_ptr();
        }
        let mouse = ty == NSEventType::LeftMouseDown
            || ty == NSEventType::LeftMouseUp
            || ty == NSEventType::LeftMouseDragged
            || ty == NSEventType::MouseMoved;
        // Tablets send mouse events with the "tablet point" subtype, which carry the pressure.
        if ty == NSEventType::TabletPoint || (mouse && ev.subtype() == NSEventSubtype::TabletPoint) {
            pen_active.set(true);
            eval(script(Some((f64::from(ev.pressure()), eraser.get()))));
        } else if mouse && pen_active.replace(false) {
            eval(script(None));
        }
        event.as_ptr()
    });
    let mask = NSEventMask::LeftMouseDown
        | NSEventMask::LeftMouseUp
        | NSEventMask::LeftMouseDragged
        | NSEventMask::MouseMoved
        | NSEventMask::TabletPoint
        | NSEventMask::TabletProximity;
    // The monitor lives as long as the app.
    std::mem::forget(unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &handler) });
}
