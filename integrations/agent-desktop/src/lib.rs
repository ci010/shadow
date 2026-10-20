//! Optional native addon. Always load in a disposable Node worker process.
#[cfg(not(test))]
use napi_derive::napi;
use serde_json::{Value, json};
#[cfg(target_os = "windows")] mod windows;
#[cfg(target_os = "windows")] mod input;
#[cfg_attr(not(test), napi(js_name = "cancelInput"))]
pub fn cancel_input() { #[cfg(target_os = "windows")] input::cancel(); }
const REVISION: &str = "5a2c9ad43e269164a8adc8978a733c40b1d38a8b";
const MAX_REQUEST_BYTES: usize = 32 * 1024;
#[cfg_attr(not(test), napi)]
pub fn identity() -> String {
 json!({"protocol":1,"revision":REVISION,"backend":"agent-desktop","capabilities":{"restricted":true,"methods":["list","bind","observe","act","foreground","release"],"actions":["invoke","set_value","toggle","select","scroll","click","move","drag","wheel","press_key","type_text"],"screenshot":true,"input":true,"clipboard":false,"values":true,"nodeBounds":true,"patch":"shadow-password-first-v3","guard":"shadow-input-guard-v1"}}).to_string()
}
fn error(code: &str, reason: &str) -> String {
 json!({"error":{"code":code,"reason":reason}}).to_string()
}
fn validate(input: &str) -> Result<Value, String> {
 if input.len() > MAX_REQUEST_BYTES { return Err(error("unsupported_action", "request exceeds 32768 bytes")); }
 let value: Value = serde_json::from_str(input).map_err(|_|error("unsupported_action", "invalid JSON request"))?;
 if !value.is_object() || value["method"].as_str().filter(|s|!s.is_empty()).is_none() { return Err(error("unsupported_action", "method is required")); }
 Ok(value)
}
/// Synchronous ABI. Host must call from its JS Worker, never its event loop.
/// One persistent native owner thread serializes all calls and owns COM,
/// adapter and target state. Internal shutdown joins it before worker exit.
#[cfg_attr(not(test), napi)]
pub fn request(input: String) -> String {
 let value = match validate(&input) { Ok(v)=>v, Err(e)=>return e };
 run(value)
}
#[cfg(target_os = "windows")]
mod owner;
#[cfg(target_os = "windows")]
fn run(value: Value) -> String { owner::run(value) }
#[cfg(not(target_os = "windows"))]
fn run(_value: Value) -> String { error("unavailable", "Windows only") }
#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn identity_is_pure() {
  let value:Value=serde_json::from_str(&identity()).unwrap();
  assert_eq!(value["protocol"],1); assert_eq!(value["revision"],REVISION);
  assert_eq!(value["capabilities"]["input"],true);
 }
 #[test] fn validation_has_no_desktop_calls() {
  for input in ["", "[]", "null", "{}", "{\"method\":1}"] { assert!(validate(input).is_err()); }
  assert!(validate(&"x".repeat(MAX_REQUEST_BYTES+1)).is_err());
  assert!(validate("{\"method\":\"release\"}").is_ok());
 }
}

#[path="../patches/shadow_gate.rs"]
#[allow(dead_code)]
mod safety_gate;
