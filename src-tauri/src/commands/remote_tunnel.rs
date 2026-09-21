// remote-tunnel.* — client-side SSH port forwards for remote profiles.
//
// A remote profile may name an SSH target (an alias from ~/.ssh/config or
// user@host). The bat-server on that machine only listens on its loopback,
// so before dialing we spawn `ssh -N -L 127.0.0.1:<free>:<host>:<port>
// <target>` on this machine and dial the forwarded local port instead. One
// tunnel per profile is shared by every window viewing it; a window
// registers itself as an owner on each ensure() and the reaper kills tunnels
// whose owner windows have all gone away.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State, WebviewWindow};

const LOG_LINES: usize = 40;
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);
const LISTEN_WAIT: Duration = Duration::from_secs(15);
const LISTEN_POLL: Duration = Duration::from_millis(250);
const REAPER_INTERVAL: Duration = Duration::from_secs(5);

struct Tunnel {
    child: Child,
    local_port: u16,
    log: Arc<Mutex<VecDeque<String>>>,
    owners: HashSet<String>,
    started_at: Instant,
}

#[derive(Clone, Default)]
pub struct RemoteTunnelState {
    inner: Arc<Mutex<HashMap<String, Tunnel>>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTunnelSpec {
    /// Saved profile to read the SSH target and host address from.
    pub profile_id: Option<String>,
    /// Ad-hoc spec (profile editor before the profile is saved).
    pub ssh_target: Option<String>,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTunnelEndpoint {
    pub ready: bool,
    pub tunneled: bool,
    pub host: String,
    pub port: u16,
    pub spawned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

fn direct(host: String, port: u16) -> RemoteTunnelEndpoint {
    RemoteTunnelEndpoint {
        ready: true,
        tunneled: false,
        host,
        port,
        spawned: false,
        error: None,
        output: None,
    }
}

fn port_is_listening(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok()
}

fn free_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|err| format!("could not reserve a local port: {err}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| format!("could not read reserved port: {err}"))
}

pub fn ssh_forward_args(local_port: u16, remote_host: &str, remote_port: u16, target: &str) -> Vec<String> {
    vec![
        "-T".into(),
        "-N".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        "-o".into(),
        "ServerAliveInterval=30".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
        "-L".into(),
        format!("127.0.0.1:{local_port}:{remote_host}:{remote_port}"),
        target.to_string(),
    ]
}

fn push_log(log: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if let Ok(mut buf) = log.lock() {
        if buf.len() >= LOG_LINES {
            buf.pop_front();
        }
        buf.push_back(line);
    }
}

fn log_text(log: &Arc<Mutex<VecDeque<String>>>) -> Option<String> {
    let buf = log.lock().ok()?;
    if buf.is_empty() {
        return None;
    }
    Some(buf.iter().cloned().collect::<Vec<_>>().join("\n"))
}

fn spawn_tunnel(
    app: &AppHandle,
    key: &str,
    target: &str,
    remote_host: &str,
    remote_port: u16,
) -> Result<Tunnel, String> {
    let local_port = free_local_port()?;
    let args = ssh_forward_args(local_port, remote_host, remote_port, target);
    let mut command = Command::new("ssh");
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::subprocess::hide_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("could not start ssh: {err}"))?;
    let log = Arc::new(Mutex::new(VecDeque::new()));
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let log = Arc::clone(&log);
        let app = app.clone();
        let key = key.to_string();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let trimmed = line.trim_end().to_string();
                if trimmed.is_empty() {
                    continue;
                }
                crate::commands::app::log_tauri(
                    &crate::host_context::HostContext::from_app(app.clone()),
                    &format!("[remote-tunnel:{key}] {trimmed}"),
                );
                push_log(&log, trimmed);
            }
        });
    }
    crate::commands::app::log_tauri(
        &crate::host_context::HostContext::from_app(app.clone()),
        &format!("[remote-tunnel:{key}] spawned ssh {} (pid {})", args.join(" "), child.id()),
    );
    Ok(Tunnel {
        child,
        local_port,
        log,
        owners: HashSet::new(),
        started_at: Instant::now(),
    })
}

fn tunnel_key(spec: &RemoteTunnelSpec, target: &str, host: &str, port: u16) -> String {
    match spec.profile_id.as_deref().filter(|id| !id.trim().is_empty()) {
        Some(id) => format!("profile:{id}"),
        None => format!("adhoc:{target}|{host}:{port}"),
    }
}

fn resolve_spec(app: &AppHandle, spec: &RemoteTunnelSpec) -> Result<(Option<String>, String, u16), String> {
    if let Some(profile_id) = spec.profile_id.as_deref().filter(|id| !id.trim().is_empty()) {
        let profile = crate::commands::profile::profile_get(app.clone(), profile_id.to_string())
            .ok_or_else(|| format!("profile {profile_id} not found"))?;
        let host = profile
            .remote_host
            .clone()
            .unwrap_or_else(|| "127.0.0.1".into());
        let port = profile
            .remote_port
            .and_then(|p| u16::try_from(p).ok())
            .unwrap_or(9876);
        let target = profile
            .ssh_target
            .clone()
            .filter(|value| !value.trim().is_empty());
        return Ok((target, host, port));
    }
    let host = spec
        .remote_host
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".into());
    let port = spec.remote_port.unwrap_or(9876);
    let target = spec
        .ssh_target
        .clone()
        .filter(|value| !value.trim().is_empty());
    Ok((target, host, port))
}

fn wait_for_listen(state: &RemoteTunnelState, key: &str) -> RemoteTunnelEndpoint {
    let deadline = Instant::now() + LISTEN_WAIT;
    loop {
        let (port, exited, output) = {
            let Ok(mut map) = state.inner.lock() else {
                return failed("tunnel state poisoned", None);
            };
            let Some(tunnel) = map.get_mut(key) else {
                return failed("tunnel was stopped while starting", None);
            };
            let exited = matches!(tunnel.child.try_wait(), Ok(Some(_)));
            (tunnel.local_port, exited, log_text(&tunnel.log))
        };
        if exited {
            // Give the reader threads a moment to drain the final lines.
            std::thread::sleep(Duration::from_millis(150));
            let output = state
                .inner
                .lock()
                .ok()
                .and_then(|map| map.get(key).and_then(|t| log_text(&t.log)))
                .or(output);
            if let Ok(mut map) = state.inner.lock() {
                map.remove(key);
            }
            return failed("ssh exited before the tunnel was ready", output);
        }
        if port_is_listening(port) {
            return RemoteTunnelEndpoint {
                ready: true,
                tunneled: true,
                host: "127.0.0.1".into(),
                port,
                spawned: true,
                error: None,
                output: None,
            };
        }
        if Instant::now() >= deadline {
            return failed("timed out waiting for the ssh tunnel to listen", output);
        }
        std::thread::sleep(LISTEN_POLL);
    }
}

fn failed(message: &str, output: Option<String>) -> RemoteTunnelEndpoint {
    RemoteTunnelEndpoint {
        ready: false,
        tunneled: true,
        host: "127.0.0.1".into(),
        port: 0,
        spawned: false,
        error: Some(message.to_string()),
        output,
    }
}

pub fn ensure_tunnel(
    app: &AppHandle,
    state: &RemoteTunnelState,
    owner_window: &str,
    spec: &RemoteTunnelSpec,
) -> RemoteTunnelEndpoint {
    let (target, host, port) = match resolve_spec(app, spec) {
        Ok(resolved) => resolved,
        Err(err) => return failed(&err, None),
    };
    let Some(target) = target else {
        return direct(host, port);
    };
    let key = tunnel_key(spec, &target, &host, port);

    // Reuse a live tunnel; drop a dead one so it is respawned below.
    let existing_port = {
        let Ok(mut map) = state.inner.lock() else {
            return failed("tunnel state poisoned", None);
        };
        match map.get_mut(&key) {
            Some(tunnel) => match tunnel.child.try_wait() {
                Ok(None) => {
                    tunnel.owners.insert(owner_window.to_string());
                    Some(tunnel.local_port)
                }
                _ => {
                    let age = tunnel.started_at.elapsed().as_secs();
                    crate::commands::app::log_tauri(
                        &crate::host_context::HostContext::from_app(app.clone()),
                        &format!("[remote-tunnel:{key}] ssh exited after {age}s; respawning"),
                    );
                    map.remove(&key);
                    None
                }
            },
            None => None,
        }
    };
    if let Some(port) = existing_port {
        if port_is_listening(port) {
            return RemoteTunnelEndpoint {
                ready: true,
                tunneled: true,
                host: "127.0.0.1".into(),
                port,
                spawned: false,
                error: None,
                output: None,
            };
        }
        // Spawned by another window moments ago and still coming up.
        return wait_for_listen(state, &key);
    }

    let mut tunnel = match spawn_tunnel(app, &key, &target, &host, port) {
        Ok(tunnel) => tunnel,
        Err(err) => return failed(&err, None),
    };
    tunnel.owners.insert(owner_window.to_string());
    if let Ok(mut map) = state.inner.lock() {
        map.insert(key.clone(), tunnel);
    }
    wait_for_listen(state, &key)
}

fn kill_tunnel(app: &AppHandle, key: &str, mut tunnel: Tunnel, reason: &str) {
    let _ = tunnel.child.kill();
    let _ = tunnel.child.wait();
    crate::commands::app::log_tauri(
        &crate::host_context::HostContext::from_app(app.clone()),
        &format!("[remote-tunnel:{key}] stopped ({reason})"),
    );
}

pub fn stop_tunnels_for_key(app: &AppHandle, state: &RemoteTunnelState, key: &str) -> bool {
    let removed = state.inner.lock().ok().and_then(|mut map| map.remove(key));
    match removed {
        Some(tunnel) => {
            kill_tunnel(app, key, tunnel, "stop requested");
            true
        }
        None => false,
    }
}

pub fn stop_all_tunnels(app: &AppHandle, state: &RemoteTunnelState) {
    let drained: Vec<(String, Tunnel)> = state
        .inner
        .lock()
        .map(|mut map| map.drain().collect())
        .unwrap_or_default();
    for (key, tunnel) in drained {
        kill_tunnel(app, &key, tunnel, "app exit");
    }
}

/// Every few seconds: drop owner windows that no longer exist and kill
/// tunnels nobody views (or whose ssh has exited).
pub fn start_reaper(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(REAPER_INTERVAL);
        let Some(state) = app.try_state::<RemoteTunnelState>() else {
            continue;
        };
        reap_once(&app, &state);
    });
}

fn reap_once(app: &AppHandle, state: &RemoteTunnelState) {
    let mut doomed: Vec<(String, Tunnel, &'static str)> = Vec::new();
    if let Ok(mut map) = state.inner.lock() {
        let keys: Vec<String> = map.keys().cloned().collect();
        for key in keys {
            let Some(tunnel) = map.get_mut(&key) else { continue };
            tunnel
                .owners
                .retain(|label| app.get_webview_window(label).is_some());
            let exited = matches!(tunnel.child.try_wait(), Ok(Some(_)));
            if exited || tunnel.owners.is_empty() {
                if let Some(tunnel) = map.remove(&key) {
                    doomed.push((key, tunnel, if exited { "ssh exited" } else { "no owner windows" }));
                }
            }
        }
    }
    for (key, tunnel, reason) in doomed {
        kill_tunnel(app, &key, tunnel, reason);
    }
}

#[tauri::command]
pub async fn remote_tunnel_ensure(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, RemoteTunnelState>,
    spec: RemoteTunnelSpec,
) -> Result<RemoteTunnelEndpoint, String> {
    let state = (*state).clone();
    let owner = window.label().to_string();
    crate::async_rt::spawn_blocking(move || ensure_tunnel(&app, &state, &owner, &spec))
        .await
        .map_err(|err| format!("remote_tunnel_ensure worker failed: {err}"))
}

#[tauri::command]
pub fn remote_tunnel_stop(
    app: AppHandle,
    state: State<'_, RemoteTunnelState>,
    profile_id: String,
) -> bool {
    stop_tunnels_for_key(&app, &state, &format!("profile:{profile_id}"))
}

#[tauri::command]
pub fn remote_tunnel_status(state: State<'_, RemoteTunnelState>, profile_id: String) -> serde_json::Value {
    let key = format!("profile:{profile_id}");
    let Ok(mut map) = state.inner.lock() else {
        return serde_json::json!({ "running": false });
    };
    match map.get_mut(&key) {
        Some(tunnel) => {
            let running = matches!(tunnel.child.try_wait(), Ok(None));
            serde_json::json!({
                "running": running,
                "port": tunnel.local_port,
                "uptimeSeconds": tunnel.started_at.elapsed().as_secs(),
                "output": log_text(&tunnel.log),
            })
        }
        None => serde_json::json!({ "running": false }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_args_bind_loopback_only_and_never_prompt() {
        let args = ssh_forward_args(23456, "127.0.0.1", 9876, "ap01");
        assert_eq!(args.last().map(String::as_str), Some("ap01"));
        assert!(args.contains(&"127.0.0.1:23456:127.0.0.1:9876".to_string()));
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.contains(&"ExitOnForwardFailure=yes".to_string()));
        assert!(args.contains(&"-N".to_string()));
    }

    #[test]
    fn tunnel_key_prefers_profile_id() {
        let spec = RemoteTunnelSpec {
            profile_id: Some("ap01".into()),
            ssh_target: None,
            remote_host: None,
            remote_port: None,
        };
        assert_eq!(tunnel_key(&spec, "x", "h", 1), "profile:ap01");
        let adhoc = RemoteTunnelSpec {
            profile_id: None,
            ssh_target: Some("ap01".into()),
            remote_host: Some("127.0.0.1".into()),
            remote_port: Some(9876),
        };
        assert_eq!(tunnel_key(&adhoc, "ap01", "127.0.0.1", 9876), "adhoc:ap01|127.0.0.1:9876");
    }

    #[test]
    fn free_port_is_not_listening_after_release() {
        let port = free_local_port().unwrap();
        assert!(port > 0);
        assert!(!port_is_listening(port));
    }
}
