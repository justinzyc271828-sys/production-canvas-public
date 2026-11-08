use std::{
    env,
    error::Error,
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub type Result<T> = std::result::Result<T, Box<dyn Error>>;
pub type Messages = mpsc::Receiver<Value>;

#[derive(Clone)]
pub struct Pipe(Arc<Mutex<ChildStdin>>);

impl Pipe {
    pub fn send(&self, value: Value) -> io::Result<()> {
        let mut input = self
            .0
            .lock()
            .map_err(|error| io::Error::other(error.to_string()))?;
        let mut line = serde_json::to_vec(&value)?;
        line.push(b'\n');
        input.write_all(&line)
    }

    pub fn reply(&self, id: &str, result: std::result::Result<Value, String>) {
        let message = match result {
            Ok(value) => json!({ "type": "reply", "id": id, "value": value }),
            Err(error) => json!({ "type": "reply", "id": id, "error": error }),
        };
        let _ = self.send(message);
    }
}

pub struct Backend {
    child: Child,
    pub pipe: Pipe,
}

fn bundled_tools() -> Result<PathBuf> {
    let exe = env::current_exe()?;
    let package = exe
        .parent()
        .and_then(Path::parent)
        .ok_or("Invalid executable path")?;
    Ok(package.join("runtime"))
}

fn node_executable(bundled: &Path) -> Result<PathBuf> {
    let portable = bundled.join("node/node.exe");
    if portable.is_file() {
        return Ok(portable);
    }
    if let Some(path) = env::var_os("CANVAS_NODE").map(PathBuf::from) {
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
        return Err("CANVAS_NODE must identify an existing absolute Node.js executable".into());
    }
    let installed = env::var_os("ProgramFiles")
        .map(|directory| PathBuf::from(directory).join("nodejs/node.exe"));
    if let Some(path) = installed.filter(|path| path.is_file()) {
        return Ok(path);
    }
    let path = env::var_os("PATH").unwrap_or_default();
    env::split_paths(&path)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join("node.exe"))
        .find(|file| file.is_file())
        .ok_or_else(|| {
            "Node.js was not found. Extract the complete Production Canvas package.".into()
        })
}

fn command(
    profile: &Path,
    runtime: &Path,
    initial: Option<&Path>,
    language: &str,
) -> Result<Command> {
    let entry = runtime.join("app/tauri-host.cjs");
    if !entry.is_file() {
        return Err(format!("Review runtime is missing: {}", entry.display()).into());
    }
    let bundled = bundled_tools()?;
    let mut command = Command::new(node_executable(&bundled)?);
    command
        .arg(entry)
        .current_dir(runtime)
        .env("CANVAS_PROFILE", profile)
        .env("CANVAS_LANGUAGE", language)
        .env("CANVAS_HOST_PID", std::process::id().to_string())
        .env_remove("CANVAS_OPEN_FILE")
        .env_remove("CANVAS_BUNDLED_PYTHON")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    if let Some(file) = initial {
        command.env("CANVAS_OPEN_FILE", file);
    }
    let python = bundled.join("python/python.exe");
    if python.is_file() {
        command.env("CANVAS_BUNDLED_PYTHON", python);
    }
    Ok(command)
}

impl Backend {
    pub fn forward(
        profile: &Path,
        runtime: &Path,
        initial: Option<&Path>,
        language: &str,
    ) -> Result<()> {
        let result = command(profile, runtime, initial, language)?
            .arg("--dispatch")
            .output()?;
        if !result.status.success() {
            return Err(String::from_utf8_lossy(&result.stderr)
                .trim()
                .to_owned()
                .into());
        }
        Ok(())
    }

    pub fn spawn(
        profile: &Path,
        runtime: &Path,
        initial: Option<&Path>,
        language: &str,
    ) -> Result<(Self, Value, Messages)> {
        let log = profile.join("tauri-backend.log");
        let mut child = command(profile, runtime, initial, language)?
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(File::create(&log)?)
            .spawn()?;
        let stdout = child.stdout.take().expect("piped backend stdout");
        let pipe = Pipe(Arc::new(Mutex::new(
            child.stdin.take().expect("piped backend stdin"),
        )));
        let backend = Self { child, pipe };
        let (send, messages) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout)
                .lines()
                .map_while(std::result::Result::ok)
            {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    break;
                };
                if send.send(value).is_err() {
                    break;
                }
            }
        });
        let ready = messages
            .recv_timeout(Duration::from_secs(15))
            .map_err(|error| {
                format!(
                    "Unable to start the review service ({error}). See {}",
                    log.display()
                )
            })?;
        if ready["type"] != "ready" {
            return Err(
                format!("Unable to start the review service. See {}", log.display()).into(),
            );
        }
        Ok((backend, ready, messages))
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.pipe.send(json!({ "type": "shutdown" }));
        let deadline = Instant::now() + Duration::from_millis(600);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(15));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn hash_file(file: &Path) -> io::Result<Value> {
    let mut reader = fs::File::open(file)?;
    let mut buffer = vec![0; 1024 * 1024];
    let mut hash = Sha256::new();
    loop {
        let length = reader.read(&mut buffer)?;
        if length == 0 {
            return Ok(Value::String(format!("{:x}", hash.finalize())));
        }
        hash.update(&buffer[..length]);
    }
}
