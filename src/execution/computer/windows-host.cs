using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace Shadow {
    public static class ComputerHost {
        private sealed class Failure : Exception {
            public readonly string Code;
            public readonly string Reason;
            public Failure(string code, string reason = null) { Code = code; Reason = reason; }
        }
        private sealed class Window {
            public string Id;
            public IntPtr Handle;
            public int Pid;
            public long Started;
            public string App;
            public DateTime Expires;
            public AutomationElement Root;
            public Snapshot Snapshot;
            public bool ForegroundInput;
        }
        private sealed class Snapshot {
            public string Id = Guid.NewGuid().ToString();
            public DateTime Created = DateTime.UtcNow;
            public string Signature;
            public Rect Bounds;
            public string FrameHash;
            public int FrameWidth, FrameHeight;
            public Dictionary<string, AutomationElement> Elements = new Dictionary<string, AutomationElement>();
            public List<string> Fingerprints = new List<string>();
            public int Characters;
            public Dictionary<string, object> Data;
        }
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 6 * 1024 * 1024, RecursionLimit = 64 };
        private static readonly Dictionary<string, Window> Candidates = new Dictionary<string, Window>();
        private static readonly Dictionary<string, Window> Targets = new Dictionary<string, Window>();
        private static readonly HashSet<string> Actions = new HashSet<string>();
        private static readonly HashSet<string> ExcludedApps = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "shadow", "electron", "chrome", "msedge", "brave", "firefox", "opera", "vivaldi", "iexplore", "ApplicationFrameHost"
        };
        private static int OwnerPid;
        private static bool EffectStarted;
        private static string InputSource;
        private static ForegroundInputBridge InputBridge;
        private static readonly object InputSync = new object();
        private static readonly ManualResetEvent Stopping = new ManualResetEvent(false);
        private const int ValueLimit = 2000;
        private delegate bool EnumWindow(IntPtr hwnd, IntPtr parameter);
        [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] private struct LastInput { public uint Size, Time; }
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
        [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, int size, out int needed);
        [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput info);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("advapi32.dll")] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll")] private static extern bool GetTokenInformation(IntPtr token, int kind, out int information, int length, out int needed);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

        private static void StopInput() {
            Stopping.Set();
            ForegroundInputBridge bridge;
            lock (InputSync) { bridge = InputBridge; InputBridge = null; }
            if (bridge != null) bridge.Dispose();
        }
        public static void Run(int ownerPid, string inputSource) {
            OwnerPid = ownerPid;
            InputSource = inputSource;
            var watchdog = new Thread(() => {
                try { using (Process owner = Process.GetProcessById(ownerPid)) { owner.WaitForExit(); } }
                finally { try { StopInput(); } finally { Environment.Exit(0); } }
            });
            watchdog.IsBackground = true;
            watchdog.Start();
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) throw new Failure("unavailable");
            var commands = new BlockingCollection<string>(1);
            var reader = new Thread(() => {
                try {
                    string command;
                    while ((command = Console.ReadLine()) != null) {
                        if (command.Length > 32 * 1024 || !commands.TryAdd(command, 100)) break;
                    }
                } finally { try { StopInput(); } finally { Environment.Exit(0); } }
            });
            reader.IsBackground = true;
            reader.Start();
            string line;
            while (!Stopping.WaitOne(0)) {
                if (!commands.TryTake(out line, 100)) continue;
                string id = "";
                EffectStarted = false;
                try {
                    if (line.Length > 32 * 1024) throw new Failure("invalid_request");
                    var input = Json.Deserialize<Dictionary<string, object>>(line);
                    id = Text(input, "id");
                    Guid parsed;
                    if (!Guid.TryParse(id, out parsed)) throw new Failure("invalid_request");
                    CheckDesktop();
                    object result;
                    switch (Text(input, "method")) {
                        case "list": result = List(input.ContainsKey("processId") ? Convert.ToInt32(input["processId"]) : 0); break;
                        case "bind": result = Bind(Text(input, "windowId"), input.ContainsKey("foregroundInput") && input["foregroundInput"] is bool && (bool)input["foregroundInput"]); break;
                        case "observe": {
                            Window window = Target(Text(input, "targetId"));
                            Snapshot snapshot = Observe(window, input.ContainsKey("screenshot") && input["screenshot"] is bool && (bool)input["screenshot"]);
                            window.Snapshot = snapshot;
                            result = snapshot.Data;
                            snapshot.Data = null;
                            break;
                        }
                        case "act": result = Act(input); break;
                        case "release": Targets.Remove(Text(input, "targetId")); result = new { released = true }; break;
                        default: throw new Failure("invalid_request");
                    }
                    Console.WriteLine(Json.Serialize(new { id = id, result = result }));
                    result = null;
                } catch (Exception error) {
                    var known = error as Failure;
                    var inputFailure = error as InputFailure;
                    string code = EffectStarted ? "outcome_unknown" : known != null ? known.Code : inputFailure != null ? inputFailure.Code : "host_failure";
                    string reason = known != null ? known.Reason ?? known.Code : inputFailure != null ? inputFailure.Reason ?? inputFailure.Code : "host_failure";
                    Console.WriteLine(Json.Serialize(new { id = id, error = new { code = code, reason = reason != code ? reason : null } }));
                }
                Console.Out.Flush();
            }
        }

        private static string Text(Dictionary<string, object> input, string key) {
            object value;
            if (!input.TryGetValue(key, out value) || !(value is string)) throw new Failure("invalid_request");
            return (string)value;
        }
        private static string Trim(string value, int maximum) {
            value = value ?? "";
            return value.Length > maximum ? value.Substring(0, maximum) : value;
        }
        private static string Fingerprint(string value) {
            using (SHA256 hash = SHA256.Create()) {
                return Convert.ToBase64String(hash.ComputeHash(Encoding.UTF8.GetBytes(value ?? "")));
            }
        }
        private static void CheckDesktop() {
            if (!Environment.UserInteractive || Process.GetCurrentProcess().SessionId == 0) throw new Failure("unavailable");
            IntPtr desktop = OpenInputDesktop(0, false, 1);
            if (desktop == IntPtr.Zero) throw new Failure("unavailable");
            try {
                int needed;
                var name = new StringBuilder(256);
                if (!GetUserObjectInformation(desktop, 2, name, 512, out needed) || !String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase))
                    throw new Failure("unavailable");
            } finally { CloseDesktop(desktop); }
        }
        private static void CheckProcess(Process process) {
            if (process.Id == OwnerPid || process.Id == Process.GetCurrentProcess().Id ||
                process.SessionId != Process.GetCurrentProcess().SessionId || ExcludedApps.Contains(process.ProcessName))
                throw new Failure("protected_target");
            IntPtr token;
            if (!OpenProcessToken(process.Handle, 8, out token)) throw new Failure("protected_target");
            try {
                int elevated, needed;
                if (!GetTokenInformation(token, 20, out elevated, 4, out needed) || elevated != 0)
                    throw new Failure("protected_target");
            } finally { CloseHandle(token); }
        }
        private static string Title(IntPtr handle) {
            var title = new StringBuilder(513);
            GetWindowText(handle, title, title.Capacity);
            return title.ToString();
        }
        private static object Bounds(IntPtr handle) {
            Rect rect;
            if (!GetWindowRect(handle, out rect)) throw new Failure("window_unavailable");
            return new { x = rect.Left, y = rect.Top, width = Math.Max(0, rect.Right - rect.Left), height = Math.Max(0, rect.Bottom - rect.Top) };
        }
        private static object Bounds(System.Windows.Rect rect) {
            return rect.IsEmpty ? new { x = 0.0, y = 0.0, width = 0.0, height = 0.0 }
                : new { x = rect.X, y = rect.Y, width = rect.Width, height = rect.Height };
        }
        private static object Describe(Window window, bool bounds) {
            var data = new Dictionary<string, object> {
                { "id", window.Id }, { "title", Title(window.Handle) }, { "app", window.App }, { "pid", window.Pid }
            };
            if (bounds) data["bounds"] = Bounds(window.Handle);
            return data;
        }
        private static object List(int processId) {
            Candidates.Clear();
            var windows = new List<object>();
            int excluded = 0;
            EnumWindows((handle, unused) => {
                uint pid;
                GetWindowThreadProcessId(handle, out pid);
                if (processId != 0 && processId != pid) return true;
                if (!IsWindowVisible(handle) || String.IsNullOrWhiteSpace(Title(handle))) return true;
                if (windows.Count >= 256) { excluded++; return true; }
                try {
                    using (Process process = Process.GetProcessById((int)pid)) {
                        CheckProcess(process);
                        var window = new Window {
                            Id = Guid.NewGuid().ToString(), Handle = handle, Pid = (int)pid,
                            Started = process.StartTime.ToUniversalTime().Ticks, App = Trim(process.ProcessName, 128),
                            Expires = DateTime.UtcNow.AddSeconds(30)
                        };
                        Candidates.Add(window.Id, window);
                        windows.Add(Describe(window, false));
                    }
                } catch { excluded++; }
                return true;
            }, IntPtr.Zero);
            return new { windows = windows, excluded = excluded };
        }
        private static void Validate(Window window) {
            CheckDesktop();
            uint pid;
            GetWindowThreadProcessId(window.Handle, out pid);
            if (!IsWindow(window.Handle) || !IsWindowVisible(window.Handle) || pid != window.Pid) throw new Failure("window_unavailable");
            using (Process process = Process.GetProcessById(window.Pid)) {
                CheckProcess(process);
                if (process.StartTime.ToUniversalTime().Ticks != window.Started) throw new Failure("window_unavailable");
            }
            if (window.Root != null && !Automation.Compare(window.Root, AutomationElement.FromHandle(window.Handle)))
                throw new Failure("window_unavailable");
        }
        private static object Bind(string id, bool foregroundInput) {
            Window window;
            if (!Candidates.TryGetValue(id, out window) || window.Expires < DateTime.UtcNow || Targets.Count >= 32)
                throw new Failure("window_unavailable");
            Validate(window);
            Candidates.Remove(id);
            window.Id = Guid.NewGuid().ToString();
            window.Root = AutomationElement.FromHandle(window.Handle);
            window.ForegroundInput = foregroundInput;
            Targets.Add(window.Id, window);
            return Describe(window, true);
        }
        private static Window Target(string id) {
            Window window;
            if (!Targets.TryGetValue(id, out window)) throw new Failure("window_unavailable");
            Validate(window);
            return window;
        }

        private static Snapshot Observe(Window window, bool screenshot) {
            Validate(window);
            if (IsIconic(window.Handle)) throw new Failure("window_unavailable");
            var snapshot = new Snapshot();
            if (!GetWindowRect(window.Handle, out snapshot.Bounds)) throw new Failure("window_unavailable");
            var nodes = new List<object>();
            bool truncated = false;
            Walk(window.Root, null, 0, snapshot, nodes, ref truncated);
            snapshot.Data = new Dictionary<string, object> {
                { "id", snapshot.Id }, { "targetId", window.Id }, { "title", Title(window.Handle) },
                { "bounds", Bounds(window.Handle) }, { "elements", nodes }, { "truncated", truncated }
            };
            snapshot.Signature = Fingerprint(Json.Serialize(new { title = snapshot.Data["title"], bounds = snapshot.Data["bounds"], elements = nodes, fingerprints = snapshot.Fingerprints, truncated = truncated }));
            if (screenshot) {
                var frame = Capture(window, snapshot.Bounds);
                snapshot.Data["screenshot"] = frame;
                snapshot.FrameHash = Fingerprint((string)frame["base64"]);
                snapshot.FrameWidth = (int)frame["width"];
                snapshot.FrameHeight = (int)frame["height"];
            }
            Rect after;
            if (!GetWindowRect(window.Handle, out after) || !after.Equals(snapshot.Bounds)) throw new Failure("stale_observation");
            Validate(window);
            return snapshot;
        }
        private static void Walk(AutomationElement element, string parent, int depth, Snapshot snapshot, List<object> nodes, ref bool truncated) {
            if (nodes.Count >= 200 || snapshot.Characters >= 32000 || depth > 20) { truncated = true; return; }
            var current = element.Current;
            string id = nodes.Count.ToString();
            bool secret = current.IsPassword;
            var actions = new List<string>();
            var data = new Dictionary<string, object> {
                { "id", id }, { "parentId", parent }, { "role", current.ControlType.ProgrammaticName },
                { "name", secret ? "[Protected field]" : Trim(current.Name, 512) },
                { "enabled", current.IsEnabled }, { "offscreen", current.IsOffscreen }, { "protected", secret },
                { "focusable", !secret && current.IsKeyboardFocusable },
                { "bounds", Bounds(current.BoundingRectangle) }, { "actions", actions }
            };
            object pattern;
            if (!secret) {
                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) {
                    var value = ((ValuePattern)pattern).Current;
                    string text = value.Value ?? "";
                    data["value"] = Trim(text, ValueLimit);
                    if (text.Length >= ValueLimit) truncated = true;
                    if (!value.IsReadOnly && current.ControlType == ControlType.Edit && text.Length < ValueLimit) actions.Add("set_value");
                } else if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) {
                    string text = ((TextPattern)pattern).DocumentRange.GetText(ValueLimit + 1);
                    data["value"] = Trim(text, ValueLimit);
                    if (text.Length > ValueLimit) truncated = true;
                }
                if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) actions.Add("invoke");
                if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) {
                    actions.Add("toggle");
                    data["toggleState"] = (int)((TogglePattern)pattern).Current.ToggleState;
                }
                if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) {
                    actions.Add("select");
                    data["selected"] = ((SelectionItemPattern)pattern).Current.IsSelected;
                }
                if (element.TryGetCurrentPattern(ScrollPattern.Pattern, out pattern)) actions.Add("scroll");
            }
            if (!current.IsEnabled || current.IsOffscreen) actions.Clear();
            snapshot.Elements.Add(id, element);
            snapshot.Fingerprints.Add(String.Join(",", element.GetRuntimeId()));
            nodes.Add(data);
            snapshot.Characters += Json.Serialize(data).Length;
            if (secret) return;
            AutomationElement child = TreeWalker.ControlViewWalker.GetFirstChild(element);
            while (child != null) {
                if (nodes.Count >= 200 || snapshot.Characters >= 32000) { truncated = true; break; }
                Walk(child, id, depth + 1, snapshot, nodes, ref truncated);
                child = TreeWalker.ControlViewWalker.GetNextSibling(child);
            }
        }
        private static Dictionary<string, object> Capture(Window window, Rect expected) {
            Rect rect;
            if (!GetWindowRect(window.Handle, out rect)) throw new Failure("capture_failed");
            if (!rect.Equals(expected)) throw new Failure("stale_observation");
            int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || (long)width * height > 16000000)
                throw new Failure("capture_failed");
            using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
                using (Graphics graphics = Graphics.FromImage(bitmap)) {
                    IntPtr dc = graphics.GetHdc();
                    try {
                        // Print only the selected window, never pixels from other windows covering it.
                        if (!PrintWindow(window.Handle, dc, 2)) throw new Failure("capture_failed");
                    } finally { graphics.ReleaseHdc(dc); }
                }
                double scale = Math.Min(1.0, 1600.0 / Math.Max(width, height));
                int outputWidth = Math.Max(1, (int)(width * scale)), outputHeight = Math.Max(1, (int)(height * scale));
                using (var output = new Bitmap(bitmap, outputWidth, outputHeight))
                using (var stream = new MemoryStream()) {
                    output.Save(stream, ImageFormat.Png);
                    if (stream.Length > 3 * 1024 * 1024) throw new Failure("capture_failed");
                    return new Dictionary<string, object> { { "mime", "image/png" }, { "base64", Convert.ToBase64String(stream.ToArray()) },
                        { "width", outputWidth }, { "height", outputHeight } };
                }
            }
        }
        private static void WaitForQuiet(Window window) {
            for (int attempt = 0; attempt < 20; attempt++) {
                if (GetForegroundWindow() != window.Handle) return;
                var info = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
                if (!GetLastInputInfo(ref info)) throw new Failure("unavailable");
                if (unchecked((uint)Environment.TickCount - info.Time) >= 300) return;
                Thread.Sleep(50);
            }
            throw new Failure("stale_observation");
        }
        private static object Act(Dictionary<string, object> input) {
            Window window = Target(Text(input, "targetId"));
            string actionId = Text(input, "actionId");
            if (Actions.Contains(actionId) || Actions.Count >= 10000) throw new Failure("stale_observation");
            Snapshot previous = window.Snapshot;
            window.Snapshot = null;
            if (previous == null || previous.Id != Text(input, "observationId") || previous.Created.AddMinutes(2) < DateTime.UtcNow)
                throw new Failure("stale_observation");
            object raw;
            if (!input.TryGetValue("action", out raw) || !(raw is Dictionary<string, object>)) throw new Failure("invalid_request");
            var action = (Dictionary<string, object>)raw;
            string kind = Text(action, "kind");
            bool pointer = kind == "click" || kind == "move" || kind == "drag" || kind == "wheel";
            bool foreground = pointer || kind == "press_key" || kind == "type_text";
            if (foreground && !window.ForegroundInput) throw new Failure("foreground_not_allowed");
            WaitForQuiet(window);
            Snapshot current = Observe(window, pointer);
            if (current.Signature != previous.Signature || pointer && (previous.FrameHash == null || current.FrameHash != previous.FrameHash))
                throw new Failure("stale_observation");
            Actions.Add(actionId);
            if (foreground) return ForegroundAct(window, previous, current, actionId, action, pointer);
            string elementId = Text(action, "elementId");
            AutomationElement element;
            if (!previous.Elements.TryGetValue(elementId, out element) ||
                !current.Elements.ContainsKey(elementId) || !Automation.Compare(element, current.Elements[elementId]))
                throw new Failure("stale_observation");
            var state = element.Current;
            if (state.IsPassword) throw new Failure("protected_target");
            if (!state.IsEnabled || state.IsOffscreen) throw new Failure("unsupported_action");
            object pattern;
            bool verified = false;
            switch (kind) {
                case "set_value":
                    string value = Text(action, "value");
                    if (value.Length > 4000 || value.IndexOf('\0') >= 0) throw new Failure("invalid_request");
                    if (state.ControlType != ControlType.Edit || !element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || ((ValuePattern)pattern).Current.IsReadOnly)
                        throw new Failure("unsupported_action");
                    // Some UIA providers truncate long values; never replace an incompletely observed field.
                    if ((((ValuePattern)pattern).Current.Value ?? "").Length >= ValueLimit) throw new Failure("unsupported_action");
                    EffectStarted = true;
                    ((ValuePattern)pattern).SetValue(value);
                    verified = ((ValuePattern)pattern).Current.Value == value;
                    break;
                case "invoke":
                    if (!element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) throw new Failure("unsupported_action");
                    EffectStarted = true;
                    ((InvokePattern)pattern).Invoke();
                    break;
                case "toggle":
                    if (!element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) throw new Failure("unsupported_action");
                    ToggleState before = ((TogglePattern)pattern).Current.ToggleState;
                    EffectStarted = true;
                    ((TogglePattern)pattern).Toggle();
                    verified = ((TogglePattern)pattern).Current.ToggleState != before;
                    break;
                case "select":
                    if (!element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) throw new Failure("unsupported_action");
                    EffectStarted = true;
                    ((SelectionItemPattern)pattern).Select();
                    verified = ((SelectionItemPattern)pattern).Current.IsSelected;
                    break;
                case "scroll":
                    if (!element.TryGetCurrentPattern(ScrollPattern.Pattern, out pattern)) throw new Failure("unsupported_action");
                    string direction = Text(action, "direction");
                    if (direction != "up" && direction != "down" && direction != "left" && direction != "right") throw new Failure("invalid_request");
                    var scroll = (ScrollPattern)pattern;
                    double horizontal = scroll.Current.HorizontalScrollPercent, vertical = scroll.Current.VerticalScrollPercent;
                    EffectStarted = true;
                    scroll.Scroll(direction == "left" ? ScrollAmount.SmallDecrement : direction == "right" ? ScrollAmount.SmallIncrement : ScrollAmount.NoAmount,
                        direction == "up" ? ScrollAmount.SmallDecrement : direction == "down" ? ScrollAmount.SmallIncrement : ScrollAmount.NoAmount);
                    verified = horizontal != scroll.Current.HorizontalScrollPercent || vertical != scroll.Current.VerticalScrollPercent;
                    break;
                default: throw new Failure("unsupported_action");
            }
            Snapshot after = Observe(window, false);
            window.Snapshot = after;
            var observed = after.Data;
            after.Data = null;
            return new { actionId = actionId, outcome = "executed", verified = verified, observation = observed };
        }
        private static ForegroundInputBridge Input() {
            lock (InputSync) {
                if (Stopping.WaitOne(0)) throw new Failure("user_interrupted");
                if (InputBridge == null) InputBridge = new ForegroundInputBridge(InputSource);
                return InputBridge;
            }
        }
        private static Dictionary<string, object> InputRequest(ForegroundInputBridge bridge, string method, object payload) {
            var reply = bridge.Request(method, payload);
            object error;
            if (reply.TryGetValue("error", out error)) {
                var failure = error as Dictionary<string, object>;
                if (failure == null || !failure.ContainsKey("effectStarted") || !(failure["effectStarted"] is bool))
                    throw new Failure("outcome_unknown");
                EffectStarted = (bool)failure["effectStarted"];
                throw new Failure(Text(failure, "code"), failure.ContainsKey("reason") && failure["reason"] is string ? (string)failure["reason"] : null);
            }
            object result;
            if (!reply.TryGetValue("result", out result) || !(result is Dictionary<string, object>)) throw new Failure("outcome_unknown");
            return (Dictionary<string, object>)result;
        }
        private static InputPoint Point(Snapshot snapshot, Dictionary<string, object> action, string x, string y) {
            if (!action.ContainsKey(x) || !(action[x] is int) || !action.ContainsKey(y) || !(action[y] is int)) throw new Failure("invalid_request");
            return InputLease.Map((int)action[x], (int)action[y], snapshot.FrameWidth, snapshot.FrameHeight,
                new InputRect { Left = snapshot.Bounds.Left, Top = snapshot.Bounds.Top, Right = snapshot.Bounds.Right, Bottom = snapshot.Bounds.Bottom });
        }
        private static void CheckAncestry(Window window, AutomationElement element, AutomationElement required) {
            bool found = required == null;
            for (int depth = 0; element != null && depth < 64; depth++) {
                if (element.Current.IsPassword) throw new Failure("protected_target");
                if (required != null && Automation.Compare(element, required)) found = true;
                if (Automation.Compare(element, window.Root)) {
                    if (!found) throw new Failure("keyboard_focus_changed");
                    return;
                }
                element = TreeWalker.RawViewWalker.GetParent(element);
            }
            throw new Failure("input_outside_window");
        }
        private static object ForegroundAct(Window window, Snapshot previous, Snapshot current, string actionId, Dictionary<string, object> action, bool pointer) {
            AutomationElement element = null;
            string kind = Text(action, "kind");
            InputPoint start = new InputPoint(), end = new InputPoint();
            if (pointer) {
                start = Point(previous, action, "x", "y");
                end = kind == "drag" ? Point(previous, action, "toX", "toY") : start;
            } else {
                string id = Text(action, "elementId");
                if (!previous.Elements.TryGetValue(id, out element) || !current.Elements.ContainsKey(id) || !Automation.Compare(element, current.Elements[id]))
                    throw new Failure("stale_observation");
                var state = element.Current;
                if (state.IsPassword) throw new Failure("protected_target");
                if (!state.IsEnabled || state.IsOffscreen || !state.IsKeyboardFocusable) throw new Failure("unsupported_action");
                object pattern;
                if (kind == "type_text" && (state.ControlType != ControlType.Edit && state.ControlType != ControlType.Document
                    || element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && ((ValuePattern)pattern).Current.IsReadOnly))
                    throw new Failure("unsupported_action");
                CheckAncestry(window, element, element);
            }
            ForegroundInputBridge bridge = Input();
            bool active = true;
            object restored = null;
            try {
                var begin = InputRequest(bridge, "begin", new { handle = window.Handle.ToInt64().ToString(), pid = window.Pid, started = window.Started.ToString(),
                    bounds = new { left = previous.Bounds.Left, top = previous.Bounds.Top, right = previous.Bounds.Right, bottom = previous.Bounds.Bottom } });
                if (!begin.ContainsKey("activated") || !(begin["activated"] is bool)) throw new Failure("input_unavailable");
                InputRequest(bridge, "activation", new { });
                if (element != null) {
                    AutomationElement focusedElement = (bool)begin["activated"] ? AutomationElement.FocusedElement : null;
                    if (focusedElement == null || !Automation.Compare(focusedElement, element)) element.SetFocus();
                }
                else if (!(bool)begin["activated"]) window.Root.SetFocus();
                InputRequest(bridge, "check", new { });
                Snapshot focused = Observe(window, false);
                if (focused.Signature != previous.Signature) throw new Failure("stale_observation");
                if (pointer) {
                    CheckAncestry(window, AutomationElement.FromPoint(new System.Windows.Point(start.X, start.Y)), null);
                    if (kind == "drag") CheckAncestry(window, AutomationElement.FromPoint(new System.Windows.Point(end.X, end.Y)), null);
                } else CheckAncestry(window, AutomationElement.FocusedElement, element);
                IntPtr focus = pointer ? IntPtr.Zero : new InputEnvironment().Focus(window.Handle);
                // An absent/malformed execute reply cannot prove that no OS input was delivered.
                EffectStarted = true;
                var result = InputRequest(bridge, "execute", new { action = action, x = start.X, y = start.Y, toX = end.X, toY = end.Y, focus = focus.ToInt64().ToString() });
                active = false;
                if (!result.TryGetValue("focusRestored", out restored) || restored != null && !(restored is bool))
                    throw new Failure("outcome_unknown");
            } finally {
                if (active) {
                    try { InputRequest(bridge, "cancel", new { }); }
                    catch { EffectStarted = true; throw new Failure("outcome_unknown"); }
                }
            }
            Snapshot after = Observe(window, false);
            window.Snapshot = after;
            var observed = after.Data;
            after.Data = null;
            return new { actionId = actionId, outcome = "executed", verified = false, focusRestored = restored, observation = observed };
        }
    }
}
