//! Tunnel-client core, shared by the CLI (`main.rs`) and the iOS FFI (`ffi.rs`).
//!
//! A client is a local TCP listener whose every connection is spliced over one
//! authed QUIC bi-stream to a `pounce-tunnel serve` peer, dialed by node id
//! (+ relay for NAT hole-punching). On the phone, the app points its HTTP
//! baseUrl at the returned local port and the entire bridge API — request/
//! response and SSE alike — works exactly as on the LAN.

pub mod ffi;

use anyhow::{anyhow, Context, Result};
use iroh::endpoint::presets::N0;
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayUrl};
use std::str::FromStr;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

pub const ALPN: &[u8] = b"pounce/tunnel/1";
pub const HELLO_PREFIX: &str = "POUNCE1 ";

/// Serve `listener`, forwarding each TCP connection over QUIC to `node`.
/// Runs until the listener errors or the task is aborted.
pub async fn client_listener(
    listener: TcpListener,
    node: &str,
    relay: Option<&str>,
    token: &str,
) -> Result<()> {
    let endpoint_id = EndpointId::from_str(node).map_err(|e| anyhow!("bad node id: {e}"))?;
    let endpoint = Endpoint::builder(N0).alpns(vec![ALPN.to_vec()]).bind().await?;
    let mut addr = EndpointAddr::new(endpoint_id);
    if let Some(relay) = relay.filter(|r| !r.is_empty()) {
        addr = addr.with_relay_url(RelayUrl::from_str(relay).map_err(|e| anyhow!("bad relay: {e}"))?);
    }

    // One QUIC connection shared by all local sockets; re-dialed on failure
    // (network flips between Wi-Fi and cellular kill connections routinely).
    let conn = tokio::sync::Mutex::new(None::<iroh::endpoint::Connection>);

    loop {
        let (tcp, _) = listener.accept().await.context("local accept")?;
        let stream = {
            let mut guard = conn.lock().await;
            let mut attempt = 0;
            loop {
                if guard.is_none() {
                    match endpoint.connect(addr.clone(), ALPN).await {
                        Ok(c) => *guard = Some(c),
                        Err(e) => {
                            attempt += 1;
                            if attempt >= 3 {
                                eprintln!("[tunnel] dial failed: {e}");
                                break None;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            continue;
                        }
                    }
                }
                match guard.as_ref().unwrap().open_bi().await {
                    Ok(s) => break Some(s),
                    Err(_) => *guard = None, // stale connection — re-dial once
                }
            }
        };
        let Some((mut send, recv)) = stream else { continue };
        let token = token.to_string();
        tokio::spawn(async move {
            let hello = format!("{HELLO_PREFIX}{token}\n");
            if send.write_all(hello.as_bytes()).await.is_err() {
                return;
            }
            let mut recv = BufReader::new(recv);
            let mut ack = String::new();
            if recv.read_line(&mut ack).await.is_err() || ack.trim() != "OK" {
                eprintln!("[tunnel] auth rejected: {}", ack.trim());
                return;
            }
            let (mut tcp_read, mut tcp_write) = tcp.into_split();
            let up = async move {
                tokio::io::copy(&mut tcp_read, &mut send).await.ok();
                send.finish().ok();
            };
            let down = async move {
                tokio::io::copy(&mut recv, &mut tcp_write).await.ok();
                tcp_write.shutdown().await.ok();
            };
            tokio::join!(up, down);
        });
    }
}
