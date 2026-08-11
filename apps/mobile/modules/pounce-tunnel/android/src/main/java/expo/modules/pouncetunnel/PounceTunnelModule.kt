package expo.modules.pouncetunnel

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The Rust core, reached over JNI.
 *
 * These names are load-bearing: the symbols in apps/tunnel/src/android.rs are
 * derived from this object's fully-qualified name, so renaming or moving it
 * without changing them there produces an UnsatisfiedLinkError on first call —
 * not at load, which is the part that makes it easy to miss.
 */
internal object PounceTunnelNative {
  init {
    // Packaged per-ABI in src/main/jniLibs by apps/tunnel/build-android.sh.
    System.loadLibrary("pounce_tunnel")
  }

  external fun nativeStart(nodeId: String, relay: String?, token: String): Int

  external fun nativeStop()

  external fun nativeLastError(): String?
}

class TunnelStartFailed(message: String) : CodedException(message)

/**
 * pounce-tunnel on Android — the counterpart of ios/PounceTunnelModule.swift.
 *
 * Same module name and the same two functions, because the JS side
 * (`requireNativeModule("PounceTunnel")`) decides a platform "has" the tunnel
 * purely by whether that lookup throws. Registering this is the entire fix:
 * bridge.ts already routes through `tunnelAvailable()` with no Platform.OS
 * anywhere, so off-LAN access on Android switches on with no JS change.
 */
class PounceTunnelModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PounceTunnel")

    // AsyncFunction runs off the JS thread; the Rust side only blocks long
    // enough to bind 127.0.0.1:0 — dialing happens lazily per connection.
    AsyncFunction("start") { nodeId: String, relay: String?, token: String ->
      val port = PounceTunnelNative.nativeStart(nodeId, relay, token)
      if (port < 0) {
        val message = PounceTunnelNative.nativeLastError().orEmpty()
        throw TunnelStartFailed(message.ifEmpty { "tunnel start failed" })
      }
      port
    }

    Function("stop") {
      PounceTunnelNative.nativeStop()
    }
  }
}
