#:package Marten@8.37.4
#:property PublishAot=false
// PublishAot=false is REQUIRED for anything touching Marten in a file-based app (KIT-FINDINGS A2).

using Marten;
using JasperFx.Events;

// CAN WE TEST "TWO MEMBERS AT THE SAME INSTANT MUST NOT BOTH SUCCEED"? — attempt 2.
//
// Attempt 1 passed and was WRONG, in the way that matters most: `won=1` with
// `refused-by-rule=9, concurrency-conflict=0`. Ten writers were released together and then each did its
// own FetchForWriting round trip, so the database serialised them and nine read the state AFTER the
// winner had committed. They were refused by the business rule, never by concurrency. A test that
// green-lights a race it never actually ran is worse than no test.
//
// THE FIX IS TO SPLIT READ FROM WRITE. Every writer reads first — so all N observe the same state — and
// only then does the starting gun fire for the writes. That is both deterministic and genuinely parallel.
//
// AND ATTEMPT 1 FOUND SOMETHING REAL: the losers threw ExistingStreamIdCollisionException, not
// ConcurrencyException. Every stream in that run was BRAND NEW, so the contested operation was creating
// the stream, which Postgres refuses on the stream table's primary key. Optimistic concurrency on a
// stream VERSION only applies to a stream that already exists. Two mechanisms, two exception types, and
// a generated test has to expect the right one:
//
//   contested stream CREATION      -> ExistingStreamIdCollisionException   (a database constraint)
//   contested append to an EXISTING -> ConcurrencyException                 (a version check)
//
// Both matter for desk booking. The first booking of a desk-day creates the stream; a second booking
// after a cancellation appends to one that exists.

const string ConnectionString = "Host=localhost;Port=55432;Database=concpoc;Username=postgres;Password=postgres";

var store = DocumentStore.For(opts =>
{
    opts.Connection(ConnectionString);
    opts.DatabaseSchemaName = "conc2";
    opts.Events.StreamIdentity = StreamIdentity.AsString;
});
await store.Advanced.ResetAllData();

var failures = new List<string>();
void Check(bool ok, string label, string detail = "")
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {label}{(detail.Length > 0 ? "   -> " + detail : "")}");
    if (!ok) failures.Add(label);
}
// DISCOVERED BY RUNNING, and it contradicts the mirror. command_handler_workflow.md says a stream that moved
// under FetchForWriting fails with "a Marten `ConcurrencyException`". On Marten 8.37.4 with
// StreamIdentity.AsString it throws EventStreamUnexpectedMaxEventIdException — the type the older
// aggregates-events-repositories.md scenario names. Both are version-conflict outcomes, so a test must
// accept either; asserting only the documented one would have failed against the real runtime.
//
// This is NOT the "docs win" rule being broken: that rule is about which DESIGN to adopt. For an
// observable runtime fact the kit's own escalation applies — read the mirror, grep the .xml, then COMPILE —
// and the compiler is the tiebreaker.
static string Classify(Exception ex) => ex.GetType().Name switch
{
    "ExistingStreamIdCollisionException" => "collision",
    "ConcurrencyException" or "EventStreamUnexpectedMaxEventIdException" => "concurrency",
    var other => "UNEXPECTED:" + other,
};

// Race N writers over one stream key, with the READ done before the starting gun so every writer decides
// from the same state. `guarded:false` drops the optimistic-concurrency guard, which is the control.
async Task<(int won, Dictionary<string, int> losses)> Race(string key, int n, bool preCreate, bool guarded)
{
    if (preCreate)
    {
        // Put the stream in existence WITHOUT booking it, so the contested operation is an append to an
        // existing stream rather than its creation.
        await using var seed = store.LightweightSession();
        seed.Events.StartStream<DeskDay>(key, new DeskDayOpened(key));
        await seed.SaveChangesAsync();
    }

    var gate = new TaskCompletionSource();
    var ready = new List<Task>();
    var tasks = new List<Task<string?>>();

    for (var i = 0; i < n; i++)
    {
        var memberId = $"member-{i}";
        var readDone = new TaskCompletionSource();
        ready.Add(readDone.Task);
        tasks.Add(Task.Run(async () =>
        {
            var session = store.LightweightSession();
            try
            {
                string? refusal = null;
                if (guarded)
                {
                    var stream = await session.Events.FetchForWriting<DeskDay>(key);
                    if (stream.Aggregate?.BookedBy is not null) refusal = "DeskAlreadyBooked";
                    else stream.AppendOne(new DeskBooked(key, memberId));
                }
                else
                {
                    // THE CONTROL: read the state, decide, append — with no version captured, so nothing
                    // can detect that somebody else decided from the same state.
                    var state = await session.Events.AggregateStreamAsync<DeskDay>(key);
                    if (state?.BookedBy is not null) refusal = "DeskAlreadyBooked";
                    else session.Events.Append(key, new DeskBooked(key, memberId));
                }

                readDone.SetResult();          // this writer has read and decided
                await gate.Task;               // ...now wait for everyone else, then all write at once
                if (refusal is not null) return refusal;

                await session.SaveChangesAsync();
                return null;
            }
            catch (Exception ex) { readDone.TrySetResult(); return Classify(ex); }
            finally { await session.DisposeAsync(); }
        }));
    }

    await Task.WhenAll(ready);   // every writer has now decided from the same state
    gate.SetResult();            // the starting gun
    var results = await Task.WhenAll(tasks);

    var losses = results.Where(r => r is not null)
        .GroupBy(r => r!).ToDictionary(g => g.Key, g => g.Count());
    return (results.Count(r => r is null), losses);
}

string Show(Dictionary<string, int> d) => d.Count == 0 ? "none" : string.Join(", ", d.OrderBy(k => k.Key).Select(k => $"{k.Key}={k.Value}"));

Console.WriteLine("\n=== 1. CONTESTED STREAM CREATION — 10 writers, the desk-day does not exist yet ===");
{
    var (won, losses) = await Race("desk-1:2026-08-10:create", 10, preCreate: false, guarded: true);
    Console.WriteLine($"       won={won}  losses: {Show(losses)}");
    Check(won == 1, "exactly one writer succeeded", $"{won} won");
    Check(losses.ContainsKey("collision"), "the losers were refused by the stream-id constraint", Show(losses));
    Check(!losses.Keys.Any(k => k.StartsWith("UNEXPECTED")), "no unexpected exception types", Show(losses));
    var final = await store.QuerySession().Events.FetchStreamAsync("desk-1:2026-08-10:create");
    Check(final.Count == 1, "exactly one event on the stream", $"{final.Count} event(s)");
}

Console.WriteLine("\n=== 2. CONTESTED APPEND TO AN EXISTING STREAM — 10 writers, desk-day already open ===");
{
    const string key = "desk-1:2026-08-11:append";
    var (won, losses) = await Race(key, 10, preCreate: true, guarded: true);
    Console.WriteLine($"       won={won}  losses: {Show(losses)}");
    Check(won == 1, "exactly one writer succeeded", $"{won} won");
    Check(losses.ContainsKey("concurrency"), "the losers hit OPTIMISTIC CONCURRENCY on the stream version", Show(losses));
    Check(!losses.Keys.Any(k => k.StartsWith("UNEXPECTED")), "no unexpected exception types", Show(losses));
    var booked = (await store.QuerySession().Events.FetchStreamAsync(key)).Count(e => e.Data is DeskBooked);
    Check(booked == 1, "exactly one booking on the stream", $"{booked} booking(s)");
}

Console.WriteLine("\n=== 3. CONTROL — the SAME rule with the stream keyed WRONGLY ===");
Console.WriteLine("       (a green test proves nothing about what it would catch)");
{
    // MY FIRST CONTROL WAS WRONG AND THE RUN SAID SO. It dropped FetchForWriting and expected both writers
    // through — but in Rich append mode (the Marten 8 default) even a bare Append carries a client-assigned
    // version, so the second writer still lost. The guard was stronger than the thing I was trying to remove.
    //
    // THE REAL CONTROL IS THE MODELLING DECISION, not a Marten setting. Key the stream per BOOKING instead
    // of per desk-day and there is no shared stream to serialise on — so nothing in the database can refuse
    // the second booking, whatever the append mode. This is `stream-boundaries` from the architect step,
    // made executable: same rule, same library, two boundary choices, one enforceable and one not.
    const string deskDay = "desk-1:2026-08-12";
    var gate = new TaskCompletionSource();
    var tasks = Enumerable.Range(0, 10).Select(async i =>
    {
        await using var session = store.LightweightSession();
        // Decide from a cross-stream read — the only thing available when the contested value is not a
        // stream key. Every writer sees nothing, because nobody has committed yet.
        var seenAlready = (await session.Events.QueryAllRawEvents().ToListAsync())
            .Any(e => e.Data is DeskBooked b && b.DeskDayId == deskDay);
        await gate.Task;
        if (seenAlready) return "DeskAlreadyBooked";
        session.Events.StartStream<DeskDay>($"booking-{i}", new DeskBooked(deskDay, $"member-{i}"));
        try { await session.SaveChangesAsync(); return null; }
        catch (Exception ex) { return Classify(ex); }
    }).ToArray();
    gate.SetResult();
    var results = await Task.WhenAll(tasks);
    var won = results.Count(r => r is null);

    var booked = (await store.QuerySession().Events.QueryAllRawEvents().ToListAsync())
        .Count(e => e.Data is DeskBooked b && b.DeskDayId == deskDay);
    Console.WriteLine($"       won={won}  bookings for one desk-day: {booked}");
    Check(won > 1 && booked > 1,
          "MORE than one writer succeeded, so tests 1-2 have teeth — and the BOUNDARY is what enforces the rule",
          $"{won} won, {booked} booking(s) for the same desk-day");
}

Console.WriteLine("\n=== 4. STABILITY — 20 rounds of each shape, every round must yield exactly one winner ===");
{
    var bad = new List<string>();
    for (var i = 0; i < 20; i++)
    {
        var (wc, lc) = await Race($"desk-c:{i}", 6, preCreate: false, guarded: true);
        if (wc != 1 || lc.Keys.Any(k => k.StartsWith("UNEXPECTED"))) bad.Add($"create round {i}: won={wc} {Show(lc)}");
        var (wa, la) = await Race($"desk-a:{i}", 6, preCreate: true, guarded: true);
        if (wa != 1 || la.Keys.Any(k => k.StartsWith("UNEXPECTED"))) bad.Add($"append round {i}: won={wa} {Show(la)}");
    }
    Check(bad.Count == 0, "40/40 races had exactly one winner",
          bad.Count == 0 ? "40/40" : string.Join(" | ", bad.Take(3)));
}

Console.WriteLine();
Console.WriteLine(failures.Count == 0
    ? "ALL CHECKS PASSED — a concurrency invariant on this stack is testable, in both of its two forms, with a control that proves the tests bite."
    : $"{failures.Count} CHECK(S) FAILED: {string.Join(" | ", failures)}");
return failures.Count == 0 ? 0 : 1;

// Types must follow top-level statements (CS8803) and must be PUBLIC — Marten generates a public storage
// provider over the document type, and an internal one fails runtime codegen with a wall of generated C#.
public record DeskDayOpened(string DeskDayId);
public record DeskBooked(string DeskDayId, string MemberId);

public class DeskDay
{
    public string Id { get; set; } = "";
    public string? BookedBy { get; set; }
    public void Apply(DeskDayOpened e) { }
    public void Apply(DeskBooked e) => BookedBy = e.MemberId;
}
