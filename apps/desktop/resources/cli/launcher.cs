using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// The `turbodl` console command on Windows. A .cmd file would let cmd.exe cut a link at its "&", so this
// small exe hands the command line to TurboDL's bundled CLI script exactly as the shell wrote it.
// turbodl.cfg (next to this exe, UTF-8): line 1 is the TurboDL executable, line 2 is the CLI script.
static class Launcher
{
    static int Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string[] lines = File.ReadAllLines(Path.Combine(dir, "turbodl.cfg"), Encoding.UTF8);
        string electron = lines[0];
        string script = lines[1];
        if (!File.Exists(electron))
        {
            Console.Error.WriteLine("TurboDL is not installed any more.");
            return 5;
        }

        // Ctrl+C reaches the child in the same console; this process stays alive to pass its exit code on.
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; };

        ProcessStartInfo psi = new ProcessStartInfo(electron, "\"" + script + "\" " + Tail(Environment.CommandLine));
        psi.UseShellExecute = false;
        psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        using (Process child = Process.Start(psi))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    /// The command line after its first token (this program) and the spaces after it, never re-quoted.
    static string Tail(string line)
    {
        int i = 0;
        if (line.Length > 0 && line[0] == '"')
        {
            i = line.IndexOf('"', 1);
            i = i < 0 ? line.Length : i + 1;
        }
        else
        {
            while (i < line.Length && line[i] != ' ' && line[i] != '\t') i++;
        }
        while (i < line.Length && (line[i] == ' ' || line[i] == '\t')) i++;
        return line.Substring(i);
    }
}
