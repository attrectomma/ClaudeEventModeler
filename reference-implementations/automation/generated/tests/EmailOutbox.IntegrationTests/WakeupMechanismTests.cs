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
public sealed class WakeupMechanismTests : IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder()
        .WithImage("postgres:16-alpine")
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
    /// The other side of the boundary, and the one that makes the two above mean something: with no
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
    /// The two mechanisms not yet built fail LOUDLY. A wakeup that silently does nothing is the defect this
    /// whole folder documents, so an unimplemented one must not look like a working one.
    /// </summary>
    [Theory]
    [InlineData("subscription")]
    [InlineData("sideeffects")]
    public async Task UnimplementedMechanismsRefuseToStart(string mechanism)
    {
        var boot = async () => await HostFor(mechanism);
        await boot.ShouldThrowAsync<NotSupportedException>();
    }
}
