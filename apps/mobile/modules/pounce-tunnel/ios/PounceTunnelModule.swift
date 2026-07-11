import ExpoModulesCore
import PounceTunnel

public class PounceTunnelModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PounceTunnel")

    // AsyncFunction runs off the JS thread; the Rust side only blocks long
    // enough to bind 127.0.0.1:0 — dialing happens lazily per connection.
    AsyncFunction("start") { (nodeId: String, relay: String?, token: String) -> Int in
      let port = pounce_tunnel_start(nodeId, relay, token)
      if port < 0 {
        let message = String(cString: pounce_tunnel_last_error())
        throw Exception(name: "TunnelStartFailed", description: message.isEmpty ? "tunnel start failed" : message)
      }
      return Int(port)
    }

    Function("stop") {
      pounce_tunnel_stop()
    }
  }
}
