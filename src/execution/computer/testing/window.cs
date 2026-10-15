using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class ComputerFixture : Form {
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    protected override bool ShowWithoutActivation { get { return true; } }
    public static void Run() { Run(false); }
    public static void RunInput() { Run(true); }
    private static void Run(bool inputTesting) {
        Application.EnableVisualStyles();
        var form = new ComputerFixture {
            Text = "Shadow synthetic computer fixture", Size = new Size(500, 350),
            ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, Location = new Point(20, 20)
        };
        var input = new TextBox { AccessibleName = "Fixture input", Text = "before", Location = new Point(20, 20), Width = 300 };
        var password = new TextBox { AccessibleName = "Fixture password", Text = "SYNTHETIC-PRIVATE-VALUE", UseSystemPasswordChar = true, Location = new Point(20, 60), Width = 300 };
        var toggle = new CheckBox { AccessibleName = "Fixture toggle", Text = "Fixture toggle", Location = new Point(20, 100), Width = 200 };
        var button = new Button { AccessibleName = "Fixture button", Text = "Fixture button", Location = new Point(20, 140), Width = 200 };
        var label = new Label { Text = "Not invoked", Location = new Point(20, 180), Width = 300 };
        var list = new ListBox { AccessibleName = "Fixture list", Location = new Point(340, 20), Size = new Size(120, 200) };
        for (int i = 0; i < 30; i++) list.Items.Add("Fixture choice " + i);
        button.Click += (sender, args) => { label.Text = "Invoked once"; };
        form.Controls.AddRange(new Control[] { input, password, toggle, button, label, list });
        if (inputTesting) {
            form.Size = new Size(650, 480);
            var surface = new InputSurface { AccessibleName = "Fixture pointer surface", AccessibleRole = AccessibleRole.Pane,
                Location = new Point(20, 240), Size = new Size(400, 150), BackColor = Color.WhiteSmoke, TabStop = true };
            surface.MouseMove += (sender, args) => { Console.WriteLine("POINTER_MOVED"); Console.Out.Flush(); };
            surface.MouseDown += (sender, args) => { Console.WriteLine("POINTER_DOWN " + args.Button); Console.Out.Flush(); };
            surface.MouseUp += (sender, args) => { Console.WriteLine("POINTER_UP " + args.Button); Console.Out.Flush(); };
            surface.MouseWheel += (sender, args) => { Console.WriteLine("POINTER_WHEEL " + args.Delta); Console.Out.Flush(); };
            input.KeyDown += (sender, args) => { Console.WriteLine("KEY " + args.KeyCode); Console.Out.Flush(); };
            form.Controls.Add(surface);
        }
        form.Shown += (sender, args) => {
            Console.WriteLine("READY");
            Console.Out.Flush();
            var commands = new Thread(() => {
                string command;
                while ((command = Console.ReadLine()) != null) {
                    if (inputTesting && command == "held-input") form.BeginInvoke((Action)(() => {
                        bool released = true;
                        foreach (int key in new[] { 0x10, 0x11, 0x12, 1, 2, 4 })
                            if ((GetAsyncKeyState(key) & 0x8000) != 0) released = false;
                        Console.WriteLine(released ? "INPUT_RELEASED" : "INPUT_HELD");
                        Console.Out.Flush();
                    }));
                    if (command == "change") form.BeginInvoke((Action)(() => {
                        input.Text = "Changed outside automation";
                        Console.WriteLine("CHANGED");
                        Console.Out.Flush();
                    }));
                    if (command == "change-long") form.BeginInvoke((Action)(() => {
                        input.Text = new String('x', 2100) + "after";
                        Console.WriteLine("LONG_CHANGED");
                        Console.Out.Flush();
                    }));
                    if (command == "many-fields") form.BeginInvoke((Action)(() => {
                        for (int i = 0; i < 100; i++)
                            form.Controls.Add(new TextBox { Text = new String('y', 2000), Location = new Point(350, 20), Width = 100 });
                        Console.WriteLine("MANY_FIELDS");
                        Console.Out.Flush();
                    }));
                }
                if (!form.IsDisposed) form.BeginInvoke((Action)(() => form.Close()));
            });
            commands.IsBackground = true;
            commands.Start();
        };
        Application.Run(form);
    }
    private sealed class InputSurface : Panel {
        internal InputSurface() { SetStyle(ControlStyles.Selectable | ControlStyles.StandardClick | ControlStyles.StandardDoubleClick, true); }
    }
}
