// Hand-written. Not generated from the model, and it must not be: the model says nothing about transport.
#nullable enable
using Alba;
using JasperFx.CommandLine;
using Marten;
using Marten.Schema;
using Microsoft.Extensions.DependencyInjection;
using EmailOutbox.Automation;
using EmailOutbox.Contracts;
using EmailOutbox.Slices.EmailOutbox;
using Shouldly;
using Testcontainers.PostgreSql;
using Wolverine;
using Xunit;

namespace EmailOutbox.IntegrationTests;

/// <summary>
/// THE ONE THING NO GENERATED TEST CAN ASSERT: that something wakes the trigger without being asked.
///
/// Every other test in this project drives <c>RunSendEmail</c> itself, which is correct — it exercises the
/// production path — but it says nothing about whether anything sends that message in production. That gap
/// is how an automation shipped once with no way to run, passing six tests.
///
/// So each test here boots its OWN host with one mechanism switched on, posts an email through the ordinary
/// endpoint, and then waits. Nobody invokes the trigger. If <c>EmailSent</c> appears, the mechanism woke it.
///
/// These are deliberately kept out of the shared fixture: a doorbell or a clock running inside the shared
/// host would append events into streams the other tests are asserting on, and every GIVEN would become a
/// race. That is the real reason a clock must be absent in tests — not the timer itself.
/// </summary>
/// <remarks>
/// IN THE SAME COLLECTION as every other test here, which serialises it against them — and that is a
/// correctness requirement, not tidiness.
///
/// The chosen mechanism is static (the Configure hooks are static methods called from Program.cs, so there
/// is no per-host instance to hang it on). Run in a PARALLEL collection, one of these hosts calls Choose()
/// in between the shared host resolving its own choice and registering its projections — so the shared host
/// built EmailsToSend as Async and every inline row assertion in the GWT tests failed. Two tests broke in a
/// way that had nothing to do with what they were testing.
///
/// A real project never meets this: it picks ONE mechanism and deletes the rest, so nothing mutates. It is a
/// cost of keeping four side by side in one project for comparison, and worth knowing before copying this
/// shape into anything real.
/// </remarks>
[Collection("integration")]
public sealed class WakeupMechanismTests : IAsyncLifetime
{
    // The image goes in the CONSTRUCTOR: the parameterless PostgreSqlBuilder() is obsolete (CS0618).
    // Hand-written file, so the generator's own fix does not reach it.
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:16-alpine")
        .WithDatabase("emailOutbox_wakeup")
        .Build();

    public Task InitializeAsync() => _postgres.StartAsync();
    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    /// <summary>One host per mechanism, each in its own schema so they cannot see each other.</summary>
    private async Task<IAlbaHost> HostFor(string mechanism)
    {
        JasperFxEnvironment.AutoStartHost = true;

        return await AlbaHost.For<Program>(builder =>
        {
            builder.ConfigureServices(services =>
            {
                services.RunWolverineInSoloMode();
                services.DisableAllExternalWolverineTransports();
            });
            builder.UseSetting("ConnectionStrings:Marten", _postgres.GetConnectionString());
            builder.UseSetting(SendEmailWakeup.Setting, mechanism);
        });
    }

    /// <summary>
    /// The emailId is passed IN, not discovered. Every host in this class shares one database schema — the
    /// generated Program.cs hard-codes DatabaseSchemaName, so it cannot be overridden per host — which means
    /// rows accumulate across tests and a Query&lt;EmailsToSend&gt;().FirstAsync() can return somebody else's
    /// email. Naming the id makes each test independent of the others without needing isolation the
    /// generator does not offer.
    ///
    /// The endpoint honours a supplied id and mints one only when it is empty, so this stays the ordinary
    /// path rather than a test-only door.
    /// </summary>
    private static async Task Compose(IAlbaHost host, Guid emailId) =>
        await host.Scenario(x =>
        {
            x.Post.Json(new PrepareEmail(emailId, "someone@example.com", "Subject", "Body"))
                .ToUrl(PrepareEmailEndpoint.Route);
            x.StatusCodeShouldBe(204);
        });

    /// <summary>
    /// Polls for the event rather than sleeping a fixed time. A mechanism that is merely SLOW and one that is
    /// broken look identical to a single sleep, and the whole point here is to tell them apart.
    /// </summary>
    private static async Task<EmailSent?> WaitForSend(IAlbaHost host, Guid emailId, TimeSpan within)
    {
        var store = host.Services.GetRequiredService<IDocumentStore>();
        var deadline = DateTimeOffset.UtcNow + within;

        while (DateTimeOffset.UtcNow < deadline)
        {
            await using var session = store.QuerySession();
            var events = await session.Events.FetchStreamAsync(SendEmailState.StreamKey(emailId));
            var sent = events.Select(x => x.Data).OfType<EmailSent>().FirstOrDefault();
            if (sent is not null) return sent;

            await Task.Delay(100);
        }

        return null;
    }

    /// <summary>
    /// A: EVENT FORWARDING. Our own EmailPrepared is pushed through Wolverine's outbox on commit to a
    /// handler that only says "go look". Immediate, no polling, no daemon — and available only because the
    /// trigger event is ours.
    /// </summary>
    [Fact]
    public async Task ForwardingWakesTheTrigger()
    {
        var emailId = Guid.NewGuid();
        await using var host = await HostFor("forwarding");

        await Compose(host, emailId);

        // Nobody invoked RunSendEmail. The only thing that happened is a human composing an email.
        var sent = await WaitForSend(host, emailId, TimeSpan.FromSeconds(10));

        sent.ShouldNotBeNull();
        sent!.EmailId.ShouldBe(emailId);
        sent.ProviderMessageId.ShouldNotBeNullOrWhiteSpace();
    }

    /// <summary>
    /// D: SWEEP. A clock sends the run message on an interval, and the trigger recomputes its work from the
    /// View each time. Woken here at a 1s interval; production would be minutes.
    ///
    /// This is the mechanism that works regardless of who appended the triggering event, or whether there
    /// was one — which is exactly why it is the only option for a foreign or time-driven trigger.
    /// </summary>
    [Fact]
    public async Task SweepWakesTheTrigger()
    {
        Environment.SetEnvironmentVariable("AUTOMATION_SWEEP_SECONDS", "1");
        try
        {
            var emailId = Guid.NewGuid();
            await using var host = await HostFor("sweep");

            await Compose(host, emailId);
            var sent = await WaitForSend(host, emailId, TimeSpan.FromSeconds(15));

            sent.ShouldNotBeNull();
            sent!.EmailId.ShouldBe(emailId);
        }
        finally
        {
            Environment.SetEnvironmentVariable("AUTOMATION_SWEEP_SECONDS", null);
        }
    }

    /// <summary>
    /// B: MARTEN SUBSCRIPTION. The async daemon pushes committed events at the subscription, in order, with a
    /// durable checkpoint — and the subscription rings the same doorbell.
    ///
    /// Note what it does NOT cost, unlike C: the todo View stays Inline, updated in the append's own
    /// transaction, so the row is already committed by the time the daemon hands over the event.
    /// </summary>
    [Fact]
    public async Task SubscriptionWakesTheTrigger()
    {
        var emailId = Guid.NewGuid();
        await using var host = await HostFor("subscription");

        await Compose(host, emailId);

        var sent = await WaitForSend(host, emailId, TimeSpan.FromSeconds(30));

        sent.ShouldNotBeNull();
        sent!.EmailId.ShouldBe(emailId);
    }

    /// <summary>
    /// B's DISTINCTIVE CLAIM, and the only property no other mechanism here has: it catches up on a backlog.
    ///
    /// The email is prepared while NO mechanism is running — the doorbell that forwarding depends on is never
    /// rung, and that delivery is simply gone. A subscription starts from its own checkpoint, so a host that
    /// comes up later processes what it missed.
    ///
    /// This is the difference between "wakes on live traffic" and "eventually processes everything", and it is
    /// the reason to accept the daemon rather than take the cheaper doorbell.
    /// </summary>
    [Fact]
    public async Task SubscriptionCatchesUpOnEventsItWasNotRunningFor()
    {
        var emailId = Guid.NewGuid();

        // Prepared with nothing listening. Forwarding would have lost this one for good.
        await using (var quiet = await HostFor("none"))
        {
            await Compose(quiet, emailId);
            (await WaitForSend(quiet, emailId, TimeSpan.FromSeconds(2))).ShouldBeNull();
        }

        // A new host, subscription on, and nobody composes anything. The only work available is the backlog.
        await using var listening = await HostFor("subscription");

        var sent = await WaitForSend(listening, emailId, TimeSpan.FromSeconds(30));
        sent.ShouldNotBeNull();
    }

    /// <summary>
    /// C: PROJECTION SIDE EFFECTS. The todo View publishes the run message itself when a row turns Pending,
    /// so the wakeup is a property of the read model rather than of anything outside it.
    ///
    /// Async, not Inline — Marten calls RaiseSideEffects only during continuous asynchronous projection
    /// processing unless side effects on Inline projections are explicitly enabled, and documents that switch
    /// as a late addition for one client. So this mechanism drags in the async daemon and makes the todo View
    /// eventually consistent, which is why this test waits longer than the other two.
    /// </summary>
    [Fact]
    public async Task SideEffectsWakeTheTrigger()
    {
        var emailId = Guid.NewGuid();
        await using var host = await HostFor("sideeffects");

        await Compose(host, emailId);

        // Longer window on purpose: the append commits, the daemon then picks the event up, updates the row
        // and publishes. Nothing here is in the request's transaction.
        var sent = await WaitForSend(host, emailId, TimeSpan.FromSeconds(30));

        sent.ShouldNotBeNull();
        sent!.EmailId.ShouldBe(emailId);
    }

    /// <summary>
    /// The other side of the boundary, and the one that makes the others mean something: with no
    /// mechanism selected, nothing sends anything. Without this, "forwarding works" could just as well be
    /// "something else in the host happens to run the trigger".
    /// </summary>
    [Fact]
    public async Task WithNoMechanismNothingIsEverSent()
    {
        var emailId = Guid.NewGuid();
        await using var host = await HostFor("none");

        await Compose(host, emailId);

        (await WaitForSend(host, emailId, TimeSpan.FromSeconds(3))).ShouldBeNull();

        // …and the work is still there waiting, which is what makes a sweep able to pick it up later.
        var store = host.Services.GetRequiredService<IDocumentStore>();
        await using var session = store.QuerySession();
        var row = await session.LoadAsync<Views.EmailsToSend>(SendEmailState.StreamKey(emailId));
        row!.Status.ShouldBe(Views.EmailsToSend.Pending);
    }

    /// <summary>
    /// All four are implemented now, so what is left to pin is the FALLBACK: an unrecognised setting means no
    /// wakeup at all, not a default one. Silently falling back to some mechanism would hide a typo in
    /// configuration behind a working automation — and the whole subject of this folder is wakeups that are
    /// not what they appear to be.
    /// </summary>
    [Theory]
    [InlineData("")]
    [InlineData("forwardng")]
    [InlineData("cron")]
    public async Task AnUnrecognisedSettingMeansNoWakeupAtAll(string setting)
    {
        var emailId = Guid.NewGuid();
        await using var host = await HostFor(setting);

        await Compose(host, emailId);

        (await WaitForSend(host, emailId, TimeSpan.FromSeconds(2))).ShouldBeNull();
    }
}
