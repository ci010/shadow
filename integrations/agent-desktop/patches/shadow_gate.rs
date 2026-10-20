// Pure production gates shared with the addon's no-UI tests.
pub fn action_allowed(password: Option<bool>, enabled: bool, offscreen: bool, pattern: bool) -> bool {
    password == Some(false) && enabled && !offscreen && pattern
}
pub fn value_allowed(password: Option<bool>, enabled: bool, offscreen: bool, pattern: bool, edit: bool, readonly: Option<bool>, units: usize) -> bool {
    action_allowed(password,enabled,offscreen,pattern) && edit && readonly == Some(false) && units < 2000
}
pub fn quiet(foreground: bool, idle_ms: Option<u32>) -> bool {
    !foreground || idle_ms.is_some_and(|idle| idle >= 300)
}
#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn ordinary_gate_fails_closed() {
  assert!(action_allowed(Some(false),true,false,true));
  for secret in [None,Some(true)] { assert!(!action_allowed(secret,true,false,true)); }
  assert!(!action_allowed(Some(false),false,false,true));
  assert!(!action_allowed(Some(false),true,true,true));
  assert!(!action_allowed(Some(false),true,false,false));
 }
 #[test] fn value_gate_checks_original_length_and_readonly() {
  assert!(value_allowed(Some(false),true,false,true,true,Some(false),1999));
  for units in [2000,2001,usize::MAX] { assert!(!value_allowed(Some(false),true,false,true,true,Some(false),units)); }
  for readonly in [None,Some(true)] { assert!(!value_allowed(Some(false),true,false,true,true,readonly,0)); }
  assert!(!value_allowed(Some(false),true,false,false,true,Some(false),0));
  assert!(!value_allowed(Some(false),true,false,true,false,Some(false),0));
 }
 #[test] fn quiet_is_foreground_limited_and_inclusive() {
  assert!(quiet(false,None)); assert!(!quiet(true,None));
  assert!(!quiet(true,Some(299))); assert!(quiet(true,Some(300)));
  let samples = [0,50,100,150,200,250,300];
  assert_eq!(samples.into_iter().position(|idle| quiet(true,Some(idle))),Some(6));
  assert!(!(0..20).any(|_| quiet(true,Some(0))));
 }
}

pub fn fingerprint(value: &str) -> serde_json::Value {
 use sha2::{Digest,Sha256};
 serde_json::json!({"sha256":format!("{:x}",Sha256::digest(value.as_bytes())),"utf16":value.encode_utf16().count()})
}
#[cfg(test)]
mod fingerprint_tests {
 use super::*;
 #[test] fn hidden_fingerprint_is_fixed_size_and_changes_with_tail() {
  let long = "private text ".repeat(100000);
  let hash = fingerprint(&long);
  assert!(hash.to_string().len()<110);
  assert!(!hash.to_string().contains("private text"));
  assert_eq!(hash["sha256"].as_str().unwrap().len(),64);
  assert_ne!(hash,fingerprint(&(long+"changed tail")));
  assert_eq!(fingerprint("😀")["utf16"],2);
  assert_eq!(fingerprint("abc")["sha256"],"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
 }
 #[test] fn value_gate_cannot_bypass_nonsecret_enabled_onscreen_gate() {
  assert!(!value_allowed(None,true,false,true,true,Some(false),0));
  assert!(!value_allowed(Some(true),true,false,true,true,Some(false),0));
  assert!(!value_allowed(Some(false),false,false,true,true,Some(false),0));
  assert!(!value_allowed(Some(false),true,true,true,true,Some(false),0));
 }
}
/// Shared pre/post mutation gate. Cancellation is never reset by a new deadline.
pub fn dispatch_allowed(expired: bool, cancelled: bool) -> bool { !expired && !cancelled }
#[cfg(test)] mod cancellation_gate_tests {
 use super::*;
 #[test] fn cancellation_before_dispatch_cannot_start_an_effect() {
  for expired in [false,true] { let mut started=false; if dispatch_allowed(expired,true) { started=true; } assert!(!started); }
  assert!(dispatch_allowed(false,false)); assert!(!dispatch_allowed(true,false));
 }
}

pub fn typing_value_allowed(available:Option<bool>, readonly:Option<bool>)->bool {
 matches!((available,readonly),(Some(false),_)|(Some(true),Some(false)))
}
#[cfg(test)] mod typing_gate_tests {
 use super::*;
 #[test] fn only_known_absence_or_known_writable_value_is_allowed() {
  assert!(typing_value_allowed(Some(false),None)); assert!(typing_value_allowed(Some(true),Some(false)));
  for evidence in [(None,None),(None,Some(false)),(Some(true),None),(Some(true),Some(true))] { assert!(!typing_value_allowed(evidence.0,evidence.1)); }
 }
}
