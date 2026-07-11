//! C ABI for the phone: start/stop an in-app loopback proxy over Iroh.
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
    let relay = cstr(relay).unwrap_or_default();
    let key = format!("{node}|{relay}|{token}");

    let mut active = ACTIVE.lock().unwrap();
    if let Some(a) = active.as_ref() {
        if a.key == key && !a.task.is_finished() {
            return a.port as i32; // already proxying this peer
        }
        a.task.abort();
        *active = None;
    }

    let rt = runtime();
    let bound = rt.block_on(async { tokio::net::TcpListener::bind("127.0.0.1:0").await });
    let listener = match bound {
        Ok(l) => l,
        Err(e) => {
            set_error(format!("bind failed: {e}"));
            return -1;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            set_error(format!("local_addr failed: {e}"));
            return -1;
        }
    };

    let relay_opt = (!relay.is_empty()).then_some(relay);
    let task = rt.spawn({
        let node = node.clone();
        let token = token.clone();
        async move {
            if let Err(e) = crate::client_listener(listener, &node, relay_opt.as_deref(), &token).await {
                set_error(format!("tunnel stopped: {e}"));
            }
        }
    });

    *active = Some(Active { port, key, task });
    port as i32
}

#[no_mangle]
pub extern "C" fn pounce_tunnel_stop() {
    if let Some(a) = ACTIVE.lock().unwrap().take() {
        a.task.abort();
    }
}

/// Returned pointer is valid until the next FFI call.
#[no_mangle]
pub extern "C" fn pounce_tunnel_last_error() -> *const c_char {
    static BUF: Mutex<Option<CString>> = Mutex::new(None);
    let msg = LAST_ERROR.lock().unwrap().clone();
    let c = CString::new(msg).unwrap_or_default();
    let mut buf = BUF.lock().unwrap();
    *buf = Some(c);
    buf.as_ref().unwrap().as_ptr()
}
