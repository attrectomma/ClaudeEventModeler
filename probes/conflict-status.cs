#:sdk Microsoft.NET.Sdk.Web
#:package WolverineFx.Http@6.*
#:package WolverineFx.Marten@6.*
#:package WolverineFx.RuntimeCompilation@6.*
#:property PublishAot=false
// PublishAot=false because Wolverine's runtime codegen reaches Reflection.Emit (KIT-FINDINGS A2).

using JasperFx;                        // ConcurrencyException lives HERE, not in Marten.Exceptions
using JasperFx.Events;
using Marten;
using Marten.Exceptions;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.Extensions.Logging;
using Wolverine;
using Wolverine.Http;
using Wolverine.Marten;

// DOES A LOST RACE ON THE HTTP ARM ACTUALLY RETURN 409, OR IS THAT JUST WHAT THE CODE LOOKS LIKE?
//
// KIT-FINDINGS V12 measured that the message-pipeline retry cannot reach a Wolverine.HTTP endpoint (V7)
// and that partitioned messaging cannot either, because it is a ROUTING rule and an endpoint that invokes
// its decider inline is never routed. So the HTTP write path has no protection at all, and the only
// honest improvement available is to stop calling a lost race a SERVER error.
//
// codegen now emits an ExceptionHandler mapping the three concurrency exceptions to 409. This probe exists
// because BP1 is the precedent: a claim about response SHAPE, asserted from reading the code, propagated
// into CLAUDE.md, two projects' Rejections.cs and every agent brief — and was false. The rule that came
// out of it is that a wire-format claim is measured on the wire.
//
// TWO RUNS, AND THE CONTROL IS THE POINT:
//
//   run 1  NO handler  -> must reproduce the 500. Without this, "the handler worked" and "there was never
//                         a conflict to see" are the same green.
//   run 2  handler     -> must be 409, and must NOT swallow the winner's success.

const string Conn = "Host=localhost;Port=55432;Database=concpoc;Username=postgres;Password=postgres";
var failures = new List<string>();

await RunAsync(5401, withHandler: false, expected: 500);
await RunAsync(5402, withHandler: true, expected: 409);

Console.WriteLine();
Console.WriteLine(failures.Count == 0
    ? "PASS — the control reproduced the 500, and the emitted handler turns it into a 409."
    : $"FAIL — {string.Join("; ", failures)}");
return failures.Count == 0 ? 0 : 1;

async Task RunAsync(int port, bool withHandler, int expected)
{
    var builder = WebApplication.CreateBuilder();
    builder.Logging.ClearProviders();
    builder.WebHost.UseUrls($"http://localhost:{port}");
    builder.Services.AddMarten(o =>
    {
        o.Connection(Conn);
        o.DatabaseSchemaName = "conflictstatus";
        o.Events.StreamIdentity = StreamIdentity.AsString;
        o.AutoCreateSchemaObjects = JasperFx.AutoCreate.All;
    }).IntegrateWithWolverine();
    builder.Services.AddProblemDetails();
    builder.Services.AddWolverineHttp();
    builder.Host.UseWolverine(opts => opts.Policies.AutoApplyTransactions());

    var app = builder.Build();

    // EXACTLY WHAT codegen EMITS, and omitted entirely in the control run.
    if (withHandler)
    {
        app.UseExceptionHandler(new ExceptionHandlerOptions
        {
            ExceptionHandler = async context =>
            {
                var error = context.Features.Get<IExceptionHandlerFeature>()?.Error;
                if (error is ConcurrencyException or EventStreamUnexpectedMaxEventIdException
                          or ExistingStreamIdCollisionException)
                {
                    await Results.Problem(
                        title: "Conflict",
                        detail: "Another change to the same stream committed first. The command was not applied — retry it.",
                        statusCode: StatusCodes.Status409Conflict).ExecuteAsync(context);
                }
                else if (error is not null)
                {
                    await Results.Problem(statusCode: StatusCodes.Status500InternalServerError).ExecuteAsync(context);
                }
            }
        });
    }

    app.MapWolverineEndpoints();
    await app.StartAsync();

    var store = app.Services.GetRequiredService<IDocumentStore>();
    var key = $"h-{port}-{Guid.NewGuid():N}";
    await using (var seed = store.LightweightSession())
    {
        seed.Events.StartStream<Counter>(key, new Bumped(key, 0));
        await seed.SaveChangesAsync();
    }

    // Eight concurrent POSTs to one stream, released together — well above the measured retry ceiling, so
    // at least one caller MUST lose.
    using var http = new HttpClient { BaseAddress = new Uri($"http://localhost:{port}") };
    var gate = new TaskCompletionSource();
    var calls = Enumerable.Range(0, 8).Select(async _ =>
    {
        await gate.Task;
        var r = await http.PostAsJsonAsync("/bump", new Bump(key));
        return (int)r.StatusCode;
    }).ToArray();
    gate.SetResult();
    var codes = await Task.WhenAll(calls);

    var byCode = codes.GroupBy(c => c).OrderBy(g => g.Key)
        .Select(g => $"{g.Key} x{g.Count()}").ToArray();
    Console.WriteLine($"{(withHandler ? "WITH handler   " : "CONTROL (none) ")} -> {string.Join(", ", byCode)}");

    var losers = codes.Where(c => c is not (200 or 204)).ToArray();
    if (losers.Length == 0)
        failures.Add($"port {port}: no caller lost the race at all, so this run measured nothing");
    else if (losers.Any(c => c != expected))
        failures.Add($"port {port}: expected every loser to be {expected}, got {string.Join(",", losers.Distinct())}");

    await app.StopAsync();
}

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

public static class BumpEndpoint
{
    // The SINGLE HTTP ARM — what codegen scaffolds for a state-change slice that architect has not called
    // contended. This is precisely the path neither the retry policy nor partitioning can protect.
    [WolverinePost("/bump"), EmptyResponse]
    public static Bumped Post(Bump cmd, [WriteAggregate(nameof(Bump.StreamKey))] Counter state)
        => new(cmd.Key, state.Total + 1);
}
