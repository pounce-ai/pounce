//! JNI entry points for Android.
//!
//! iOS links the staticlib and calls the C ABI in `ffi.rs` directly. Kotlin
//! can't do that — the JVM only knows how to call symbols named after the class
//! that declares them — so this is a marshalling layer and nothing more. Every
//! function here converts arguments and hands straight off to the shared core,
//! which means Android and iOS get identical behaviour by construction rather
//! than by two implementations happening to agree.
//!
//! The symbol names encode `expo.modules.pouncetunnel.PounceTunnelNative`. If
//! that Kotlin object is ever renamed or moved, these must move with it — a
//! mismatch is an `UnsatisfiedLinkError` at first call, not at load.
//!
//! Errors do NOT throw across JNI here. `nativeStart` returns -1 and the caller
//! asks `nativeLastError` for the message, mirroring the C ABI exactly; letting
//! Rust throw would mean two error paths to keep in step for no gain.

use jni::objects::{JClass, JString};
use jni::sys::{jint, jstring};
use jni::JNIEnv;

use crate::ffi;

/// Read a Java string, treating null as absent. A JNI call can also fail
/// outright (pending exception), which we likewise report as absent — the core
/// then rejects the empty node/token with its own message.
fn read(env: &mut JNIEnv, s: &JString) -> Option<String> {
    if s.is_null() {
        return None;
    }
    env.get_string(s).ok().map(|v| v.into())
}

/// `nativeStart(node, relay, token) -> local port, or -1`.
///
/// # Safety
/// Called only by the JVM, which guarantees the argument types.
#[no_mangle]
pub extern "system" fn Java_expo_modules_pouncetunnel_PounceTunnelNative_nativeStart<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    node: JString<'local>,
    relay: JString<'local>,
    token: JString<'local>,
) -> jint {
    let node = read(&mut env, &node).unwrap_or_default();
    let relay = read(&mut env, &relay);
    let token = read(&mut env, &token).unwrap_or_default();
    ffi::start(&node, relay.as_deref(), &token).map_or(-1, |port| port as jint)
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_pouncetunnel_PounceTunnelNative_nativeStop<'local>(
    _env: JNIEnv<'local>,
    _class: JClass<'local>,
) {
    ffi::stop();
}

/// The last failure, or "" — including one that happened after `nativeStart`
/// returned, when the proxy task itself died. Returning a null jstring on an
/// allocation failure is fine: Kotlin reads it as null and says nothing.
#[no_mangle]
pub extern "system" fn Java_expo_modules_pouncetunnel_PounceTunnelNative_nativeLastError<'local>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
) -> jstring {
    match env.new_string(ffi::last_error()) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}
