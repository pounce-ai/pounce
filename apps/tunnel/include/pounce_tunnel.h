// C ABI for the Pounce tunnel client (apps/tunnel/src/ffi.rs).
// The app starts an in-process loopback proxy that carries HTTP over Iroh
// QUIC to the paired Mac, then points its baseUrl at 127.0.0.1:<port>.
#ifndef POUNCE_TUNNEL_H
#define POUNCE_TUNNEL_H

#ifdef __cplusplus
extern "C" {
#endif

// Start (or reuse) the loopback proxy toward `node_id`. `relay` may be NULL.
// Returns the local TCP port, or -1 (see pounce_tunnel_last_error).
int pounce_tunnel_start(const char *node_id, const char *relay, const char *token);

// Stop the proxy if running. Safe to call at any time.
void pounce_tunnel_stop(void);

// Last error message (static buffer, valid until the next call; may be "").
const char *pounce_tunnel_last_error(void);

#ifdef __cplusplus
}
#endif

#endif
