using System.Security.Cryptography;
using System.Text;

namespace DotKtX.Experimental.LspSupport;

internal static class Program
{
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0) return Usage();
            var command = args[0];
            var options = Arguments.Parse(args[1..]);
            return command switch
            {
                "generate" => Generate(options),
                "clean" => Clean(options),
                _ => Usage(),
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"DotKtX.Experimental.LspSupport: {ex.Message}");
            return 1;
        }
    }

    private static int Generate(Arguments options)
    {
        var project = NormalizeDirectory(options.Required("project"));
        var output = NormalizeDirectory(options.Required("output"));
        var projectName = options.Optional("name") ?? Path.GetFileName(project);
        var sourceList = Path.GetFullPath(options.Required("sources"));
        var sources = ReadResponseFile(sourceList);
        var klibs = ReadResponseFile(options.Required("klibs"));
        var plugins = options.Optional("plugins") is { } pluginList ? ReadResponseFile(pluginList) : [];
        WithWorkspaceLock(project, () => WorkspaceWriter.Generate(project, projectName, output, sources, klibs, plugins, sourceList));
        return 0;
    }

    private static int Clean(Arguments options)
    {
        var project = NormalizeDirectory(options.Required("project"));
        var output = NormalizeDirectory(options.Required("output"));
        WithWorkspaceLock(project, () => WorkspaceWriter.Clean(project, output));
        return 0;
    }

    private static string NormalizeDirectory(string path) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));

    // Inner builds have separate inputs and publish into the same editor workspace.
    private static void WithWorkspaceLock(string project, Action action)
    {
        var identity = OperatingSystem.IsWindows() ? project.ToUpperInvariant() : project;
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)));
        using var mutex = new Mutex(false, $"DotKtLsp-{key}");
        try
        {
            mutex.WaitOne();
        }
        catch (AbandonedMutexException)
        {
            // The previous process stopped mid-build. The lock has been acquired for recovery.
        }

        try
        {
            action();
        }
        finally
        {
            mutex.ReleaseMutex();
        }
    }

    private static IReadOnlyList<string> ReadResponseFile(string path) =>
        File.Exists(path)
            ? File.ReadLines(path)
                .Where(line => !string.IsNullOrWhiteSpace(line))
                .Select(Path.GetFullPath)
                .ToArray()
            : throw new FileNotFoundException("response file does not exist", path);

    private static int Usage()
    {
        Console.Error.WriteLine(
            "usage:\n" +
            "  DotKtX.Experimental.LspSupport generate --project <dir> --name <name> --output <dir> --sources <rsp> --klibs <rsp> [--plugins <rsp>]\n" +
            "  DotKtX.Experimental.LspSupport clean --project <dir> --output <dir>");
        return 2;
    }
}

internal sealed class Arguments
{
    private readonly Dictionary<string, string> _values;

    private Arguments(Dictionary<string, string> values) => _values = values;

    public static Arguments Parse(IReadOnlyList<string> args)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 0; i < args.Count; i += 2)
        {
            if (i + 1 >= args.Count || !args[i].StartsWith("--", StringComparison.Ordinal))
                throw new ArgumentException($"invalid argument near '{args[i]}'");
            values[args[i][2..]] = args[i + 1];
        }
        return new Arguments(values);
    }

    public string Required(string name) =>
        _values.TryGetValue(name, out var value) && value.Length != 0
            ? value
            : throw new ArgumentException($"missing --{name}");

    public string? Optional(string name) => _values.GetValueOrDefault(name) is { Length: > 0 } value ? value : null;
}
