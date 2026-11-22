//! Local, bounded bridge to the bundled channel client. Credentials travel only on stdin.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::{Read, Write}, process::{Command, Stdio}, sync::mpsc, thread, time::{Duration, Instant}};

const MAX_INPUT: usize = 16_384;
const MAX_OUTPUT: usize = 65_536;
const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ChannelRequest {
    Status,
    Begin { token: String, #[serde(rename = "expectedRevision", deserialize_with = "deserialize_revision")] expected_revision: Option<u64> },
    OperationStatus { #[serde(rename = "operationId")] operation_id: String, #[serde(rename = "expectedRevision", deserialize_with = "deserialize_revision")] expected_revision: Option<u64> },
    Cancel { #[serde(rename = "operationId")] operation_id: String, #[serde(rename = "expectedRevision", deserialize_with = "deserialize_revision")] expected_revision: Option<u64> },
    Confirm { #[serde(rename = "operationId")] operation_id: String, #[serde(rename = "expectedRevision", deserialize_with = "deserialize_revision")] expected_revision: Option<u64> },
    ConfirmAccount { #[serde(rename = "operationId")] operation_id: String, #[serde(rename = "expectedRevision", deserialize_with = "deserialize_revision")] expected_revision: Option<u64> },
    Test { #[serde(rename = "expectedRevision", deserialize_with = "deserialize_revision")] expected_revision: Option<u64> },
    Disconnect { #[serde(rename = "expectedRevision", deserialize_with = "deserialize_revision")] expected_revision: Option<u64> },
}

fn deserialize_revision<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
    Option::<u64>::deserialize(deserializer)
}

fn run(request: ChannelRequest) -> Result<Value, String> {
    let payload = serde_json::to_vec(&request).map_err(|_| "Invalid channel request.")?;
    if payload.len() > MAX_INPUT { return Err("Invalid channel request.".into()); }
    let exe = std::env::current_exe().map_err(|_| "Cannot locate the bundled Keryx executable.")?;
    let executable = crate::locator::bundled(exe.parent()).ok_or("The bundled Keryx executable is unavailable.")?;
    let mut child = Command::new(executable).args(["serve", "desktop-channel"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "Cannot start channel control.")?;
    let mut stdin = child.stdin.take().ok_or("Cannot write channel control request.")?;
    if stdin.write_all(&payload).is_err() { let _ = child.kill(); let _ = child.wait(); return Err("Cannot write channel control request.".into()); }
    drop(stdin);
    let stdout = child.stdout.take().ok_or("Cannot read channel control response.")?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut output = Vec::new();
        let result = stdout.take((MAX_OUTPUT + 1) as u64).read_to_end(&mut output).map(|_| output);
        let _ = tx.send(result);
    });
    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Err(_) => { let _ = child.kill(); let _ = child.wait(); return Err("Cannot confirm channel control exit.".into()); }
            Ok(None) => {}
        }
        if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return Err("Channel control timed out; refresh status before retrying.".into()); }
        thread::sleep(Duration::from_millis(20));
    };
    let output = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(|_| "Cannot read channel control response.")?.map_err(|_| "Cannot read channel control response.")?;
    if !status.success() || output.len() > MAX_OUTPUT { return Err("Channel control failed.".into()); }
    serde_json::from_slice(&output).map_err(|_| "Channel control returned an invalid response.".into())
}

#[tauri::command]
pub async fn telegram_channel_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| run(ChannelRequest::Status)).await.map_err(|_| "Channel control failed.".to_string())?
}

#[tauri::command]
pub async fn telegram_channel_action(request: ChannelRequest) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run(request)).await.map_err(|_| "Channel control failed.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_contract_is_closed_and_serializes_revision() {
        let request: ChannelRequest = serde_json::from_str(r#"{"action":"begin","token":"sample","expectedRevision":null}"#).unwrap();
        let payload = serde_json::to_value(request).unwrap();
        assert_eq!(payload["expectedRevision"], Value::Null);
        assert!(serde_json::from_str::<ChannelRequest>(r#"{"action":"begin","token":"sample","expectedRevision":null,"extra":1}"#).is_err());
        assert!(serde_json::from_str::<ChannelRequest>(r#"{"action":"begin","token":"sample"}"#).is_err());
    }
}
