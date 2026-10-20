use serde_json::{Value,json};
use std::sync::{OnceLock, mpsc, Mutex};
struct Command { value: Value, reply: mpsc::Sender<String> }
struct Owner { sender: mpsc::Sender<Command>, join: Mutex<Option<std::thread::JoinHandle<()>>> }
static OWNER: OnceLock<Result<Owner, ()>> = OnceLock::new();
pub fn run(value: Value) -> String {
 if value["method"] == "shutdown" { crate::input::cancel(); }
 let owner = OWNER.get_or_init(|| {
  let (sender, receiver) = mpsc::channel::<Command>();
  let join = std::thread::Builder::new().name("shadow-agent-desktop-owner".into()).spawn(move || {
   #[link(name="ole32")]
   unsafe extern "system" { fn CoInitializeEx(reserved:*const std::ffi::c_void, mode:u32)->i32; fn CoUninitialize(); }
   struct Apartment;
   impl Drop for Apartment { fn drop(&mut self) { unsafe { CoUninitialize(); } } }
   let hr = unsafe { CoInitializeEx(std::ptr::null(), 0) };
   if hr < 0 { return; }
   let apartment = Apartment;
   #[link(name="user32")]
   unsafe extern "system" { fn SetThreadDpiAwarenessContext(context: *mut std::ffi::c_void) -> *mut std::ffi::c_void; }
   struct Dpi(*mut std::ffi::c_void);
   impl Drop for Dpi { fn drop(&mut self) { unsafe { SetThreadDpiAwarenessContext(self.0); } } }
   let previous = unsafe { SetThreadDpiAwarenessContext((-4isize) as *mut std::ffi::c_void) };
   if previous.is_null() { return; }
   let dpi = Dpi(previous);
   let adapter = agent_desktop_windows::WindowsAdapter::new();
   let mut state = crate::windows::State::default();
   while let Ok(command) = receiver.recv() {
    if command.value["method"] == "shutdown" {
     let _ = command.reply.send(json!({"result":{"released":true}}).to_string()); break;
    }
    let response = crate::windows::dispatch(command.value, &adapter, &mut state).to_string();
    let _ = command.reply.send(response);
   }
   drop(state); drop(adapter); drop(dpi); drop(apartment);
  }).map_err(|_| ())?;
  Ok(Owner { sender, join: Mutex::new(Some(join)) })
 });
 let owner = match owner { Ok(owner)=>owner, Err(_)=>return crate::error("unavailable", "native owner could not start") };
 let shutdown = value["method"] == "shutdown";
 let (reply, receiver) = mpsc::channel();
 if owner.sender.send(Command { value, reply }).is_err() { return crate::error("unavailable", "native owner stopped"); }
 let response = receiver.recv().unwrap_or_else(|_|crate::error("unavailable", "native owner failed"));
 if shutdown {
  if let Ok(mut guard) = owner.join.lock() { if let Some(join) = guard.take() { let _ = join.join(); } }
 }
 response
}
