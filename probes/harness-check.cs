#:package Marten@8.37.4
#:property PublishAot=false
// PublishAot=false is mandatory for anything touching Marten in a file-based app (KIT-FINDINGS A2).

using Marten;
using JasperFx.Events;

// DOES THE SHIPPED HARNESS ACTUALLY WORK?
//
// `concurrency-invariant.cs` proved the PATTERN — read, gate, write — with its own inline loop.
// `tools/architect.mjs` then scaffolds that pattern into a project as ConcurrencyHarness.RaceAsync, which
// is a refactoring of proven logic into new code, and new code that merely COMPILES is not proven. A
// deadlocking gate or a mis-set TaskCompletionSource would surface as a hung or falsely-green test in
// CPOC03 rather than here.
//
// So RaceAsync and Classify below are COPIED VERBATIM from the emitted harness. If they are edited in
// tools/architect.mjs, re-run this probe. That duplication is deliberate: a probe cannot reference a file
// inside a generated project, and a probe that tests something *similar* to what ships tests nothing.

const string ConnectionString = "Host=localhost;Port=55432;Database=concpoc;Username=postgres;Password=postgres";

var store = DocumentStore.For(opts =>
{
    opts.Connection(ConnectionString);
    opts.DatabaseSchemaName = "harness";
    opts.Events.StreamIdentity = StreamIdentity.AsString;
});
await store.Advanced.ResetAllData();

var failures = new List<string>();
void Check(bool ok, string label, string detail = "")
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {label}{(detail.Length > 0 ? "   -> " + detail : "")}");
    if (!ok) failures.Add(label);
}

// The decision every writer makes: is this desk-day free? Stage the booking if so.
Func<string, Func<int, IDocumentSession, Task<bool>>> booker = key => async (i, session) =>
{
    var stream = await session.Events.FetchForWriting<DeskDay>(key);
    if (stream.Aggregate?.BookedBy is not null) return false;
    stream.AppendOne(new DeskBooked(key, $"member-{i}"));
    return true;
};

Console.WriteLine("\n=== 1. HARNESS ON A NEW STREAM — contested creation ===");
{
    const string key = "desk:2026-08-10";
    var rs = await ConcurrencyHarness.RaceAsync(10, booker(key), store);
    Console.WriteLine($"       {rs.Describe()}");
    Check(rs.Count(RaceOutcome.Won) == 1, "exactly one winner", $"{rs.Count(RaceOutcome.Won)} won");
    Check(rs.Count(RaceOutcome.Unexpected) == 0, "no unexpected outcomes", rs.Describe());
    Check(rs.Count(RaceOutcome.StreamCollision) > 0, "losers classified as StreamCollision", rs.Describe());
}

Console.WriteLine("\n=== 2. HARNESS ON AN EXISTING STREAM — contested append ===");
{
    const string key = "desk:2026-08-11";
    await using (var seed = store.LightweightSession())
    {
        seed.Events.StartStream<DeskDay>(key, new DeskDayOpened(key));
        await seed.SaveChangesAsync();
    }
    var rs = await ConcurrencyHarness.RaceAsync(10, booker(key), store);
    Console.WriteLine($"       {rs.Describe()}");
    Check(rs.Count(RaceOutcome.Won) == 1, "exactly one winner", $"{rs.Count(RaceOutcome.Won)} won");
    Check(rs.Count(RaceOutcome.Unexpected) == 0, "no unexpected outcomes", rs.Describe());
    Check(rs.Count(RaceOutcome.VersionConflict) > 0, "losers classified as VersionConflict", rs.Describe());
}

Console.WriteLine("\n=== 3. THE HARNESS REPORTS A REFUSAL BY THE RULE AS SUCH ===");
{
    // Racing a desk-day that is ALREADY booked: nobody stages anything, so every writer must come back
    // RefusedByRule and none may be misreported as a concurrency conflict.
    const string key = "desk:2026-08-12";
    await using (var seed = store.LightweightSession())
    {
        seed.Events.StartStream<DeskDay>(key, new DeskBooked(key, "early-bird"));
        await seed.SaveChangesAsync();
    }
    var rs = await ConcurrencyHarness.RaceAsync(6, booker(key), store);
    Console.WriteLine($"       {rs.Describe()}");
    Check(rs.Count(RaceOutcome.RefusedByRule) == 6, "all six refused by the rule, none by concurrency", rs.Describe());
    Check(rs.Count(RaceOutcome.Won) == 0, "no winners", rs.Describe());
}

Console.WriteLine("\n=== 4. THE GATE DOES NOT DEADLOCK OR HANG — 30 rounds, alternating shapes ===");
{
    var bad = new List<string>();
    for (var i = 0; i < 30; i++)
    {
        var key = $"desk:stab-{i}";
        if (i % 2 == 1)
        {
            await using var seed = store.LightweightSession();
            seed.Events.StartStream<DeskDay>(key, new DeskDayOpened(key));
            await seed.SaveChangesAsync();
        }
        var rs = await ConcurrencyHarness.RaceAsync(6, booker(key), store);
        if (rs.Count(RaceOutcome.Won) != 1 || rs.Count(RaceOutcome.Unexpected) != 0)
            bad.Add($"round {i}: {rs.Describe()}");
    }
    Check(bad.Count == 0, "30/30 rounds had exactly one winner and no surprises",
          bad.Count == 0 ? "30/30" : string.Join(" | ", bad.Take(3)));
}

Console.WriteLine();
Console.WriteLine(failures.Count == 0
    ? "ALL CHECKS PASSED — the harness tools/architect.mjs ships is the harness that works."
    : $"{failures.Count} CHECK(S) FAILED: {string.Join(" | ", failures)}");
return failures.Count == 0 ? 0 : 1;

// ---------------------------------------------------------------- domain (public, and after the statements)
public record DeskDayOpened(string DeskDayId);
public record DeskBooked(string DeskDayId, string MemberId);

public class DeskDay
{
    public string Id { get; set; } = "";
    public string? BookedBy { get; set; }
    public void Apply(DeskDayOpened e) { }
    public void Apply(DeskBooked e) => BookedBy = e.MemberId;
}

// ================= COPIED VERBATIM from the harness tools/architect.mjs emits =================

public enum RaceOutcome { Won, StreamCollision, VersionConflict, RefusedByRule, Unexpected }

public sealed record RaceResult(RaceOutcome Outcome, string? Detail = null);

public static class ConcurrencyHarness
{
    public static RaceResult Classify(Exception ex) => ex.GetType().Name switch
    {
        "ExistingStreamIdCollisionException" => new(RaceOutcome.StreamCollision),
        "ConcurrencyException" or "EventStreamUnexpectedMaxEventIdException" => new(RaceOutcome.VersionConflict),
        var other => new(RaceOutcome.Unexpected, other + ": " + ex.Message),
    };

    public static async Task<RaceResult[]> RaceAsync(
        int writers,
        Func<int, IDocumentSession, Task<bool>> decideAndStage,
        IDocumentStore store)
    {
        var gate = new TaskCompletionSource();
        var readsDone = new List<Task>();
        var runs = new List<Task<RaceResult>>();

        for (var i = 0; i < writers; i++)
        {
            var index = i;
            var read = new TaskCompletionSource();
            readsDone.Add(read.Task);
            runs.Add(Task.Run(async () =>
            {
                var session = store.LightweightSession();
                try
                {
                    var staged = await decideAndStage(index, session);
                    read.SetResult();
                    await gate.Task;
                    if (!staged) return new RaceResult(RaceOutcome.RefusedByRule);
                    await session.SaveChangesAsync();
                    return new RaceResult(RaceOutcome.Won);
                }
                catch (Exception ex) { read.TrySetResult(); return Classify(ex); }
                finally { await session.DisposeAsync(); }
            }));
        }

        await Task.WhenAll(readsDone);
        gate.SetResult();
        return await Task.WhenAll(runs);
    }

    public static int Count(this RaceResult[] rs, RaceOutcome o) => rs.Count(r => r.Outcome == o);
    public static string Describe(this RaceResult[] rs) =>
        string.Join(", ", rs.GroupBy(r => r.Outcome).OrderBy(g => g.Key)
            .Select(g => $"{g.Key}={g.Count()}")) +
        (rs.Any(r => r.Outcome == RaceOutcome.Unexpected)
            ? "  UNEXPECTED: " + string.Join(" | ", rs.Where(r => r.Outcome == RaceOutcome.Unexpected).Select(r => r.Detail))
            : "");
}
