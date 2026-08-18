#:package WolverineFx.Marten@6.*
#:package WolverineFx.RuntimeCompilation@6.*
#:property PublishAot=false
// PublishAot=false is REQUIRED for anything touching Marten or Wolverine codegen (KIT-FINDINGS A2).

using JasperFx;                        // ConcurrencyException lives HERE, not in Marten.Exceptions
using JasperFx.Events;
using Marten;
using Marten.Exceptions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Wolverine;
using Wolverine.ErrorHandling;
using Wolverine.Marten;

// HOW MANY CONCURRENT WRITERS TO ONE STREAM SURVIVE `RetryTimes(3)`? — KIT-FINDINGS V12, re-measured.
//
// Every generated Program.cs carries `opts.OnException<...>().RetryTimes(3)`, which reads like ordinary
// resilience. It is not: on a contended stream each retry round lets exactly ONE writer commit, so the
// budget is a hard CEILING on simultaneous writers rather than a margin for flakiness.
//
// THREE THINGS THIS PROBE HAS TO GET RIGHT, each a mistake already paid for in this repo:
//
//   a) A CONTROL. `landed == writers` must be shown to be reachable, or "the budget held" and "the race
//      never happened" are the same green. probes/concurrency-invariant.cs attempt 1 was exactly this
//      failure: ten writers serialised themselves and were refused by the business rule, never by
//      concurrency, and the test passed for a non-reason.
//
//   b) A REAL RACE. Writers must be released together AND contend on an EXISTING stream, so the refusal
//      is the version check rather than the stream table's primary key. Those are two different
//      mechanisms — KIT-HISTORY BS1 — and only the first is what V12 is about.
//
//   c) THE MESSAGE PIPELINE, NOT HTTP. The retry policy is a message-pipeline policy and a Wolverine.HTTP
//      endpoint never enters it (KIT-FINDINGS V7). Measuring through an endpoint would measure nothing.
//
// THREE ARMS, because the first re-measurement showed the proposed fix was not one:
//
//   1. RetryTimes(3)        what codegen emits today
//   2. RetryWithCooldown    what V12 proposed as the fix, and what Wolverine's samples use
//   3. PARTITIONED          what Wolverine's own docs actually recommend for contention:
//                           "protecting through 'selective queueing' is preferable to relying solely on
//                           retry logic under contention" (tutorials/concurrency). Commands for one
//                           stream are routed to one local queue and run SEQUENTIALLY, so the race never
//                           happens rather than being retried.
//
// Arm 3 needs `UseInferredMessageGrouping()`, which is the whole reason this would be cheap for the kit:
// it groups by "the stream id of any command that is part of the aggregate handler workflow", which is
// exactly what every generated [WriteAggregate] command already is. No marker interface, no per-slice
// rule, no model change.
//
// AND ARM 3 MEASURES DIFFERENTLY ON PURPOSE. Partitioning is a routing rule for PUBLISHED messages;
// `InvokeAsync` runs inline and never reaches a queue, so arm 3 must publish and then wait. That is not a
// thumb on the scale — it is the shape the fix actually has, and its cost (the caller no longer gets the
// outcome back) is part of what is being reported.

const string Conn = "Host=localhost;Port=55432;Database=concpoc;Username=postgres;Password=postgres";
var Sizes = new[] { 2, 3, 4, 5, 6, 8, 10, 16 };
var Arms = new[] { Mode.RetryTimes, Mode.Cooldown, Mode.Partitioned, Mode.PartitionedInvoke };

Console.WriteLine("retry-budget — how many concurrent writers to ONE stream survive the emitted policy\n");

foreach (var arm in Arms)
{
    var title = arm switch
    {
        Mode.RetryTimes => "RetryTimes(3)   — what codegen emits today",
        Mode.Cooldown => "RetryWithCooldown(50,100,250)   — what V12 proposed",
        Mode.Partitioned => "PARTITIONED local queue, PUBLISHED   — what Wolverine recommends",
        _ => "PARTITIONED config but INVOKED inline   — does routing reach InvokeAsync?",
    };
    Console.WriteLine($"--- {title}");
    Console.WriteLine("  writers   landed   lost   how the losers failed");

    foreach (var n in Sizes)
    {
        BumpHandler.Seen.Clear();
        var (landed, why) = await RunAsync(n, arm);
        if (arm == Mode.Partitioned && n == 4)
            Console.WriteLine($"  [routing check] {string.Join(" | ", BumpHandler.Seen.Distinct())}");
        var lost = n - landed;
        var flag = lost == 0 ? "" : "   <-- WORK LOST";
        Console.WriteLine($"  {n,7}   {landed,6}   {lost,4}   {(why.Count == 0 ? "-" : string.Join(", ", why.Select(k => $"{k.Key} x{k.Value}")))}{flag}");
    }
    Console.WriteLine();
}

Console.WriteLine("A row where landed < writers is work a caller believes was accepted and was not.");
Console.WriteLine("`landed == writers` on the small sizes is the CONTROL: it proves the harness can succeed,");
Console.WriteLine("so a shortfall further down is the budget and not a broken probe.");

async Task<(int landed, Dictionary<string, int> why)> RunAsync(int writers, Mode mode)
{
    using var host = BuildHost(mode);
    await host.StartAsync();

    var store = host.Services.GetRequiredService<IDocumentStore>();
    var key = $"c-{mode}-{writers}-{Guid.NewGuid():N}";

    // SEED THE STREAM FIRST. A contested CREATE is refused by the stream table's primary key, which is a
    // different mechanism with a different exception; V12 is about the version check on an existing stream.
    await using (var seed = store.LightweightSession())
    {
        seed.Events.StartStream<Counter>(key, new Bumped(key, 0));
        await seed.SaveChangesAsync();
    }

    var why = new Dictionary<string, int>();

    // ALL WRITERS RELEASED TOGETHER. Without the barrier each request completes its own round trip and the
    // database serialises them — the losers are then never refused at all and the probe measures nothing.
    var gate = new TaskCompletionSource();
    var tasks = Enumerable.Range(0, writers).Select(async _ =>
    {
        using var scope = host.Services.CreateScope();
        var bus = scope.ServiceProvider.GetRequiredService<IMessageBus>();
        await gate.Task;
        try
        {
            if (mode == Mode.Partitioned) await bus.PublishAsync(new Bump(key));
            else await bus.InvokeAsync(new Bump(key));
            return (ok: true, err: "");
        }
        catch (Exception e) { return (ok: false, err: e.GetType().Name); }
    }).ToArray();

    gate.SetResult();
    var results = await Task.WhenAll(tasks);
    foreach (var r in results.Where(x => !x.ok)) why[r.err] = why.GetValueOrDefault(r.err) + 1;

    // COUNT WHAT IS IN THE STREAM, not what the callers believe. A caller that got no exception and whose
    // event is not in the store is the worst possible result, and only reading the stream can see it.
    //
    // For the partitioned arm the work is asynchronous, so settle first: wait until the stream reaches the
    // expected size, or stops growing for a full second. A fixed sleep would either be flaky or slow, and
    // "stopped growing" is the only honest end condition for a queue nobody can query directly.
    var appended = await CountAsync(store, key);
    if (mode == Mode.Partitioned)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        var stableSince = DateTime.UtcNow;
        while (appended < writers && DateTime.UtcNow < deadline)
        {
            await Task.Delay(100);
            var now = await CountAsync(store, key);
            if (now != appended) { appended = now; stableSince = DateTime.UtcNow; }
            else if (DateTime.UtcNow - stableSince > TimeSpan.FromSeconds(1)) break;
        }
    }

    await host.StopAsync();
    return (appended, why);
}

async Task<int> CountAsync(IDocumentStore store, string key)
{
    await using var q = store.QuerySession();
    var events = await q.Events.FetchStreamAsync(key);
    return events.Count - 1;                               // minus the seed
}

IHost BuildHost(Mode mode) =>
    Host.CreateDefaultBuilder()
        // The table IS the result; Wolverine's per-failure logging is the noise it would otherwise drown in.
        .ConfigureLogging(l => l.ClearProviders())
        .ConfigureServices(services =>
        {
            services.AddMarten(o =>
            {
                o.Connection(Conn);
                o.DatabaseSchemaName = "retrybudget";
                o.Events.StreamIdentity = StreamIdentity.AsString;
                o.AutoCreateSchemaObjects = JasperFx.AutoCreate.All;
            }).IntegrateWithWolverine();
        })
        .UseWolverine(opts =>
        {
            opts.Discovery.IncludeType(typeof(BumpHandler));
            opts.Policies.AutoApplyTransactions();

            // The SAME retry policy in every arm, so the only variable in arm 3 is the routing.
            if (mode == Mode.Cooldown)
            {
                opts.OnException<ConcurrencyException>()
                    .RetryWithCooldown(TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(100), TimeSpan.FromMilliseconds(250));
                opts.OnException<EventStreamUnexpectedMaxEventIdException>()
                    .RetryWithCooldown(TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(100), TimeSpan.FromMilliseconds(250));
            }
            else
            {
                // EXACTLY WHAT codegen EMITS TODAY.
                opts.OnException<ConcurrencyException>().RetryTimes(3);
                opts.OnException<EventStreamUnexpectedMaxEventIdException>().RetryTimes(3);
            }

            if (mode == Mode.Partitioned || mode == Mode.PartitionedInvoke)
            {
                opts.MessagePartitioning
                    // "the stream id of any command that is part of the aggregate handler workflow" — so
                    // Bump.StreamKey is found with no rule of ours. This is the line that would make the
                    // fix nearly free for codegen.
                    // UseInferredMessageGrouping() ALONE GAVE group=(NONE) — measured, see the routing
                    // check below. Its documented rule is "the stream id of any command that is part of the
                    // aggregate handler workflow", and a [WriteAggregate] PARAMETER did not satisfy it. A
                    // null group id is not a no-op: Wolverine then picks a slot AT RANDOM, so one stream's
                    // commands scatter across queues and race exactly as before.
                    .ByMessage<Bump>(x => x.Key)
                    .UseInferredMessageGrouping()
                    .PublishToPartitionedLocalMessaging("bumps", 4, t =>
                    {
                        t.MessagesImplementing<Bump>();
                        // MaxDegreeOfParallelism is deliberately left at the default: PartitionSlots is not
                        // publicly reachable (CS0103 even from Wolverine.Runtime.Partitioning), and the docs
                        // say ordering WITHIN a group id is guaranteed by the listener regardless of slots.
                    });
            }
        })
        .Build();

public enum Mode { RetryTimes, Cooldown, Partitioned, PartitionedInvoke }

public record Bumped(string Key, int N);

public class Counter
{
    public string Id { get; set; } = default!;
    public int Total { get; set; }
    public void Apply(Bumped e) => Total = e.N;
}

public record Bump(string Key)
{
    public string StreamKey => Key;
}

public static class BumpHandler
{
    // DIAGNOSTIC — see the note in the report loop. "Partitioning did not help" is only a result if the
    // messages were actually partitioned; otherwise it measures a routing mistake of mine.
    public static readonly System.Collections.Concurrent.ConcurrentBag<string> Seen = new();

    // The aggregate handler workflow: middleware fetches the stream, folds it, carries its version into
    // the append. Exactly the shape codegen scaffolds for a non-creating state-change slice.
    public static Bumped Handle(Bump cmd, Envelope envelope, [WriteAggregate(nameof(Bump.StreamKey))] Counter state)
    {
        Seen.Add($"dest={envelope.Destination?.ToString() ?? "(inline)"} group={envelope.GroupId ?? "(NONE)"}");
        return new(cmd.Key, state.Total + 1);
    }
}
