//! Live smoke against a real `keryx acp`: initialize -> session/new round trip.
//!
//! Ignored by default (needs a keryx). Run with
//!   KERYX_BIN=/path/to/keryx-wrapper cargo test --test live_smoke -- --ignored --nocapture
//! Optionally KERYX_ARGS="acp --profile shell" (default) to choose the argv.

use keryx_desktop_lib::process::{AcpProcess, ProcessEvent, SpawnConfig};
use serde_json::{json, Value};
use std::sync::mpsc;
use std::time::Duration;

fn recv_response(rx: &mpsc::Receiver<ProcessEvent>, id: i64) -> Value {
    loop {
        match rx.recv_timeout(Duration::from_secs(60)).expect("timed out waiting for keryx") {
            ProcessEvent::Line(l) => {
                let v: Value = serde_json::from_str(&l).expect("keryx printed non-JSON on stdout");
                if v.get("id") == Some(&json!(id)) && v.get("method").is_none() {
                    return v;
                }
            }
            ProcessEvent::Exit { code, stderr_tail } => panic!("keryx exited {code:?}: {stderr_tail}"),
            ProcessEvent::Oversized => panic!("oversized line"),
        }
    }
}

#[test]
#[ignore]
fn initialize_and_new_session_round_trip() {
    let bin = std::env::var("KERYX_BIN").expect("set KERYX_BIN");
    let args = std::env::var("KERYX_ARGS").unwrap_or_else(|_| "acp --profile shell".into());
    let cwd = tempfile::tempdir().unwrap();
    let env: std::collections::HashMap<String, String> = std::env::vars().collect();
    let (tx, rx) = mpsc::channel();
    let tx = std::sync::Mutex::new(tx);
    let proc = AcpProcess::spawn(
        SpawnConfig {
            program: bin.into(),
            args: args.split_whitespace().map(String::from).collect(),
            cwd: cwd.path().to_path_buf(),
            env,
            log_path: Some(cwd.path().join("stderr.log")),
        },
        move |_p, ev| {
            let _ = tx.lock().unwrap().send(ev);
        },
    )
    .expect("spawn keryx");

    proc.send_line(
        &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":1,
            "clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":false},"terminal":false,"_meta":{"keryx":{"askUser":true}}},
            "clientInfo":{"name":"keryx-desktop","version":"0.1.0"}}})
        .to_string(),
    )
    .unwrap();
    let init = recv_response(&rx, 1);
    println!("initialize -> {init}");
    assert_eq!(init["result"]["protocolVersion"], 1);

    proc.send_line(
        &json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd": cwd.path(),"mcpServers":[]}}).to_string(),
    )
    .unwrap();
    let new = recv_response(&rx, 2);
    println!("session/new -> {new}");
    assert!(new["result"]["sessionId"].as_str().is_some(), "no sessionId in {new}");

    proc.kill();
}
