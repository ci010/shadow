//! Independent cancellation handle and owned AOT guard transport. No shell.
use serde_json::{Value,json};
use std::os::windows::process::CommandExt;
use std::{ffi::c_void, sync::{Arc,Mutex}, process::{Child,ChildStdin,Command,Stdio}, io::{BufRead,BufReader,Read,Write}, time::{Instant,Duration}};
type Result<T> = std::result::Result<T,&'static str>;
#[link(name="kernel32")]
unsafe extern "system" {
 fn CreateEventW(attributes:*const c_void, manual:i32, initial:i32, name:*const u16)->*mut c_void;
 fn SetEvent(handle:*mut c_void)->i32;
 fn WaitForSingleObject(handle:*mut c_void, timeout:u32)->u32;
 fn CloseHandle(handle:*mut c_void)->i32;
}
pub(crate) struct EventHandle(*mut c_void);
unsafe impl Send for EventHandle {} unsafe impl Sync for EventHandle {}
impl Drop for EventHandle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
static STOPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static CANCEL: Mutex<Option<Arc<EventHandle>>> = Mutex::new(None);
pub fn is_cancelled()->bool { STOPPED.load(std::sync::atomic::Ordering::SeqCst) }
pub fn cancel() { STOPPED.store(true,std::sync::atomic::Ordering::SeqCst); let handle = CANCEL.lock().ok().and_then(|slot|slot.clone()); if let Some(handle)=handle { unsafe { SetEvent(handle.0); } } }
pub struct Guard { child:Child, writer:Option<ChildStdin>, replies:std::sync::mpsc::Receiver<Result<String>>, event:Arc<EventHandle> }
impl Guard {
 pub fn start(path:&str)->Result<Self> {
  if STOPPED.load(std::sync::atomic::Ordering::SeqCst) { return Err("user_interrupted"); }
  verify_identity(path).map_err(|code| { cancel(); code })?;
  if is_cancelled() { return Err("user_interrupted"); }
  let name=format!("Local\\ShadowInput-{}",crate::windows::uuid()?);
  let wide:Vec<u16>=name.encode_utf16().chain(Some(0)).collect();
  let event=Arc::new(EventHandle(unsafe { CreateEventW(std::ptr::null(),1,0,wide.as_ptr()) }));
  if event.0.is_null() { return Err("input_unavailable"); }
  { let mut slot=CANCEL.lock().map_err(|_|"input_unavailable")?; if slot.is_some() { return Err("user_interrupted"); } *slot=Some(event.clone()); if STOPPED.load(std::sync::atomic::Ordering::SeqCst) { unsafe { SetEvent(event.0); } return Err("user_interrupted"); } }
  if is_cancelled() { unsafe { SetEvent(event.0); } return Err("user_interrupted"); }
  let mut child=Command::new(path).arg(std::process::id().to_string()).creation_flags(0x08000000).env("SHADOW_INPUT_CANCEL_EVENT",name).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_|"input_unavailable")?;
  let writer=child.stdin.take().ok_or("input_unavailable")?;
  let stdout=child.stdout.take().ok_or("input_unavailable")?;
  let (tx,replies)=std::sync::mpsc::sync_channel(1);
  std::thread::spawn(move || { let mut reader=BufReader::new(stdout); loop { let mut line=Vec::new(); let result=reader.by_ref().take(65538).read_until(b'\n',&mut line); let reply=match result { Ok(n) if n>0 && n<=65537 && line.last()==Some(&b'\n')=>String::from_utf8(line).map_err(|_|"input_unavailable"), _=>Err("input_unavailable") }; let failed=reply.is_err(); if tx.send(reply).is_err() || failed { break; } } });
  Ok(Self { child,writer:Some(writer),replies,event })
 }
 pub fn check(&self)->Result<()> { if is_cancelled() || unsafe { WaitForSingleObject(self.event.0,0) } !=258 { Err("user_interrupted") } else { Ok(()) } }
 pub fn request(&mut self, method:&str,payload:Value,started:&mut bool)->Result<Value> {
  let result=self.request_inner(method,payload,started);
  if matches!(result,Err("input_unavailable"|"outcome_unknown")) { cancel(); self.writer.take(); }
  result
 }
 fn request_inner(&mut self, method:&str,payload:Value,started:&mut bool)->Result<Value> {
  self.check()?;
  let id=crate::windows::uuid()?;
  let line=json!({"id":id,"method":method,"payload":payload}).to_string();
  if line.len()>32768 { return Err("invalid_request"); }
  if method=="execute" { *started=true; }
  let writer=self.writer.as_mut().ok_or("input_unavailable")?;
  writeln!(writer,"{line}").and_then(|_|writer.flush()).map_err(|_|"input_unavailable")?;
  let deadline=Instant::now()+Duration::from_secs(12);
  let line=loop { self.check()?; match self.replies.recv_timeout(Duration::from_millis(20)) { Ok(v)=>break v?, Err(std::sync::mpsc::RecvTimeoutError::Timeout) if Instant::now()<deadline=>continue, _=>return Err("input_unavailable") } };
  parse_reply(&line,&id,method,started)
 }
}
fn parse_reply(line:&str,id:&str,method:&str,started:&mut bool)->Result<Value> {
 let value:Value=serde_json::from_str(line).map_err(|_|"outcome_unknown")?;
 let map=value.as_object().ok_or("outcome_unknown")?;
 if map.len()!=2 || value["id"]!=id { return Err("outcome_unknown"); }
 if let Some(error)=value.get("error") {
  let fields=error.as_object().ok_or("outcome_unknown")?;
  if fields.len()<2 || fields.len()>3 || fields.keys().any(|k|!matches!(k.as_str(),"code"|"effectStarted"|"reason")) || error.get("reason").is_some_and(|v|!v.is_null() && !v.is_string()) { return Err("outcome_unknown"); }
  let effect=error["effectStarted"].as_bool().ok_or("outcome_unknown")?;
  *started |= effect;
  return Err(match error["code"].as_str().ok_or("outcome_unknown")? { "invalid_request"=>"invalid_request", "protected_target"=>"protected_target", "focus_denied"=>"focus_denied", "keyboard_focus_changed"=>"keyboard_focus_changed", "input_outside_window"=>"input_outside_window", "stale_observation"=>"stale_observation", "user_interrupted"=>"user_interrupted", "unsupported_shortcut"=>"unsupported_shortcut", "outcome_unknown"=>"outcome_unknown", "input_unavailable"=>"input_unavailable", _=>"outcome_unknown" });
 }
 let result=value.get("result").ok_or("outcome_unknown")?;
 validate_result(method,result)?;
 Ok(result.clone())
}
impl Drop for Guard { fn drop(&mut self) { cancel(); self.writer.take(); let deadline=Instant::now()+Duration::from_millis(1500); loop { if matches!(self.child.try_wait(),Ok(Some(_))) { break; } if Instant::now()>=deadline { let _=self.child.kill(); let _=self.child.try_wait(); break; } std::thread::sleep(Duration::from_millis(10)); } } }
#[cfg(test)] mod tests { use super::*; #[test] fn replies_preserve_ambiguity() { let mut started=true; assert!(parse_reply(r#"{"id":"a","error":{"code":"input_unavailable","effectStarted":false}}"#,"a","execute",&mut started).is_err()); assert!(started); for bad in ["{}",r#"{"id":"b","result":{}}"#,r#"{"id":"a","error":{"code":"input_unavailable"}}"#] { assert_eq!(parse_reply(bad,"a","execute",&mut false).unwrap_err(),"outcome_unknown"); } } }

#[cfg(test)] mod event_tests {
 use super::*;
 #[test] fn cloned_event_survives_slot_close_and_signal_is_sticky() {
  let event=Arc::new(EventHandle(unsafe{CreateEventW(std::ptr::null(),1,0,std::ptr::null())})); assert!(!event.0.is_null());
  let slot=Mutex::new(Some(event.clone())); let cloned=slot.lock().unwrap().clone().unwrap(); slot.lock().unwrap().take(); drop(event);
  assert_eq!(unsafe{WaitForSingleObject(cloned.0,0)},258); assert_ne!(unsafe{SetEvent(cloned.0)},0); assert_eq!(unsafe{WaitForSingleObject(cloned.0,0)},0); assert_eq!(unsafe{WaitForSingleObject(cloned.0,0)},0);
 }
}

#[cfg(test)] mod cancellation_tests {
 use super::*;
 #[test] fn cancellation_before_lazy_start_permanently_rejects_start() {
  cancel(); assert!(is_cancelled());
  for _ in 0..3 { assert!(matches!(Guard::start("synthetic-never-executed.exe"),Err("user_interrupted"))); }
 }
}

fn validate_result(method:&str,result:&Value)->Result<()> {
 let map=result.as_object().filter(|m|m.len()==1).ok_or("outcome_unknown")?;
 let valid=match method {
  "begin"=>map.get("activated").is_some_and(Value::is_boolean),
  "activation"|"check"=>map.get("ready")==Some(&json!(true)),
  "cancel"=>map.get("cancelled")==Some(&json!(true)),
  "execute"=>map.get("focusRestored").is_some_and(|v|v.is_null()||v.is_boolean()),
  _=>false
 };
 if valid { Ok(()) } else { Err("outcome_unknown") }
}
fn validate_identity(bytes:&[u8])->Result<()> {
 if bytes.len()>4096 { return Err("input_unavailable"); }
 let value:Value=serde_json::from_slice(bytes).map_err(|_|"input_unavailable")?;
 if value.as_object().map(|m|m.len())!=Some(3) || value["protocol"]!=1 || value["backend"]!="shadow-input-guard" || !value["sourceSha256"].as_str().is_some_and(|s|s.len()==64 && s.bytes().all(|b|b.is_ascii_hexdigit())) { return Err("input_unavailable"); }
 Ok(())
}
struct IdentityChild(Child);
impl Drop for IdentityChild { fn drop(&mut self) { if !matches!(self.0.try_wait(),Ok(Some(_))) { let _=self.0.kill(); } let _=self.0.try_wait(); } }
fn verify_identity(path:&str)->Result<()> {
 if is_cancelled() { return Err("user_interrupted"); }
 let child=Command::new(path).arg("--identity").creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_|"input_unavailable")?;
 let mut child=IdentityChild(child);
 let stdout=child.0.stdout.take().ok_or("input_unavailable")?;
 let (tx,rx)=std::sync::mpsc::sync_channel(1);
 std::thread::spawn(move || { let mut bytes=Vec::new(); let result=stdout.take(4097).read_to_end(&mut bytes).map(|_|bytes).map_err(|_|"input_unavailable"); let _=tx.send(result); });
 let deadline=Instant::now()+Duration::from_secs(3);
 let mut output=None;
 loop {
  if is_cancelled() { return Err("user_interrupted"); }
  if output.is_none() { match rx.try_recv() { Ok(bytes)=>output=Some(bytes?), Err(std::sync::mpsc::TryRecvError::Empty)=>{}, Err(_)=>return Err("input_unavailable") } }
  if let Some(status)=child.0.try_wait().map_err(|_|"input_unavailable")? {
   if !status.success() { return Err("input_unavailable"); }
   if let Some(bytes)=output { validate_identity(&bytes)?; if is_cancelled() { return Err("user_interrupted"); } return Ok(()); }
  }
  if Instant::now()>=deadline { return Err("input_unavailable"); }
  std::thread::sleep(Duration::from_millis(10));
 }
}
#[cfg(test)] mod schema_tests {
 use super::*;
 #[test] fn exact_method_specific_result_shapes() {
  for (method,result) in [("begin",json!({"activated":false})),("activation",json!({"ready":true})),("check",json!({"ready":true})),("cancel",json!({"cancelled":true})),("execute",json!({"focusRestored":null})),("execute",json!({"focusRestored":false}))] {
   assert!(validate_result(method,&result).is_ok());
   let mut extra=result.clone(); extra["extra"]=json!(true); assert!(validate_result(method,&extra).is_err());
   for bad in [json!({}),json!({"ready":false}),json!({"focusRestored":"true"})] { assert!(validate_result(method,&bad).is_err()); }
  }
  for method in ["begin","check","execute","cancel"] {
   let line=json!({"id":"a","result":{"unexpected":true}}).to_string();
   assert_eq!(parse_reply(&line,"a",method,&mut false).unwrap_err(),"outcome_unknown");
  }
 }
 #[test] fn metadata_probe_schema_is_bounded_and_exact() {
  let good=json!({"protocol":1,"backend":"shadow-input-guard","sourceSha256":"a".repeat(64)});
  assert!(validate_identity(good.to_string().as_bytes()).is_ok());
  for bad in [json!({}),json!({"protocol":2,"backend":"shadow-input-guard","sourceSha256":"a".repeat(64)}),json!({"protocol":1,"backend":"other","sourceSha256":"a".repeat(64)}),json!({"protocol":1,"backend":"shadow-input-guard","sourceSha256":"z".repeat(64)})] { assert!(validate_identity(bad.to_string().as_bytes()).is_err()); }
  assert!(validate_identity(&vec![b' ';4097]).is_err());
 }
}
