use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use tauri::{
    LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
};
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_STATE_DENY, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL, ICoreWebView2, ICoreWebView2_22,
        ICoreWebView2Environment,
    },
    PermissionRequestedEventHandler, WebMessageReceivedEventHandler,
    WebResourceRequestedEventHandler, take_pwstr,
};
use windows::{
    Win32::System::Com::IStream,
    core::{HSTRING, Interface, PWSTR},
};

use crate::{
    backend::{Pipe, Result},
    webview,
};

fn comfy_size(review: &WebviewWindow) -> tauri::Result<LogicalSize<f64>> {
    let size = review
        .inner_size()?
        .to_logical::<f64>(review.scale_factor()?);
    Ok(LogicalSize::new(size.width, (size.height - 84.0).max(1.0)))
}

pub fn resize_with_review(review: &WebviewWindow) {
    let parent = review.clone();
    review.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            if let Ok(size) = comfy_size(&parent) {
                for view in parent.as_ref().window().webviews() {
                    if view.label().starts_with("comfy-") {
                        let _ = view.set_size(size);
                    }
                }
            }
        }
    });
}

fn restrict_comfy(
    core: &ICoreWebView2,
    environment: ICoreWebView2Environment,
    url: &Url,
    review: WebviewWindow,
) -> windows::core::Result<()> {
    let allowed = url.origin().ascii_serialization();
    let http = format!("{allowed}/");
    let ws = http.replacen("http:", "ws:", 1);
    let filter = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        unsafe {
            let request = args.Request()?;
            let (mut uri, mut method) = (PWSTR::null(), PWSTR::null());
            request.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            request.Method(&mut method)?;
            let method = take_pwstr(method);
            if !(uri.starts_with(&http) || uri.starts_with(&ws))
                || !matches!(method.as_str(), "GET" | "HEAD")
            {
                let response = environment.CreateWebResourceResponse(
                    None::<&IStream>,
                    403,
                    &HSTRING::from("Read only"),
                    &HSTRING::from("Content-Length: 0\r\n"),
                )?;
                args.SetResponse(&response)?;
            }
        }
        Ok(())
    }));
    let permission = PermissionRequestedEventHandler::create(Box::new(|_, args| {
        if let Some(args) = args {
            unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)? };
        }
        Ok(())
    }));
    let receive = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        unsafe {
            let mut source = PWSTR::null();
            args.Source(&mut source)?;
            let source = take_pwstr(source);
            if !Url::parse(&source).is_ok_and(|url| url.origin().ascii_serialization() == allowed) {
                return Ok(());
            }
            let mut data = PWSTR::null();
            args.WebMessageAsJson(&mut data)?;
            if let Ok(message) = serde_json::from_str::<Value>(&take_pwstr(data)) {
                if message["returnReview"] == true {
                    let _ = review.eval("document.querySelector('#return-review').click()");
                }
            }
        }
        Ok(())
    }));
    unsafe {
        let all_sources = core.cast::<ICoreWebView2_22>()?;
        all_sources.AddWebResourceRequestedFilterWithRequestSourceKinds(
            &HSTRING::from("*"),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
        )?;
        core.add_WebResourceRequested(&filter, &mut 0)?;
        core.add_PermissionRequested(&permission, &mut 0)?;
        core.add_WebMessageReceived(&receive, &mut 0)?;
    }
    Ok(())
}

fn wait_for_inspection(
    view: &Webview,
    query: &str,
    started: mpsc::Receiver<String>,
) -> std::result::Result<Value, String> {
    if started.recv_timeout(Duration::from_secs(10)).as_deref() != Ok("true") {
        return Err("The ComfyUI view did not start inspection code".to_owned());
    }
    let deadline = Instant::now() + Duration::from_secs(70);
    while Instant::now() < deadline {
        let (send, response) = mpsc::channel();
        view.eval_with_callback(query, move |value| {
            let _ = send.send(value);
        })
        .map_err(|error| error.to_string())?;
        let budget = deadline.saturating_duration_since(Instant::now());
        let Ok(json) = response.recv_timeout(budget.min(Duration::from_secs(10))) else {
            continue;
        };
        let result = serde_json::from_str::<Value>(&json).map_err(|error| error.to_string())?;
        if let Some(error) = result["error"].as_str() {
            return Err(error.to_owned());
        }
        if let Some(value) = result.get("value") {
            return Ok(value.clone());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("ComfyUI workspace inspection did not complete".to_owned())
}
pub struct Surfaces {
    review: WebviewWindow,
    pipe: Pipe,
    profile: PathBuf,
    origin: Url,
    token: String,
    chinese: bool,
    comfy: Option<Webview>,
    storyboard_serial: u32,
}

impl Surfaces {
    pub fn new(
        review: WebviewWindow,
        pipe: Pipe,
        profile: PathBuf,
        origin: Url,
        token: String,
        chinese: bool,
    ) -> Self {
        Self {
            review,
            pipe,
            profile,
            origin,
            token,
            chinese,
            comfy: None,
            storyboard_serial: 0,
        }
    }

    pub fn open_comfy(&mut self, id: &str, address: &str) -> Result<()> {
        let target = Url::parse(address)?;
        if target.scheme() != "http"
            || target.host_str() != Some("127.0.0.1")
            || target.port().is_none()
            || !target.username().is_empty()
            || target.password().is_some()
            || target.path() != "/"
            || target.query().is_some()
            || target.fragment().is_some()
        {
            return Err("ComfyUI inspection requires a local loopback address".into());
        }
        self.close_comfy()?;
        let page_origin = target.origin();
        let navigation_origin = page_origin.clone();
        let ready = Arc::new(AtomicBool::new(false));
        let (page_pipe, page_id) = (self.pipe.clone(), id.to_owned());
        let builder = WebviewBuilder::new(format!("comfy-{id}"), WebviewUrl::External(Url::parse("about:blank")?))
            .data_directory(self.profile.join("comfy-webview2"))
            .on_navigation(move |url| url.as_str() == "about:blank" || url.origin() == navigation_origin)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .initialization_script(
                "document.addEventListener('keydown', event => { if (event.ctrlKey && event.key === '1') { event.preventDefault(); event.stopImmediatePropagation(); window.chrome.webview.postMessage({returnReview:true}); } }, true);"
            )
            .on_page_load(move |_, event| {
                if event.event() == PageLoadEvent::Finished && event.url().origin() == page_origin
                    && !ready.swap(true, Ordering::AcqRel)
                {
                    page_pipe.reply(&page_id, Ok(Value::Null));
                }
            });
        let view = self.review.as_ref().window().add_child(
            builder,
            LogicalPosition::new(0.0, 84.0),
            comfy_size(&self.review)?,
        )?;
        view.hide()?;
        let (reply, request, review) = (self.pipe.clone(), id.to_owned(), self.review.clone());
        view.with_webview(move |native| {
            let result = unsafe { native.controller().CoreWebView2() }.and_then(|core| {
                restrict_comfy(&core, native.environment(), &target, review)?;
                unsafe { core.Navigate(&HSTRING::from(target.as_str())) }
            });
            if let Err(error) = result {
                reply.reply(&request, Err(error.to_string()));
            }
        })?;
        self.comfy = Some(view);
        Ok(())
    }

    pub fn evaluate_comfy(&self, id: &str, source: &str) -> Result<()> {
        let view = self
            .comfy
            .as_ref()
            .ok_or("ComfyUI inspection is closed")?
            .clone();
        let key = json!(format!("__canvasInspection_{id}"));
        let script = format!(
            r#"(() => {{
            void (async () => {{
                try {{
                    const value = await ({source});
                    globalThis[{key}] = {{ value: value ?? null }};
                }} catch (error) {{
                    globalThis[{key}] = {{ error: error.message || String(error) }};
                }}
            }})();
            return true;
        }})()"#
        );
        let (acknowledge, started) = mpsc::channel();
        view.eval_with_callback(script, move |response| {
            let _ = acknowledge.send(response);
        })?;
        let query = format!("globalThis[{key}] ?? null");
        let clear = format!("delete globalThis[{key}]");
        let (pipe, id) = (self.pipe.clone(), id.to_owned());
        thread::spawn(move || {
            let result = wait_for_inspection(&view, &query, started);
            let _ = view.eval(clear);
            pipe.reply(&id, result);
        });
        Ok(())
    }
    pub fn show_comfy(&self, visible: bool) -> Result<()> {
        if let Some(view) = &self.comfy {
            if visible {
                view.show()?;
                view.set_focus()?;
            } else {
                view.hide()?;
                self.review.as_ref().set_focus()?;
            }
        }
        Ok(())
    }

    pub fn close_comfy(&mut self) -> Result<()> {
        if let Some(view) = self.comfy.take() {
            view.close()?;
        }
        Ok(())
    }

    pub fn open_storyboard(&mut self, address: &str) -> Result<()> {
        let url = Url::parse(address)?;
        if url.origin() != self.origin.origin()
            || !url.path().starts_with("/api/canvas/projects/")
            || !url.path().ends_with("/media/storyboard")
            || url.query().is_some()
        {
            return Err("Invalid project storyboard address".into());
        }
        self.storyboard_serial += 1;
        let label = format!("storyboard-{}", self.storyboard_serial);
        let allow = url.clone();
        let expected = url.origin();
        let reader = WebviewWindowBuilder::new(
            self.review.app_handle(),
            label,
            WebviewUrl::External(Url::parse("about:blank")?),
        )
        .title(if self.chinese {
            "项目分镜"
        } else {
            "Project storyboard"
        })
        .inner_size(850.0, 680.0)
        .data_directory(self.profile.join("webview2"))
        .visible(false)
        .on_navigation(move |target| target.as_str() == "about:blank" || *target == allow)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_page_load(move |window, event| {
            if event.event() == PageLoadEvent::Finished && event.url().origin() == expected {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .build()?;
        let origin = self.origin.origin().ascii_serialization();
        let token = self.token.clone();
        let failed = reader.clone();
        reader.with_webview(move |native| {
            if unsafe { native.controller().CoreWebView2() }
                .and_then(|core| webview::authorize_and_open(&core, &origin, &token, url.as_str()))
                .is_err()
            {
                let _ = failed.close();
            }
        })?;
        Ok(())
    }
}
