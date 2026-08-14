#:sdk Microsoft.NET.Sdk.Web
#:package WolverineFx.Http@6.*
#:package WolverineFx.Http.FluentValidation@6.*
#:package WolverineFx.FluentValidation@6.*
#:package WolverineFx.RuntimeCompilation@6.*
#:property PublishAot=false
// PublishAot=false because Wolverine's runtime codegen reaches Reflection.Emit (KIT-FINDINGS A2).

using FluentValidation;
using Wolverine;
using Wolverine.Http;
using Wolverine.Http.FluentValidation;
using Wolverine.FluentValidation;
using Microsoft.AspNetCore.Mvc;
using System.Text.Json;

// CAN ONE PROBLEMDETAILS CUSTOMISER MAKE A PERIPHERY REJECTION AND A DECIDER REJECTION THE SAME SHAPE?
//
// KIT-FINDINGS BP1 measured that they are not the same shape: the rule name is in errors.<Property>[0]
// at the periphery and in title from the decider. CLAUDE.md and both projects' Rejections.cs claim
// otherwise. This probe settles ONE yes/no before that claim is rewritten:
//
//   does an ASP.NET ProblemDetails customiser fire on the path Wolverine's FluentValidation middleware
//   takes, and does it leave `errors` intact?
//
// Three requirements, each a failure this kit has already paid for:
//   a) it asserts the RESPONSE BODY. Both paths return 400, so a status assertion proves nothing.
//   b) it includes the CONTROL — run 1 has no customiser and must reproduce the asymmetry first.
//      Without that, "the customiser worked" is indistinguishable from "BP1 was wrong".
//   c) it goes through a real [WolverinePost] with a real IValidator attached. A hand-written
//      minimal-API endpoint would pass and prove nothing, because the actual risk is that
//      Wolverine.Http.FluentValidation writes its response without IProblemDetailsService.
//
// No Marten, no Postgres: the question is entirely about the HTTP write path.

var failures = new List<string>();
void Check(bool ok, string label, string detail = "")
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {label}{(detail.Length > 0 ? "   -> " + detail : "")}");
    if (!ok) failures.Add(label);
}

// ---------------------------------------------------------------------------------------------------
// One host, built twice: once without a customiser (the control) and once with one.
// ---------------------------------------------------------------------------------------------------
static async Task<(string periphery, string peripheryTwo, string decider)> RunAsync(int port, bool customise)
{
    var builder = WebApplication.CreateBuilder([]);
    builder.Logging.ClearProviders();
    builder.WebHost.UseUrls($"http://127.0.0.1:{port}");

    builder.Services.AddScoped<IValidator<CancelBooking>, CancelBookingValidator>();
    builder.Services.AddScoped<IValidator<CancelBookingTwice>, CancelBookingTwiceValidator>();

    if (customise)
    {
        builder.Services.AddProblemDetails(opts =>
        {
            opts.CustomizeProblemDetails = ctx =>
            {
                // Marker: proves whether this ran at all, which is the difference between
                // "fired but lost errors" and "never fired".
                ctx.ProblemDetails.Extensions["probeCustomiser"] = "fired";

                var first = FirstRuleName(ctx.ProblemDetails);
                if (first is not null) ctx.ProblemDetails.Title = first;
            };
        });
    }

    builder.Services.AddWolverineHttp();
    builder.Host.UseWolverine(opts =>
    {
        opts.UseFluentValidation(RegistrationBehavior.ExplicitRegistration);
        opts.Discovery.IncludeAssembly(typeof(CancelBooking).Assembly);
    });

    var app = builder.Build();
    app.MapWolverineEndpoints(opts => opts.UseFluentValidationProblemDetailMiddleware());

    await app.StartAsync();
    try
    {
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}") };

        var a = await client.PostAsJsonAsync("/periphery", new CancelBooking("b-1", ""));
        var b = await client.PostAsJsonAsync("/periphery-two", new CancelBookingTwice("", ""));
        var c = await client.PostAsJsonAsync("/decider", new CancelBooking("b-1", "customer changed mind"));

        return (await a.Content.ReadAsStringAsync(),
                await b.Content.ReadAsStringAsync(),
                await c.Content.ReadAsStringAsync());
    }
    finally
    {
        await app.StopAsync();
        await app.DisposeAsync();
    }
}

// Pull the rule name out of whichever shape the middleware produced. Both are tried because the
// middleware may build a ValidationProblemDetails or a plain ProblemDetails with an `errors` extension.
static string? FirstRuleName(ProblemDetails pd)
{
    if (pd is ValidationProblemDetails vpd && vpd.Errors.Count > 0)
        return vpd.Errors.Values.First().FirstOrDefault();

    if (pd.Extensions.TryGetValue("errors", out var raw))
    {
        if (raw is IDictionary<string, string[]> dict && dict.Count > 0)
            return dict.Values.First().FirstOrDefault();
        if (raw is IDictionary<string, object?> loose && loose.Count > 0 &&
            loose.Values.First() is IEnumerable<string> msgs)
            return msgs.FirstOrDefault();
    }
    return null;
}

static string? Str(JsonDocument d, string name) =>
    d.RootElement.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

static string? ErrorAt(JsonDocument d, string property) =>
    d.RootElement.TryGetProperty("errors", out var errs) && errs.ValueKind == JsonValueKind.Object &&
    errs.TryGetProperty(property, out var arr) && arr.ValueKind == JsonValueKind.Array && arr.GetArrayLength() > 0
        ? arr[0].GetString() : null;

static int ErrorCount(JsonDocument d) =>
    d.RootElement.TryGetProperty("errors", out var errs) && errs.ValueKind == JsonValueKind.Object
        ? errs.EnumerateObject().Count() : 0;

Console.WriteLine("\n=== 1. CONTROL — no ProblemDetails customiser. Does BP1's asymmetry reproduce? ===");
var (p0, p0two, d0) = await RunAsync(5199, customise: false);
Console.WriteLine($"  periphery  {p0}");
Console.WriteLine($"  decider    {d0}");

using var cp0 = JsonDocument.Parse(p0);
using var cd0 = JsonDocument.Parse(d0);

Check(ErrorAt(cp0, "Reason") == "ReasonRequired",
    "CONTROL: periphery carries the rule name in errors.Reason[0]", ErrorAt(cp0, "Reason") ?? "(absent)");
Check(Str(cp0, "title") != "ReasonRequired",
    "CONTROL: periphery title is NOT the rule name", Str(cp0, "title") ?? "(absent)");
Check(Str(cd0, "title") == "AlreadyCancelled",
    "CONTROL: decider carries the rule name in title", Str(cd0, "title") ?? "(absent)");
Check(!cd0.RootElement.TryGetProperty("errors", out _),
    "CONTROL: decider carries no errors");
Check(Str(cp0, "detail") is null,
    "CONTROL: periphery carries no detail", Str(cp0, "detail") ?? "(absent)");
var asymmetryReproduced = failures.Count == 0;

Console.WriteLine("\n=== 2. WITH a CustomizeProblemDetails that copies the first rule name into title ===");
var (p1, p1two, d1) = await RunAsync(5200, customise: true);
Console.WriteLine($"  periphery  {p1}");
Console.WriteLine($"  decider    {d1}");

using var cp1 = JsonDocument.Parse(p1);
using var cd1 = JsonDocument.Parse(d1);

var peripheryFired = cp1.RootElement.TryGetProperty("probeCustomiser", out _);
var deciderFired = cd1.RootElement.TryGetProperty("probeCustomiser", out _);
Console.WriteLine($"       customiser fired?  periphery={peripheryFired}  decider={deciderFired}");

Check(peripheryFired, "customiser FIRES on the FluentValidation middleware path");
Check(Str(cp1, "title") == "ReasonRequired",
    "periphery title is now the rule name", Str(cp1, "title") ?? "(absent)");
Check(ErrorAt(cp1, "Reason") == "ReasonRequired",
    "errors survived the customiser", ErrorAt(cp1, "Reason") ?? "(absent)");
Check(Str(cd1, "title") == "AlreadyCancelled",
    "decider title is unchanged", Str(cd1, "title") ?? "(absent)");

Console.WriteLine("\n=== 3. TWO periphery failures — does title take the first and errors keep both? ===");
Console.WriteLine($"  control    {p0two}");
Console.WriteLine($"  customised {p1two}");
using var ct0 = JsonDocument.Parse(p0two);
using var ct1 = JsonDocument.Parse(p1two);
Check(ErrorCount(ct0) == 2, "CONTROL: two failures produce two errors entries", $"{ErrorCount(ct0)}");
Check(ErrorCount(ct1) == 2, "customised: errors still holds BOTH failures", $"{ErrorCount(ct1)}");
// "first" is the validator's own RuleFor declaration order — FluentValidation returns failures in that
// order and the middleware's GroupBy/ToDictionary preserves it. Reason is declared first below.
Check(Str(ct1, "title") == "ReasonRequired",
    "customised: title holds the FIRST rule name, in validator declaration order", Str(ct1, "title") ?? "(absent)");
Check(ErrorAt(ct1, "BookingId") == "BookingIdRequired",
    "customised: the rule name NOT in title is still reachable in errors", ErrorAt(ct1, "BookingId") ?? "(absent)");

Console.WriteLine();
Console.WriteLine(asymmetryReproduced
    ? "CONTROL REPRODUCED BP1's ASYMMETRY — the comparison in step 2 is meaningful."
    : "*** CONTROL DID NOT REPRODUCE THE ASYMMETRY. BP1 IS SUSPECT; step 2 proves nothing. ***");
Console.WriteLine(failures.Count == 0
    ? "ALL CHECKS PASSED"
    : $"{failures.Count} FAILED: {string.Join(", ", failures)}");
return failures.Count == 0 ? 0 : 1;

// ---------------------------------------------------------------------------------------------------
// Types go after the top-level statements (CS8803), and must be public so Wolverine's runtime
// codegen can see them — top-level types in a file-based app are implicitly internal.
// ---------------------------------------------------------------------------------------------------

public record CancelBooking(string BookingId, string Reason);
public record CancelBookingTwice(string BookingId, string Reason);

public class CancelBookingValidator : AbstractValidator<CancelBooking>
{
    public CancelBookingValidator() => RuleFor(x => x.Reason).NotEmpty().WithMessage("ReasonRequired");
}

public class CancelBookingTwiceValidator : AbstractValidator<CancelBookingTwice>
{
    public CancelBookingTwiceValidator()
    {
        RuleFor(x => x.Reason).NotEmpty().WithMessage("ReasonRequired");
        RuleFor(x => x.BookingId).NotEmpty().WithMessage("BookingIdRequired");
    }
}

public static class RejectionEndpoints
{
    // THE PERIPHERY PATH — a real [WolverinePost] with a real IValidator attached, so the response is
    // written by Wolverine.Http.FluentValidation and not by anything this probe controls.
    [WolverinePost("/periphery")]
    public static IResult Periphery(CancelBooking cmd) => Results.NoContent();

    [WolverinePost("/periphery-two")]
    public static IResult PeripheryTwo(CancelBookingTwice cmd) => Results.NoContent();

    // THE DECIDER PATH — the shape Rejections.Problem produces today.
    [WolverinePost("/decider")]
    public static IResult Decider(CancelBooking cmd) =>
        Results.Problem(title: "AlreadyCancelled",
                        detail: $"Booking {cmd.BookingId} has already been cancelled.",
                        statusCode: 400);
}
