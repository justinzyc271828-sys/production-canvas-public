use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use tauri::WebviewWindow;
use webview2_com::{
    CapturePreviewCompletedHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        ICoreWebView2,
    },
    WebResourceRequestedEventHandler, take_pwstr,
};
use windows::{
    Win32::{
        Foundation::HGLOBAL,
        System::Com::{IStream, STREAM_SEEK_SET, StructuredStorage::CreateStreamOnHGlobal},
    },
    core::{HSTRING, PWSTR},
};

use crate::backend::Pipe;

pub fn authorize_and_open(
    core: &ICoreWebView2,
    origin: &str,
    token: &str,
    page: &str,
) -> windows::core::Result<()> {
    let prefix = format!("{origin}/");
    let filter = HSTRING::from(format!("{prefix}*"));
    let header = HSTRING::from("X-Canvas-Desktop");
    let value = HSTRING::from(token);
    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        // WebView2 invokes this callback on the owning UI thread.
        unsafe {
            let request = args.Request()?;
            let mut uri = PWSTR::null();
            request.Uri(&mut uri)?;
            if take_pwstr(uri).starts_with(&prefix) {
                request.Headers()?.SetHeader(&header, &value)?;
            }
        }
        Ok(())
    }));
    unsafe {
        core.AddWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?;
        core.add_WebResourceRequested(&handler, &mut 0)?;
        core.Navigate(&HSTRING::from(page))
    }
}

pub fn evaluate(window: &WebviewWindow, id: &str, source: &str) -> tauri::Result<()> {
    let id = json!(id);
    window.eval(format!(
        r#"(async () => {{
            const reply = {{ id: {id} }};
            try {{ reply.value = await ({source}); }}
            catch (error) {{ reply.error = error.message || String(error); }}
            await fetch('/desktop/host-result', {{
                method: 'POST',
                headers: {{ 'Content-Type': 'application/json' }},
                body: JSON.stringify(reply)
            }});
        }})()"#,
    ))
}

fn read_capture(stream: &IStream) -> windows::core::Result<Value> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    unsafe {
        stream.Seek(0, STREAM_SEEK_SET, None)?;
        loop {
            let mut read = 0;
            stream
                .Read(
                    chunk.as_mut_ptr().cast(),
                    chunk.len() as u32,
                    Some(&mut read),
                )
                .ok()?;
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..read as usize]);
        }
    }
    Ok(Value::String(STANDARD.encode(bytes)))
}

fn capture_core(core: ICoreWebView2, pipe: Pipe, id: String) -> windows::core::Result<()> {
    unsafe {
        let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
        let captured = stream.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |status| {
            let result = status
                .and_then(|()| read_capture(&captured))
                .map_err(|error| error.to_string());
            pipe.reply(&id, result);
            Ok(())
        }));
        core.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
    }
}

pub fn capture(window: &WebviewWindow, pipe: &Pipe, id: &str) {
    let (callback_pipe, callback_id) = (pipe.clone(), id.to_owned());
    let result = window.with_webview(move |native| {
        let started = unsafe { native.controller().CoreWebView2() }
            .and_then(|core| capture_core(core, callback_pipe.clone(), callback_id.clone()));
        if let Err(error) = started {
            callback_pipe.reply(&callback_id, Err(error.to_string()));
        }
    });
    if let Err(error) = result {
        pipe.reply(id, Err(error.to_string()));
    }
}
