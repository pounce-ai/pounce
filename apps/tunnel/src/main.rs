//! pounce-tunnel — Iroh p2p byte tunnel for the Pounce bridge.
//!
//! `serve`: runs on the Mac next to the bridge. Accepts QUIC bi-streams
//! (ALPN "pounce/tunnel/1"), checks a one-line token handshake, then splices
//! bytes to the bridge's TCP port. Every HTTP request/SSE stream the app makes
//! rides its own QUIC stream, so ordinary HTTP semantics survive unchanged.
//!
//! `client`: listens on a local TCP port and forwards each connection over one
//! QUIC stream to a `serve` peer, dialed by node id (+ optional relay for
//! NAT hole-punching). On a phone this whole file is the FFI: the app points
//! its HTTP baseUrl at 127.0.0.1:<port> and everything else stays LAN-identical.
//!
//! Handshake per stream: client sends `POUNCE1 <token>\n`; server replies
//! `OK\n` (or closes). Then raw bytes both ways.

use anyhow::{anyhow, bail, Context, Result};
use iroh::endpoint::presets::N0;
use iroh::{Endpoint, SecretKey};
use pounce_tunnel::{client_listener, ALPN, HELLO_PREFIX};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

fn usage() -> ! {
    eprintln!(
        "usage:\n  pounce-tunnel serve  --token <t> [--target 127.0.0.1:8099] [--key <path>] [--info <path>]\n  pounce-tunnel client --token <t> --node <node-id> [--relay <url>] [--listen 127.0.0.1:8098]"
    );
    std::process::exit(2);
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str);
    let token = arg(&args, "--token")
        .or_else(|| std::env::var("BRIDGE_TOKEN").ok())
        .unwrap_or_else(|| "pounce-bridge-local".into());
    match mode {
        Some("serve") => {
            serve(
                &token,
                &arg(&args, "--target").unwrap_or_else(|| "127.0.0.1:8099".into()),
                arg(&args, "--key").map(PathBuf::from),
                arg(&args, "--info").map(PathBuf::from),
            )
            .await
        }
        Some("client") => {
            let node = arg(&args, "--node").unwrap_or_else(|| usage());
            client(
                &token,
                &node,
                arg(&args, "--relay").as_deref(),
                &arg(&args, "--listen").unwrap_or_else(|| "127.0.0.1:8098".into()),
            )
            .await
        }
        _ => usage(),
    }
}

// --- serve -------------------------------------------------------------------

/// Load (or mint) the persistent identity key so the node id survives restarts —
/// the phone pairs against it once.
fn load_key(path: &PathBuf) -> Result<SecretKey> {
    if let Ok(hex) = std::fs::read_to_string(path) {
        let bytes = hex_to_bytes(hex.trim()).context("parsing tunnel key")?;
        return Ok(SecretKey::from_bytes(&bytes));
    }
    let mut bytes = [0u8; 32];
    getrandom(&mut bytes)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    std::fs::write(path, bytes_to_hex(&bytes)).context("writing tunnel key")?;
    Ok(SecretKey::from_bytes(&bytes))
}

async fn serve(token: &str, target: &str, key_path: Option<PathBuf>, info_path: Option<PathBuf>) -> Result<()> {
    let key_path = key_path.unwrap_or_else(|| default_dir().join("tunnel.key"));
    let key = load_key(&key_path)?;
    let endpoint = Endpoint::builder(N0)
        .secret_key(key)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await?;

    let node_id = endpoint.id().to_string();
    // Wait (bounded) for the endpoint to learn its home relay so the pairing
    // info the phone stores is complete; without a relay, off-LAN dialing has
    // nothing to hole-punch through.
    let relay = {
        use n0_watcher::Watcher;
        let mut w = endpoint.watch_addr();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if let Some(url) = w.get().relay_urls().next() {
                break url.to_string();
            }
            if tokio::time::Instant::now() >= deadline {
                break String::new();
            }
            let _ = tokio::time::timeout(std::time::Duration::from_millis(500), w.updated()).await;
        }
    };
    let info = serde_json::json!({ "nodeId": node_id, "relay": relay, "alpn": String::from_utf8_lossy(ALPN) });
    // Stdout line is machine-readable; the bridge serves it from /v1/pair.
    println!("{info}");
    let info_path = info_path.unwrap_or_else(|| default_dir().join("tunnel.json"));
    if let Some(dir) = info_path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    std::fs::write(&info_path, info.to_string()).ok();
    eprintln!("[tunnel] serving {target} as {node_id} via {relay}");

    while let Some(incoming) = endpoint.accept().await {
        let target = target.to_string();
        let token = token.to_string();
        tokio::spawn(async move {
            let conn = match incoming.await {
                Ok(c) => c,
                Err(e) => return eprintln!("[tunnel] handshake failed: {e}"),
            };
            loop {
                let (send, recv) = match conn.accept_bi().await {
                    Ok(s) => s,
                    Err(_) => break, // connection closed — normal client departure
                };
                let target = target.clone();
                let token = token.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_stream(send, recv, &target, &token).await {
                        eprintln!("[tunnel] stream error: {e}");
                    }
                });
            }
        });
    }
    Ok(())
}

async fn handle_stream(
    mut send: iroh::endpoint::SendStream,
    recv: iroh::endpoint::RecvStream,
    target: &str,
    token: &str,
) -> Result<()> {
    let mut recv = BufReader::new(recv);
    let mut hello = String::new();
    tokio::time::timeout(std::time::Duration::from_secs(10), recv.read_line(&mut hello))
        .await
        .map_err(|_| anyhow!("auth timeout"))??;
    let presented = hello.strip_prefix(HELLO_PREFIX).map(str::trim);
    if presented != Some(token) {
        send.write_all(b"DENIED\n").await.ok();
        bail!("bad token");
    }
    send.write_all(b"OK\n").await?;

    let tcp = TcpStream::connect(target).await.context("dialing bridge")?;
    let (mut tcp_read, mut tcp_write) = tcp.into_split();

    // QUIC→TCP and TCP→QUIC, independently; whichever side closes first ends
    // its direction, mirroring normal TCP half-close for HTTP keep-alive/SSE.
    let up = async move {
        tokio::io::copy(&mut recv, &mut tcp_write).await.ok();
        tcp_write.shutdown().await.ok();
    };
    let down = async move {
        tokio::io::copy(&mut tcp_read, &mut send).await.ok();
        send.finish().ok();
    };
    tokio::join!(up, down);
    Ok(())
}

// --- client --------------------------------------------------------------------

async fn client(token: &str, node: &str, relay: Option<&str>, listen: &str) -> Result<()> {
    let listener = TcpListener::bind(listen).await.context("binding local port")?;
    eprintln!("[tunnel] client on {listen} → {node}");
    client_listener(listener, node, relay, token).await
}

// --- small helpers (no extra deps) --------------------------------------------

fn default_dir() -> PathBuf {
    std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".pounce"))
        .unwrap_or_else(|_| PathBuf::from(".pounce"))
}

fn getrandom(buf: &mut [u8]) -> Result<()> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")?.read_exact(buf)?;
    Ok(())
}

fn bytes_to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn hex_to_bytes(s: &str) -> Result<[u8; 32]> {
    if s.len() != 64 {
        bail!("expected 64 hex chars");
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)?;
    }
    Ok(out)
}
