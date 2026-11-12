//! Thin desktop shell. The GraphCode runtime is an independent Node.js process: the shell
//! finds a running one through its connection file, or spawns one detached so that closing
//! or reloading the window never stops agent runs.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConnectionInfo {
    url: String,
    token: String,
    pid: u32,
    started_at: String,
    version: String,
}

fn data_dir() -> PathBuf {
    if let Ok(h) = std::env::var("GRAPHCODE_HOME") {
        return PathBuf::from(h);
    }
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".graphcode")
}

fn read_info() -> Option<ConnectionInfo> {
    let raw = std::fs::read_to_string(data_dir().join("runtime.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn port_open(url: &str) -> bool {
    // url: ws://127.0.0.1:PORT/rpc
    let addr = url.trim_start_matches("ws://").split('/').next().unwrap_or("");
    addr.parse().ok().map_or(false, |a| std::net::TcpStream::connect_timeout(&a, Duration::from_millis(300)).is_ok())
}

fn spawn_runtime() -> Result<(), String> {
    // GRAPHCODE_RUNTIME may point at a bundled runtime.mjs; otherwise use the workspace sources.
    let mut cmd = if let Ok(entry) = std::env::var("GRAPHCODE_RUNTIME") {
        let mut c = Command::new("node");
        c.arg(entry);
        c
    } else {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut c = Command::new("pnpm");
        c.arg("--dir").arg(root).arg("runtime");
        c
    };
    let log = std::fs::File::create(data_dir().join("runtime.log")).map_err(|e| e.to_string())?;
    cmd.stdin(Stdio::null()).stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // survive the window process
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("Could not start the GraphCode runtime: {e}"))
}

#[tauri::command]
fn runtime_connection() -> Result<ConnectionInfo, String> {
    if let Some(info) = read_info() {
        if port_open(&info.url) {
            return Ok(info);
        }
    }
    std::fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    spawn_runtime()?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        if let Some(info) = read_info() {
            if port_open(&info.url) {
                return Ok(info);
            }
        }
    }
    Err(format!("The runtime did not start; see {}", data_dir().join("runtime.log").display()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![runtime_connection])
        .run(tauri::generate_context!())
        .expect("error while running GraphCode");
}
