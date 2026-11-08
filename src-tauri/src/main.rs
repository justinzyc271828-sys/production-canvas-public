#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod surfaces;
mod webview;

use std::{
    env,
    fs::{self, OpenOptions},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

use backend::{Backend, Messages, Pipe, Result};
use rfd::{FileDialog, MessageDialog, MessageLevel};
use serde_json::{Value, json};
use surfaces::Surfaces;
use tauri::{
    Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
    menu::{Menu, MenuItem, Submenu},
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
};

#[derive(Clone, Copy)]
struct Language {
    chinese: bool,
}

impl Language {
    fn text(self, english: &'static str, chinese: &'static str) -> &'static str {
        if self.chinese { chinese } else { english }
    }

    fn code(self) -> &'static str {
        self.text("en", "zh-CN")
    }

    fn title(self) -> &'static str {
        self.text("Production Canvas 1.6", "制作画布 · 1.6")
    }
}

fn show_error(language: Language, message: &str) {
    MessageDialog::new()
        .set_level(MessageLevel::Error)
        .set_title(language.title())
        .set_description(message)
        .show();
}

fn send_menu(
    window: &WebviewWindow,
    pipe: &Pipe,
    busy: &Arc<AtomicBool>,
    language: Language,
    id: &str,
) {
    match id {
        "manifest" | "video" | "folder" => {
            if busy.swap(true, Ordering::AcqRel) {
                return;
            }
            let kind = id.to_owned();
            let window = window.clone();
            let pipe = pipe.clone();
            let busy = busy.clone();
            thread::spawn(move || {
                let dialog = FileDialog::new().set_parent(&window);
                let file = match kind.as_str() {
                    "video" => dialog
                        .add_filter(language.text("Review video", "审片视频"), &["mp4"])
                        .pick_file(),
                    "folder" => dialog.pick_folder(),
                    _ => dialog
                        .add_filter(language.text("Project manifest", "项目清单"), &["json"])
                        .pick_file(),
                };
                busy.store(false, Ordering::Release);
                if let Some(file) = file {
                    let _ = pipe.send(json!({ "type": kind, "file": file }));
                }
            });
        }
        "demo" | "reload" => {
            let _ = pipe.send(json!({ "type": id }));
        }
        "fullscreen" => {
            let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
        }
        "quit" => {
            let _ = window.close();
        }
        _ => {}
    }
}

fn handle_requests(
    messages: Messages,
    window: WebviewWindow,
    pipe: Pipe,
    menu: Submenu<Wry>,
    language: Language,
    hidden: bool,
    mut surfaces: Surfaces,
) {
    thread::spawn(move || {
        for message in messages {
            let id = message["id"].as_str().unwrap_or_default();
            let source = message["script"].as_str().unwrap_or_default();
            let address = message["url"].as_str().unwrap_or_default();
            let result = match message["type"].as_str() {
                Some("hash") => {
                    let pipe = pipe.clone();
                    let id = id.to_owned();
                    let file = message["file"].as_str().map(PathBuf::from);
                    tauri::async_runtime::spawn_blocking(move || {
                        let result = file
                            .filter(|file| file.is_absolute())
                            .ok_or_else(|| "Expected an absolute video path".to_owned())
                            .and_then(|file| {
                                backend::hash_file(&file).map_err(|error| error.to_string())
                            });
                        pipe.reply(&id, result);
                    });
                    continue;
                }
                Some("evaluate") => {
                    if let Err(error) = webview::evaluate(&window, id, source) {
                        pipe.reply(id, Err(error.to_string()));
                    }
                    continue;
                }
                Some("capture") => {
                    webview::capture(&window, &pipe, id);
                    continue;
                }
                Some("comfy-open") => match surfaces.open_comfy(id, address) {
                    Ok(()) => continue,
                    Err(error) => Err(error),
                },
                Some("comfy-evaluate") => match surfaces.evaluate_comfy(id, source) {
                    Ok(()) => continue,
                    Err(error) => Err(error),
                },
                Some("comfy-show") => surfaces.show_comfy(true),
                Some("comfy-hide") => surfaces.show_comfy(false),
                Some("comfy-close") => surfaces.close_comfy(),
                Some("storyboard") => surfaces.open_storyboard(address),
                Some("menu") => {
                    let _ = window.popup_menu(&menu);
                    continue;
                }
                Some("reload") => {
                    let _ = window.eval("location.reload()");
                    continue;
                }
                Some("show") if !hidden => {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    continue;
                }
                Some("error") if !hidden => {
                    let error = message["message"]
                        .as_str()
                        .unwrap_or("Unable to open project")
                        .to_owned();
                    thread::spawn(move || show_error(language, &error));
                    continue;
                }
                _ => continue,
            };
            pipe.reply(
                id,
                result
                    .map(|()| Value::Null)
                    .map_err(|error| error.to_string()),
            );
        }
    });
}

fn required_string<'a>(message: &'a Value, key: &str) -> Result<&'a str> {
    message[key]
        .as_str()
        .ok_or_else(|| format!("Review service field missing: {key}").into())
}

fn absolute(path: PathBuf) -> Result<PathBuf> {
    Ok(if path.is_absolute() {
        path
    } else {
        env::current_dir()?.join(path)
    })
}

fn editable(url: &Url) -> bool {
    url.path().starts_with("/api/canvas/projects/") && url.path().ends_with("/media/editable")
}

fn run(language: Language, hidden: bool) -> Result<()> {
    let mut profile = None;
    let mut runtime = None;
    let mut initial = None;
    for argument in env::args_os().skip(1) {
        let value = argument.to_string_lossy();
        if let Some(path) = value.strip_prefix("--profile=") {
            profile = Some(absolute(PathBuf::from(path))?);
        } else if let Some(path) = value.strip_prefix("--runtime=") {
            runtime = Some(absolute(PathBuf::from(path))?);
        } else if value == "--hidden"
            || matches!(value.as_ref(), "--language=zh-CN" | "--language=en")
        {
            continue;
        } else if value.starts_with('-') || initial.is_some() {
            return Err(language
                .text(
                    "Choose one project manifest or MP4",
                    "一次只能打开一个项目清单或 MP4 视频",
                )
                .into());
        } else {
            initial = Some(absolute(PathBuf::from(argument))?);
        }
    }
    let profile = match profile {
        Some(profile) => profile,
        None => PathBuf::from(env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is missing")?)
            .join(language.text("ProductionCanvasTauriEnglish", "ProductionCanvasTauri")),
    };
    let runtime = match runtime {
        Some(runtime) => runtime,
        None => env::current_exe()?
            .parent()
            .ok_or("Invalid executable path")?
            .join("runtime"),
    };
    fs::create_dir_all(&profile)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(profile.join("instance.lock"))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(fs::TryLockError::WouldBlock) => {
            return Backend::forward(&profile, &runtime, initial.as_deref(), language.code());
        }
        Err(error) => return Err(error.into()),
    }

    let (backend, ready, messages) =
        Backend::spawn(&profile, &runtime, initial.as_deref(), language.code())?;
    let origin = required_string(&ready, "origin")?.to_owned();
    let expected = Url::parse(&origin)?;
    let token = required_string(&ready, "token")?.to_owned();
    let page = required_string(&ready, "url")?.to_owned();
    let page_origin = expected.origin();
    let navigation_origin = page_origin.clone();
    let download_origin = page_origin.clone();
    let pipe = backend.pipe.clone();
    let page_pipe = pipe.clone();

    let app = tauri::Builder::default()
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(
                app,
                "review",
                WebviewUrl::External(Url::parse("about:blank")?),
            )
            .title(language.title())
            .inner_size(1400.0, 930.0)
            .min_inner_size(390.0, 620.0)
            .data_directory(profile.join("webview2"))
            .background_color(tauri::window::Color(15, 15, 15, 255))
            .visible(false)
            .initialization_script("window.productionCanvasHost = 'tauri';")
            .on_navigation(move |url| {
                url.as_str() == "about:blank"
                    || (url.origin() == navigation_origin
                        && (url.path() == "/canvas/" || editable(url)))
            })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(move |_, event| match event {
                DownloadEvent::Requested { url, .. } => {
                    url.origin() == download_origin && editable(&url)
                }
                _ => true,
            })
            .on_page_load(move |window, payload| {
                if payload.event() == PageLoadEvent::Finished
                    && payload.url().origin() == page_origin
                    && payload.url().path() == "/canvas/"
                {
                    if !hidden {
                        let _ = window.show();
                    }
                    let _ = page_pipe.send(json!({ "type": "page-ready" }));
                }
            })
            .build()?;

            let open_manifest = MenuItem::with_id(
                app,
                "manifest",
                language.text(
                    "Open project manifest or local tool settings...",
                    "打开项目清单或本地工具配置…",
                ),
                true,
                None::<&str>,
            )?;
            let open_video = MenuItem::with_id(
                app,
                "video",
                language.text("Open review video...", "打开审片视频…"),
                true,
                None::<&str>,
            )?;
            let open_folder = MenuItem::with_id(
                app,
                "folder",
                language.text("Open local film folder...", "接入本地影片目录…"),
                true,
                None::<&str>,
            )?;
            let open_demo = MenuItem::with_id(
                app,
                "demo",
                language.text("Open sample", "打开示例"),
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(
                app,
                "quit",
                language.text("Quit", "退出"),
                true,
                None::<&str>,
            )?;
            let reload = MenuItem::with_id(
                app,
                "reload",
                language.text("Reload canvas", "刷新画布"),
                true,
                None::<&str>,
            )?;
            let fullscreen = MenuItem::with_id(
                app,
                "fullscreen",
                language.text("Fullscreen", "全屏窗口"),
                true,
                None::<&str>,
            )?;
            let project = Submenu::with_items(
                app,
                language.text("Project", "项目"),
                true,
                &[&open_manifest, &open_video, &open_folder, &open_demo, &quit],
            )?;
            let view = Submenu::with_items(
                app,
                language.text("View", "视图"),
                true,
                &[&reload, &fullscreen],
            )?;
            window.set_menu(Menu::with_items(app, &[&project, &view])?)?;
            let busy = Arc::new(AtomicBool::new(false));
            let (menu_window, menu_pipe) = (window.clone(), pipe.clone());
            window.on_menu_event(move |_, event| {
                send_menu(
                    &menu_window,
                    &menu_pipe,
                    &busy,
                    language,
                    event.id().as_ref(),
                )
            });
            surfaces::resize_with_review(&window);
            let surfaces = Surfaces::new(
                window.clone(),
                pipe.clone(),
                profile,
                expected,
                token.clone(),
                language.chinese,
            );

            let handle = app.handle().clone();
            window.with_webview(move |native| {
                let result = unsafe { native.controller().CoreWebView2() }
                    .and_then(|core| webview::authorize_and_open(&core, &origin, &token, &page));
                if let Err(error) = result {
                    if !hidden {
                        show_error(language, &format!("WebView2: {error}"));
                    }
                    handle.exit(1);
                }
            })?;

            handle_requests(messages, window, pipe, project, language, hidden, surfaces);
            app.manage(Mutex::new(Some(backend)));
            Ok(())
        })
        .build(tauri::generate_context!())?;
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app.try_state::<Mutex<Option<Backend>>>() {
                drop(state.lock().unwrap().take());
            }
        }
    });
    Ok(())
}

fn main() {
    let language = Language {
        chinese: !env::args().any(|argument| argument == "--language=en"),
    };
    let hidden = env::args().any(|argument| argument == "--hidden");
    if let Err(error) = run(language, hidden) {
        if !hidden {
            show_error(language, &error.to_string());
        }
        eprintln!("{error}");
        std::process::exit(1);
    }
}
