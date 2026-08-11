//! FFI for the phone: start/stop an in-app loopback proxy over Iroh.
//!
//! Two callers, one implementation. iOS links the staticlib and calls the C ABI
//! below; Android loads the cdylib and calls the JNI entry points in
//! `android.rs`, which wrap the very same [`start`]/[`stop`]/[`last_error`].
//! Keeping the runtime and the ACTIVE slot here — rather than one copy per
//! platform — is what makes "start while running returns the existing port"
//! mean the same thing on both.
//!
//! The C ABI:
//!
//!   int  pounce_tunnel_start(const char* node_id, const char* relay, const char* token);
//!     → local TCP port (bind 127.0.0.1:0), or -1 (see pounce_tunnel_last_error)
//!   void pounce_tunnel_stop(void);
//!   const char* pounce_tunnel_last_error(void);   // static buffer, may be ""
//!
//! The app sets its HTTP baseUrl to http://127.0.0.1:<port> and everything —
//! fetch, SSE streaming — flows over QUIC to the Mac. Idempotent: start while
//! running returns the existing port (same peer) or restarts (different peer).

use std::ffi::{c_char, CStr, CString};
use std::sync::{Mutex, OnceLock};
use tokio::runtime::Runtime;

struct Active {
    port: u16,
    key: String, // node_id|relay|token — identifies the peer this proxy serves
    task: tokio::task::JoinHandle<()>,
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();
static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static LAST_ERROR: Mutex<String> = Mutex::new(String::new());

fn runtime() -> &'static Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime")
    })
}

fn set_error(e: impl std::fmt::Display) {
    *LAST_ERROR.lock().unwrap() = e.to_string();
}

/// Start (or reuse) the loopback proxy. Returns the local port.
///
/// The platform wrappers below add nothing but marshalling — all the behaviour
/// worth agreeing on lives here: same peer while running is a no-op that hands
/// back the port it already has, a different peer aborts and rebinds.
/// Recording the failure is part of starting, not something each platform
/// wrapper has to remember to do — they'd drift, and a wrapper that forgot
/// would leave `last_error` reporting the previous run's problem.
pub(crate) fn start(node: &str, relay: Option<&str>, token: &str) -> Result<u16, String> {
    let started = start_inner(node, relay, token);
    if let Err(e) = &started {
        set_error(e);
    }
    started
}

fn start_inner(node: &str, relay: Option<&str>, token: &str) -> Result<u16, String> {
    if node.is_empty() || token.is_empty() {
        return Err("node_id and token are required".to_string());
    }
    let relay = relay.filter(|r| !r.is_empty());
    let key = format!("{node}|{}|{token}", relay.unwrap_or_default());

    let mut active = ACTIVE.lock().unwrap();
    if let Some(a) = active.as_ref() {
        if a.key == key && !a.task.is_finished() {
            return Ok(a.port); // already proxying this peer
        }
        a.task.abort();
        *active = None;
    }

    let rt = runtime();
    let listener = rt
        .block_on(async { tokio::net::TcpListener::bind("127.0.0.1:0").await })
        .map_err(|e| format!("bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?
        .port();

    let task = rt.spawn({
        let node = node.to_owned();
        let token = token.to_owned();
        let relay = relay.map(str::to_owned);
        async move {
            if let Err(e) = crate::client_listener(listener, &node, relay.as_deref(), &token).await {
                set_error(format!("tunnel stopped: {e}"));
            }
        }
    });

    *active = Some(Active { port, key, task });
    Ok(port)
}

pub(crate) fn stop() {
    if let Some(a) = ACTIVE.lock().unwrap().take() {
        a.task.abort();
    }
}

pub(crate) fn last_error() -> String {
    LAST_ERROR.lock().unwrap().clone()
}

fn cstr(p: *const c_char) -> Option<String> {
    if p.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(p) }.to_str().ok().map(str::to_owned)
}

/// # Safety
/// `node_id` and `token` must be valid NUL-terminated UTF-8; `relay` may be NULL.
#[no_mangle]
pub unsafe extern "C" fn pounce_tunnel_start(
    node_id: *const c_char,
    relay: *const c_char,
    token: *const c_char,
) -> i32 {
    let (Some(node), Some(token)) = (cstr(node_id), cstr(token)) else {
        set_error("node_id and token are required");
        return -1;
    };
    start(&node, cstr(relay).as_deref(), &token).map_or(-1, |port| port as i32)
}

#[no_mangle]
pub extern "C" fn pounce_tunnel_stop() {
    stop();
}

/// Returned pointer is valid until the next FFI call.
#[no_mangle]
pub extern "C" fn pounce_tunnel_last_error() -> *const c_char {
    static BUF: Mutex<Option<CString>> = Mutex::new(None);
    let c = CString::new(last_error()).unwrap_or_default();
    let mut buf = BUF.lock().unwrap();
    *buf = Some(c);
    buf.as_ref().unwrap().as_ptr()
}
