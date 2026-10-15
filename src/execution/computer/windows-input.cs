namespace Shadow {
    using System;
    using System.Collections.Generic;
    using System.Collections.Concurrent;
    using System.Diagnostics;
    using System.Globalization;
    using System.IO;
    using System.Runtime.InteropServices;
    using System.Security.Cryptography;
    using System.Text;
    using System.Threading;
    using System.Web.Script.Serialization;

    internal sealed class InputFailure : Exception {
        internal readonly string Code;
        internal readonly string Reason;
        internal InputFailure(string code, string reason = null) { Code = code; Reason = reason; }
    }
    [StructLayout(LayoutKind.Sequential)] internal struct InputPoint {
        internal int X, Y;
        internal InputPoint(int x, int y) { X = x; Y = y; }
    }
    [StructLayout(LayoutKind.Sequential)] internal struct InputRect {
        internal int Left, Top, Right, Bottom;
        internal bool Contains(InputPoint point) { return point.X >= Left && point.X < Right && point.Y >= Top && point.Y < Bottom; }
    }
    [StructLayout(LayoutKind.Sequential)] internal struct MousePacket {
        internal int X, Y;
        internal uint Data, Flags, Time;
        internal UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct KeyPacket {
        internal ushort Key, Scan;
        internal uint Flags, Time;
        internal UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Explicit)] internal struct PacketData {
        [FieldOffset(0)] internal MousePacket Mouse;
        [FieldOffset(0)] internal KeyPacket Keyboard;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct InputPacket {
        internal uint Type;
        internal PacketData Data;
    }
    internal sealed class InputWindow {
        internal IntPtr Handle;
        internal int Pid;
        internal long Started;
        internal InputRect Bounds;
    }
    internal interface InputMonitor : IDisposable { bool Interrupted { get; } string Reason { get; } }

    internal class InputEnvironment {
        [StructLayout(LayoutKind.Sequential)] private struct LastInput { internal uint Size, Time; }
        [StructLayout(LayoutKind.Sequential)] private struct GuiThread {
            internal uint Size, Flags;
            internal IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
            internal InputRect CaretRect;
        }
        [DllImport("user32.dll")] private static extern uint SendInput(uint count, InputPacket[] packets, int size);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool GetCursorPos(out InputPoint point);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr handle, out InputRect rect);
        [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr handle, out InputRect rect);
        [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr handle, ref InputPoint point);
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(InputPoint point);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr handle, uint kind);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr handle);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
        [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThread info);
        [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput info);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, int size, out int needed);

        internal virtual uint Tick { get { return unchecked((uint)Environment.TickCount); } }
        internal virtual void Sleep(int milliseconds) { Thread.Sleep(milliseconds); }
        internal virtual uint LastActivity {
            get {
                var info = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
                if (!GetLastInputInfo(ref info)) throw new InputFailure("input_unavailable");
                return info.Time;
            }
        }
        internal virtual IntPtr Foreground { get { return GetForegroundWindow(); } }
        internal virtual IntPtr Focus(IntPtr window) {
            uint pid;
            uint thread = GetWindowThreadProcessId(window, out pid);
            var info = new GuiThread { Size = (uint)Marshal.SizeOf(typeof(GuiThread)) };
            if (thread == 0 || !GetGUIThreadInfo(thread, ref info) || info.Focus == IntPtr.Zero || GetAncestor(info.Focus, 2) != window)
                throw new InputFailure("keyboard_focus_changed");
            return info.Focus;
        }
        internal virtual bool Activate(IntPtr window) { return SetForegroundWindow(window); }
        internal virtual InputPoint Cursor {
            get {
                InputPoint point;
                if (!GetCursorPos(out point)) throw new InputFailure("input_unavailable");
                return point;
            }
        }
        internal virtual InputRect Screen {
            get {
                int x = GetSystemMetrics(76), y = GetSystemMetrics(77);
                return new InputRect { Left = x, Top = y, Right = x + GetSystemMetrics(78), Bottom = y + GetSystemMetrics(79) };
            }
        }
        internal virtual InputMonitor Monitor(UIntPtr marker) { return new PhysicalInputMonitor(marker); }
        internal virtual uint Emit(InputPacket[] packets) { return SendInput((uint)packets.Length, packets, Marshal.SizeOf(typeof(InputPacket))); }
        internal virtual void CheckHeldInput() {
            for (int key = 1; key < 256; key++)
                if ((GetAsyncKeyState(key) & 0x8000) != 0) throw new InputFailure("user_interrupted");
        }
        internal virtual void CheckDesktop() {
            if (!Environment.UserInteractive || Process.GetCurrentProcess().SessionId == 0) throw new InputFailure("unavailable");
            IntPtr desktop = OpenInputDesktop(0, false, 1);
            if (desktop == IntPtr.Zero) throw new InputFailure("unavailable");
            try {
                int needed;
                var name = new StringBuilder(256);
                if (!GetUserObjectInformation(desktop, 2, name, 512, out needed) || !String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase))
                    throw new InputFailure("unavailable");
            } finally { CloseDesktop(desktop); }
        }
        internal virtual void Validate(InputWindow window) {
            CheckDesktop();
            uint pid;
            InputRect rect;
            GetWindowThreadProcessId(window.Handle, out pid);
            if (pid != window.Pid || !IsWindowVisible(window.Handle) || IsIconic(window.Handle)
                || !GetWindowRect(window.Handle, out rect) || !rect.Equals(window.Bounds))
                throw new InputFailure("stale_observation");
            using (Process process = Process.GetProcessById(window.Pid)) {
                if (process.StartTime.ToUniversalTime().Ticks != window.Started
                    || process.SessionId != Process.GetCurrentProcess().SessionId)
                    throw new InputFailure("window_unavailable");
            }
        }
        internal virtual void CheckPoint(InputWindow window, InputPoint point) {
            InputRect client;
            var origin = new InputPoint(0, 0);
            if (!GetClientRect(window.Handle, out client) || !ClientToScreen(window.Handle, ref origin))
                throw new InputFailure("window_unavailable");
            client.Left += origin.X; client.Right += origin.X;
            client.Top += origin.Y; client.Bottom += origin.Y;
            if (!client.Contains(point) || GetAncestor(WindowFromPoint(point), 2) != window.Handle)
                throw new InputFailure("input_outside_window");
        }
    }

    internal sealed class PhysicalInputMonitor : InputMonitor {
        [StructLayout(LayoutKind.Sequential)] private struct Message {
            internal IntPtr Window;
            internal uint Id;
            internal UIntPtr WParam;
            internal IntPtr LParam;
            internal uint Time;
            internal InputPoint Point;
            internal uint Private;
        }
        [StructLayout(LayoutKind.Sequential)] private struct MouseHook {
            internal InputPoint Point;
            internal uint Data, Flags, Time;
            internal UIntPtr Extra;
        }
        [StructLayout(LayoutKind.Sequential)] private struct KeyHook {
            internal uint Key, Scan, Flags, Time;
            internal UIntPtr Extra;
        }
        private delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
        [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int kind, Hook callback, IntPtr module, uint thread);
        [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
        [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint minimum, uint maximum);
        [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint minimum, uint maximum, uint remove);
        [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
        private readonly Thread thread;
        private readonly ManualResetEvent ready = new ManualResetEvent(false);
        private readonly Hook mouse, keyboard;
        private uint threadId;
        private bool installed;
        private int interruption;
        private volatile bool stopped;
        public bool Interrupted { get { return Volatile.Read(ref interruption) != 0; } }
        public string Reason {
            get {
                switch (Volatile.Read(ref interruption)) {
                    case 1: return "keyboard_input_detected";
                    case 2: return "mouse_input_detected";
                    case 3: return "foreign_input_detected";
                    case 4: return "input_tag_changed";
                    default: return null;
                }
            }
        }
        private void Interrupt(bool injected, UIntPtr extra, UIntPtr marker, int physicalKind) {
            if (injected && extra == marker) return;
            int cause = !injected ? physicalKind
                : (uint)extra.ToUInt64() == (uint)marker.ToUInt64() ? 4 : 3;
            Interlocked.CompareExchange(ref interruption, cause, 0);
        }

        internal PhysicalInputMonitor(UIntPtr marker) {
            // Keep only the first interruption category, never key contents or an event history.
            mouse = (code, message, data) => {
                if (code >= 0) {
                    var value = (MouseHook)Marshal.PtrToStructure(data, typeof(MouseHook));
                    Interrupt((value.Flags & 1) != 0, value.Extra, marker, 2);
                }
                return CallNextHookEx(IntPtr.Zero, code, message, data);
            };
            keyboard = (code, message, data) => {
                if (code >= 0) {
                    var value = (KeyHook)Marshal.PtrToStructure(data, typeof(KeyHook));
                    Interrupt((value.Flags & 16) != 0, value.Extra, marker, 1);
                }
                return CallNextHookEx(IntPtr.Zero, code, message, data);
            };
            thread = new Thread(() => {
                IntPtr mouseHandle = IntPtr.Zero, keyHandle = IntPtr.Zero;
                try {
                    threadId = GetCurrentThreadId();
                    Message pending;
                    PeekMessage(out pending, IntPtr.Zero, 0, 0, 0);
                    mouseHandle = SetWindowsHookEx(14, mouse, GetModuleHandle(null), 0);
                    keyHandle = SetWindowsHookEx(13, keyboard, GetModuleHandle(null), 0);
                    installed = mouseHandle != IntPtr.Zero && keyHandle != IntPtr.Zero;
                    ready.Set();
                    if (installed && !stopped) while (GetMessage(out pending, IntPtr.Zero, 0, 0) > 0 && !stopped) { }
                } finally {
                    if (mouseHandle != IntPtr.Zero) UnhookWindowsHookEx(mouseHandle);
                    if (keyHandle != IntPtr.Zero) UnhookWindowsHookEx(keyHandle);
                    ready.Set();
                }
            });
            thread.IsBackground = true;
            thread.Start();
            if (!ready.WaitOne(2000) || !installed) {
                Dispose();
                throw new InputFailure("input_unavailable");
            }
        }
        public void Dispose() {
            stopped = true;
            if (threadId != 0) PostThreadMessage(threadId, 0x0012, UIntPtr.Zero, IntPtr.Zero);
            thread.Join(1000);
        }
    }

    internal sealed class InputLease : IDisposable {
        private readonly InputEnvironment environment;
        private readonly InputWindow window;
        private readonly Func<bool> cancelled;
        private readonly UIntPtr marker;
        private readonly List<InputPacket> releases = new List<InputPacket>();
        private readonly object inputLock = new object();
        private InputMonitor monitor;
        private IntPtr previous;
        private IntPtr focus;
        private InputPoint cursor;
        private uint started;
        private bool moved, closed;
        internal bool EffectStarted;
        internal bool? FocusRestored;

        internal InputLease(InputEnvironment environment, InputWindow window, Func<bool> cancelled, UIntPtr marker) {
            this.environment = environment; this.window = window; this.cancelled = cancelled; this.marker = marker;
        }
        internal bool Begin() {
            environment.Validate(window);
            uint waiting = environment.Tick;
            while (unchecked(environment.Tick - environment.LastActivity) < 500) {
                if (cancelled() || unchecked(environment.Tick - waiting) >= 2000) throw new InputFailure("user_interrupted");
                environment.Sleep(25);
            }
            environment.CheckHeldInput();
            uint activity = environment.LastActivity;
            previous = environment.Foreground;
            cursor = environment.Cursor;
            monitor = environment.Monitor(marker);
            started = environment.Tick;
            if (activity != environment.LastActivity || monitor.Interrupted || cancelled()) throw new InputFailure("user_interrupted", monitor.Reason);
            return environment.Foreground == window.Handle || environment.Activate(window.Handle) && AwaitForeground(window.Handle, previous, 500, false);
        }
        private bool AwaitForeground(IntPtr expected, IntPtr initial, int timeout, bool restoring) {
            uint waiting = environment.Tick;
            while (environment.Foreground != expected) {
                IntPtr current = environment.Foreground;
                if (monitor.Interrupted || !restoring && Expired || unchecked(environment.Tick - waiting) >= timeout
                    || current != IntPtr.Zero && current != initial && current != expected) return false;
                if (!restoring) environment.Validate(window);
                environment.Sleep(10);
            }
            return !monitor.Interrupted && (restoring || !Expired);
        }
        internal void ConfirmForeground() {
            Check(false);
            // Cross-input-queue activation is asynchronous; wait, but never activate repeatedly.
            if (!AwaitForeground(window.Handle, previous, 500, false)) { Check(false); throw new InputFailure("focus_denied"); }
            Check();
        }
        internal bool Expired { get { return cancelled() || unchecked(environment.Tick - started) > 10000; } }
        internal void Check(bool requireForeground = true) {
            if (closed || cancelled()) throw new InputFailure("user_interrupted", "input_cancelled");
            if (unchecked(environment.Tick - started) > 10000) throw new InputFailure("user_interrupted", "input_lease_expired");
            if (monitor == null) throw new InputFailure("input_unavailable");
            if (monitor.Interrupted) throw new InputFailure("user_interrupted", monitor.Reason);
            environment.Validate(window);
            if (requireForeground && environment.Foreground != window.Handle) throw new InputFailure("focus_denied");
            if (focus != IntPtr.Zero && environment.Focus(window.Handle) != focus) throw new InputFailure("keyboard_focus_changed");
        }
        internal void RequireFocus(IntPtr expected) {
            if (expected == IntPtr.Zero) throw new InputFailure("keyboard_focus_changed");
            focus = expected;
            Check();
        }
        internal void Point(InputPoint point) { Check(); environment.CheckPoint(window, point); }
        internal static InputPoint Map(int x, int y, int width, int height, InputRect bounds) {
            if (width <= 0 || height <= 0 || x < 0 || y < 0 || x >= width || y >= height
                || bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top) throw new InputFailure("invalid_request");
            return new InputPoint(bounds.Left + (int)Math.Floor((x + 0.5) * (bounds.Right - bounds.Left) / width),
                bounds.Top + (int)Math.Floor((y + 0.5) * (bounds.Bottom - bounds.Top) / height));
        }
        private InputPacket Key(ushort key, bool up, ushort unicode) {
            return new InputPacket { Type = 1, Data = new PacketData { Keyboard = new KeyPacket {
                Key = key, Scan = unicode, Flags = (unicode != 0 ? 4u : Extended(key) ? 1u : 0u) | (up ? 2u : 0u), Extra = marker
            } } };
        }
        private static bool Extended(ushort key) { return key >= 0x21 && key <= 0x28 || key == 0x2D || key == 0x2E; }
        private InputPacket Mouse(uint flags, uint data) {
            return new InputPacket { Type = 0, Data = new PacketData { Mouse = new MousePacket { Flags = flags, Data = data, Extra = marker } } };
        }
        private InputPacket Move(InputPoint point) {
            InputRect screen = environment.Screen;
            if (!screen.Contains(point) || screen.Right - screen.Left < 2 || screen.Bottom - screen.Top < 2)
                throw new InputFailure("input_outside_window");
            InputPacket packet = Mouse(0xC001, 0);
            packet.Data.Mouse.X = (int)Math.Round((point.X - screen.Left) * 65535.0 / (screen.Right - screen.Left - 1));
            packet.Data.Mouse.Y = (int)Math.Round((point.Y - screen.Top) * 65535.0 / (screen.Bottom - screen.Top - 1));
            return packet;
        }
        private static bool SameKey(InputPacket left, InputPacket right) {
            return left.Type == right.Type && (left.Type == 1
                ? left.Data.Keyboard.Key == right.Data.Keyboard.Key && left.Data.Keyboard.Scan == right.Data.Keyboard.Scan
                : left.Data.Mouse.Flags == right.Data.Mouse.Flags);
        }
        private void Track(InputPacket packet) {
            InputPacket release = packet;
            bool down;
            if (packet.Type == 1) {
                down = (packet.Data.Keyboard.Flags & 2) == 0;
                release.Data.Keyboard.Flags |= 2;
            } else {
                uint flags = packet.Data.Mouse.Flags;
                if ((flags & (2 | 8 | 32)) != 0) { down = true; release.Data.Mouse.Flags = flags << 1; }
                else if ((flags & (4 | 16 | 64)) != 0) down = false;
                else return;
            }
            if (down) releases.Add(release);
            else releases.RemoveAll(value => SameKey(value, release));
        }
        private void Emit(params InputPacket[] packets) {
            Check();
            lock (inputLock) {
                if (closed || cancelled()) throw new InputFailure("user_interrupted", "input_cancelled");
                if (monitor.Interrupted) throw new InputFailure("user_interrupted", monitor.Reason);
                EffectStarted = true;
                uint count = environment.Emit(packets);
                for (int i = 0; i < Math.Min((int)count, packets.Length); i++) Track(packets[i]);
                if (count != packets.Length) throw new InputFailure("outcome_unknown");
            }
        }
        private static string Text(Dictionary<string, object> input, string key) {
            object value;
            if (!input.TryGetValue(key, out value) || !(value is string)) throw new InputFailure("invalid_request");
            return (string)value;
        }
        private static int Integer(Dictionary<string, object> input, string key, int minimum, int maximum) {
            object value;
            if (!input.TryGetValue(key, out value) || !(value is int) || (int)value < minimum || (int)value > maximum)
                throw new InputFailure("invalid_request");
            return (int)value;
        }
        private static ushort VirtualKey(string key) {
            if (key.Length == 1 && (key[0] >= 'A' && key[0] <= 'Z' || key[0] >= '0' && key[0] <= '9')) return key[0];
            for (int i = 1; i <= 12; i++) if (key == "F" + i) return (ushort)(0x6F + i);
            switch (key) {
                case "ENTER": return 0x0D; case "TAB": return 0x09; case "ESCAPE": return 0x1B; case "SPACE": return 0x20;
                case "BACKSPACE": return 0x08; case "DELETE": return 0x2E; case "INSERT": return 0x2D;
                case "HOME": return 0x24; case "END": return 0x23; case "PAGE_UP": return 0x21; case "PAGE_DOWN": return 0x22;
                case "ARROW_UP": return 0x26; case "ARROW_DOWN": return 0x28; case "ARROW_LEFT": return 0x25; case "ARROW_RIGHT": return 0x27;
                default: throw new InputFailure("invalid_request");
            }
        }
        private static List<ushort> Modifiers(Dictionary<string, object> action) {
            var result = new List<ushort>();
            object raw;
            if (!action.TryGetValue("modifiers", out raw) || !(raw is System.Collections.IEnumerable) || raw is string)
                throw new InputFailure("invalid_request");
            foreach (object value in (System.Collections.IEnumerable)raw) {
                ushort key = value as string == "CTRL" ? (ushort)0x11 : value as string == "ALT" ? (ushort)0x12 : value as string == "SHIFT" ? (ushort)0x10 : (ushort)0;
                if (key == 0 || result.Contains(key) || result.Count >= 3) throw new InputFailure("invalid_request");
                result.Add(key);
            }
            return result;
        }
        internal void Execute(Dictionary<string, object> action, InputPoint start, InputPoint end) {
            Check();
            string kind = Text(action, "kind");
            if (kind == "type_text") {
                string text = Text(action, "text");
                if (text.Length == 0 || text.Length > 1000) throw new InputFailure("invalid_request");
                for (int i = 0; i < text.Length; i++) {
                    if (Char.IsControl(text[i]) || Char.IsLowSurrogate(text[i]) || text[i] == '\u2028' || text[i] == '\u2029') throw new InputFailure("invalid_request");
                    if (Char.IsHighSurrogate(text[i])) {
                        if (i + 1 >= text.Length || !Char.IsLowSurrogate(text[++i])) throw new InputFailure("invalid_request");
                    }
                }
                for (int i = 0; i < text.Length; i++) {
                    var packets = new List<InputPacket> { Key(0, false, text[i]), Key(0, true, text[i]) };
                    if (Char.IsHighSurrogate(text[i])) { i++; packets.Add(Key(0, false, text[i])); packets.Add(Key(0, true, text[i])); }
                    Emit(packets.ToArray());
                    environment.Sleep(2);
                }
                return;
            }
            if (kind == "move") { Point(start); moved = true; Emit(Move(start)); return; }
            List<ushort> modifiers = Modifiers(action);
            var down = new List<InputPacket>();
            var up = new List<InputPacket>();
            foreach (ushort modifier in modifiers) down.Add(Key(modifier, false, 0));
            for (int i = modifiers.Count - 1; i >= 0; i--) up.Add(Key(modifiers[i], true, 0));
            if (kind == "press_key") {
                string key = Text(action, "key");
                bool alt = modifiers.Contains(0x12), ctrl = modifiers.Contains(0x11);
                if (alt && (key == "TAB" || key == "ESCAPE" || key == "SPACE" || key == "F6")
                    || ctrl && key == "ESCAPE" || ctrl && alt && key == "DELETE") throw new InputFailure("unsupported_shortcut");
                ushort code = VirtualKey(key);
                down.Add(Key(code, false, 0)); down.Add(Key(code, true, 0)); down.AddRange(up);
                Emit(down.ToArray());
                return;
            }
            if (kind != "click" && kind != "drag" && kind != "wheel") throw new InputFailure("invalid_request");
            uint buttonFlag = 0;
            int count = 0, steps = 0, duration = 0;
            string axis = "";
            if (kind == "click") {
                string button = Text(action, "button");
                buttonFlag = button == "left" ? 2u : button == "right" ? 8u : button == "middle" ? 32u : 0u;
                if (buttonFlag == 0) throw new InputFailure("invalid_request");
                count = Integer(action, "count", 1, 2);
            } else if (kind == "wheel") {
                steps = Integer(action, "steps", -10, 10);
                axis = Text(action, "axis");
                if (steps == 0 || axis != "vertical" && axis != "horizontal") throw new InputFailure("invalid_request");
            } else {
                duration = Integer(action, "durationMs", 100, 800);
                if (start.Equals(end)) throw new InputFailure("invalid_request");
            }
            Point(start);
            if (kind == "drag") Point(end);
            moved = true;
            Emit(Move(start));
            environment.Sleep(20);
            Point(start);
            if (kind == "click") {
                for (int i = 0; i < count; i++) { down.Add(Mouse(buttonFlag, 0)); down.Add(Mouse(buttonFlag << 1, 0)); }
                down.AddRange(up); Emit(down.ToArray());
            } else if (kind == "wheel") {
                down.Add(Mouse(axis == "vertical" ? 0x800u : 0x1000u, unchecked((uint)(steps * (axis == "vertical" ? -120 : 120)))));
                down.AddRange(up); Emit(down.ToArray());
            } else {
                down.Add(Mouse(2, 0)); Emit(down.ToArray());
                steps = Math.Max(2, duration / 20);
                for (int i = 1; i <= steps; i++) {
                    environment.Sleep(duration / steps);
                    var point = new InputPoint(start.X + (int)Math.Round((end.X - start.X) * i / (double)steps),
                        start.Y + (int)Math.Round((end.Y - start.Y) * i / (double)steps));
                    Point(point); Emit(Move(point));
                }
                up.Insert(0, Mouse(4, 0)); Emit(up.ToArray());
            }
        }
        internal void ReleaseHeld() {
            lock (inputLock) {
                if (releases.Count == 0) return;
                InputPacket[] packets = releases.ToArray();
                Array.Reverse(packets);
                uint sent = environment.Emit(packets);
                for (int i = 0; i < Math.Min((int)sent, packets.Length); i++) releases.RemoveAll(value => SameKey(value, packets[i]));
                if (sent != packets.Length) throw new InputFailure("outcome_unknown");
            }
        }
        public void Dispose() {
            if (closed) { ReleaseHeld(); return; }
            closed = true;
            try {
                ReleaseHeld();
                // Never steal focus or move the pointer back after another actor takes over.
                if (monitor != null && !monitor.Interrupted && environment.Foreground == window.Handle) {
                    if (moved) {
                        InputPacket packet = Move(cursor);
                        if (environment.Emit(new[] { packet }) != 1) throw new InputFailure("outcome_unknown");
                    }
                    if (!monitor.Interrupted && environment.Foreground == window.Handle)
                        FocusRestored = previous == window.Handle || previous != IntPtr.Zero && environment.Activate(previous) && AwaitForeground(previous, window.Handle, 250, true);
                }
            } finally { if (monitor != null) monitor.Dispose(); }
        }
    }

    internal sealed class ForegroundInputBridge : IDisposable {
        private readonly Process process;
        private readonly StreamWriter writer;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 65536 };
        private int disposed;
        internal ForegroundInputBridge(string source) {
            string command = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false); [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); "
                + "Add-Type -TypeDefinition ([IO.File]::ReadAllText('" + source.Replace("'", "''") + "')) -ReferencedAssemblies @('System','System.Core','System.Web.Extensions'); "
                + "[Shadow.ForegroundInputHost]::Run(" + Process.GetCurrentProcess().Id + ")";
            process = new Process { StartInfo = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows", @"System32\WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoLogo -NoProfile -NonInteractive -Mta -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(command)),
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false)
            } };
            process.ErrorDataReceived += (sender, args) => { };
            if (!process.Start()) throw new InputFailure("input_unavailable");
            process.BeginErrorReadLine();
            writer = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true };
        }
        internal Dictionary<string, object> Request(string method, object payload) {
            if (disposed != 0) throw new InputFailure("input_unavailable");
            string id = Guid.NewGuid().ToString();
            writer.WriteLine(json.Serialize(new { id = id, method = method, payload = payload }));
            string line = process.StandardOutput.ReadLine();
            if (line == null || line.Length > 65536) throw new InputFailure("input_unavailable");
            var response = json.Deserialize<Dictionary<string, object>>(line);
            if (!response.ContainsKey("id") || !Object.Equals(response["id"], id)) throw new InputFailure("input_unavailable");
            return response;
        }
        public void Dispose() {
            if (Interlocked.Exchange(ref disposed, 1) != 0) return;
            writer.Close();
            // Closing the pipe asks the independent guard to release input even if UIA is hung.
            process.WaitForExit(1500);
            process.Dispose();
        }
    }

    public static class ForegroundInputHost {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536 };
        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        internal static UIntPtr CreateMarker(RandomNumberGenerator random) {
            // Mouse/input bridges can narrow or sign-extend extra-info tags. Keep strict
            // equality, but generate a nonzero tag that survives both 32- and 64-bit paths.
            var bytes = new byte[4];
            uint value;
            do { random.GetBytes(bytes); value = BitConverter.ToUInt32(bytes, 0) & 0x7FFFFFFF; } while (value == 0);
            return new UIntPtr(value);
        }
        public static void Run(int ownerPid) {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) throw new InputFailure("input_unavailable");
            var cancelled = new ManualResetEvent(false);
            var commands = new BlockingCollection<string>(1);
            InputLease lease = null;
            Action cancel = () => {
                cancelled.Set();
                InputLease active = Volatile.Read(ref lease);
                if (active != null) {
                    try { active.ReleaseHeld(); }
                    catch (Exception) { Console.Error.WriteLine("outcome_unknown: input release failed"); }
                }
            };
            var reader = new Thread(() => {
                try {
                    string line;
                    while ((line = Console.ReadLine()) != null) {
                        if (line.Length > 32768 || !commands.TryAdd(line, 100)) break;
                    }
                } finally { cancel(); commands.CompleteAdding(); }
            });
            reader.IsBackground = true; reader.Start();
            var watchdog = new Thread(() => {
                try { using (Process owner = Process.GetProcessById(ownerPid)) { owner.WaitForExit(); } }
                finally {
                    cancel();
                    Thread.Sleep(1500);
                    Environment.Exit(0);
                }
            });
            watchdog.IsBackground = true; watchdog.Start();
            UIntPtr marker;
            using (RandomNumberGenerator random = RandomNumberGenerator.Create()) marker = CreateMarker(random);
            try {
                while (!cancelled.WaitOne(0)) {
                    string line;
                    if (!commands.TryTake(out line, 100)) {
                        if (lease != null && lease.Expired) { lease.Dispose(); lease = null; }
                        continue;
                    }
                    string id = "";
                    try {
                        var request = Json.Deserialize<Dictionary<string, object>>(line);
                        id = (string)request["id"];
                        Guid parsed;
                        if (!Guid.TryParse(id, out parsed)) throw new InputFailure("invalid_request");
                        var payload = (Dictionary<string, object>)request["payload"];
                        string method = (string)request["method"];
                        object result;
                        if (method == "begin") {
                            if (lease != null) throw new InputFailure("invalid_request");
                            var bounds = (Dictionary<string, object>)payload["bounds"];
                            var window = new InputWindow {
                                Handle = new IntPtr(Int64.Parse((string)payload["handle"], CultureInfo.InvariantCulture)),
                                Pid = Convert.ToInt32(payload["pid"]), Started = Convert.ToInt64(payload["started"]),
                                Bounds = new InputRect { Left = Convert.ToInt32(bounds["left"]), Top = Convert.ToInt32(bounds["top"]),
                                    Right = Convert.ToInt32(bounds["right"]), Bottom = Convert.ToInt32(bounds["bottom"]) }
                            };
                            lease = new InputLease(new InputEnvironment(), window, () => cancelled.WaitOne(0), marker);
                            result = new { activated = lease.Begin() };
                        } else if (method == "check" || method == "activation") {
                            if (lease == null) throw new InputFailure("user_interrupted");
                            if (method == "check") lease.ConfirmForeground(); else lease.Check(false);
                            result = new { ready = true };
                        } else if (method == "execute") {
                            if (lease == null) throw new InputFailure("user_interrupted");
                            var action = (Dictionary<string, object>)payload["action"];
                            string kind = (string)action["kind"];
                            if (kind == "type_text" || kind == "press_key")
                                lease.RequireFocus(new IntPtr(Int64.Parse((string)payload["focus"], CultureInfo.InvariantCulture)));
                            lease.Execute(action,
                                new InputPoint(Convert.ToInt32(payload["x"]), Convert.ToInt32(payload["y"])),
                                new InputPoint(Convert.ToInt32(payload["toX"]), Convert.ToInt32(payload["toY"])));
                            lease.Dispose();
                            result = new { focusRestored = lease.FocusRestored };
                            lease = null;
                        } else if (method == "cancel") {
                            if (lease != null) lease.Dispose();
                            lease = null; result = new { cancelled = true };
                        } else throw new InputFailure("invalid_request");
                        Console.WriteLine(Json.Serialize(new { id = id, result = result }));
                    } catch (Exception error) {
                        bool effect = lease != null && lease.EffectStarted;
                        var failure = error as InputFailure;
                        string code = failure != null ? failure.Code : "input_unavailable";
                        string reason = failure != null ? failure.Reason : null;
                        if (lease != null) {
                            try { lease.Dispose(); lease = null; }
                            catch { effect = true; code = "outcome_unknown"; cancelled.Set(); }
                        }
                        Console.WriteLine(Json.Serialize(new { id = id, error = new {
                            code = effect ? "outcome_unknown" : code, effectStarted = effect, reason = reason ?? (effect && code != "outcome_unknown" ? code : null)
                        } }));
                    }
                    Console.Out.Flush();
                }
            } finally { if (lease != null) lease.Dispose(); }
        }
    }
}
