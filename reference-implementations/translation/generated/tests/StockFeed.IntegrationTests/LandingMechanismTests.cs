// Hand-written. Not generated from the model, and it must not be: the model says nothing about transport.
#nullable enable
using Alba;
using JasperFx.CommandLine;
using Marten;
// UseEnvironment is an extension on IWebHostBuilder and lives HERE, not in Microsoft.Extensions.Hosting.
// Same trap the generated AppFixture documents; a hand-written file does not inherit its usings.
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using StockFeed.Contracts;
using StockFeed.Landing;
using StockFeed.Slices.StockFeed;
using Shouldly;
using Testcontainers.PostgreSql;
using Wolverine;
using Wolverine.RDBMS.Transport;
using Xunit;

namespace StockFeed.IntegrationTests;

/// <summary>
/// THE ONE THING NO GENERATED TEST CAN ASSERT: that a foreign notice actually arrives, and then travels the whole
/// way to an event of ours, with nobody in this file asking for any of it.
///
/// Every other test in this project hands the notice to the translator itself, by putting
/// <see cref="StockNoticed"/> on the bus. That is right — it is the production path — and it means none of
/// them can tell you whether anything ever DELIVERS a notice. Nothing in the model or the generated code makes an
/// arrival happen, so a completely disconnected feed leaves the suite green.
///
/// Each test below boots its OWN host with one landing mechanism switched on, delivers a notice the way that
/// mechanism receives it, and waits. Nothing in the test puts a message on the bus, invokes the trigger, or
/// issues the command. If <see cref="StockLevelSet"/> appears, the whole chain is real.
///
/// THERE IS ONLY ONE THING TO BE ABSENT HERE, AND THAT IS A RESULT. The first version of this folder had two —
/// nothing ingesting, and nothing waking — because it appended the foreign notice as an event of ours and then woke
/// a trigger off it with a Marten subscription. Removing the append removed the second failure mode entirely: the
/// arrival IS the wakeup, so there is no separate mechanism left that can be silently missing.
/// </summary>
/// <remarks>
/// IN THE SAME COLLECTION as every other test here, which serialises it against them — a correctness requirement
/// and not tidiness. <see cref="StockFeedLanding.Chosen"/> is static, because Program.cs calls static hooks and
/// there is no per-host instance to hang a choice on. Run in a parallel collection, one of these hosts calls
/// Choose() while the shared host is still building, and assertions fail for reasons unrelated to what they test.
/// A real project never meets this: it picks one mechanism and deletes the rest.
/// </remarks>
[Collection("integration")]
public sealed class LandingMechanismTests : IAsyncLifetime
{
    // The image goes in the CONSTRUCTOR: the parameterless PostgreSqlBuilder() is obsolete (CS0618).
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:16-alpine")
        .WithDatabase("stockFeed_landing")
        .Build();

    public Task InitializeAsync() => _postgres.StartAsync();
    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    /// <summary>
    /// One host per mechanism. Note what is NOT here: <c>DisableAllExternalWolverineTransports()</c>, which the
    /// generated AppFixture calls unconditionally.
    ///
    /// THAT CALL IS WHY THESE TESTS CANNOT USE THE SHARED FIXTURE, and it is worth stating plainly because it is
    /// a structural point rather than an inconvenience: a translation's landing mechanism IS an external
    /// transport, and the generated harness switches every one of them off — in an <c>emit</c> file nobody may
    /// edit. So the harness the generator provides can never test the arrival half of the pattern. Filed as a
    /// finding.
    /// </summary>
    private async Task<IAlbaHost> HostFor(string landing)
    {
        JasperFxEnvironment.AutoStartHost = true;

        return await AlbaHost.For<Program>(builder =>
        {
            builder.UseEnvironment("Testing");      // keeps WarehouseDemoData out of the stub feed
            builder.ConfigureServices(services => services.RunWolverineInSoloMode());
            builder.UseSetting("ConnectionStrings:Marten", _postgres.GetConnectionString());
            builder.UseSetting(StockFeedLanding.Setting, landing);

            // NOTHING SETS A WAKEUP, and that is the point rather than an omission: on a 1:1 translation the
            // ARRIVAL is the wakeup. The notice lands in the durable inbox and StockTranslator is its handler.
            // The first version of this file had to switch a Marten subscription on here, because it appended the
            // foreign event and then woke a trigger off it.
        });
    }

    /// <summary>
    /// A product id per test. Every host here shares one database schema — the generated Program.cs hard-codes
    /// DatabaseSchemaName so <c>UseSetting</c> cannot separate them — so rows accumulate across tests and a
    /// query for "the outstanding row" could return somebody else's. Naming the stream makes each test
    /// independent without isolation the generator does not offer.
    /// </summary>
    private static StockNoticed Notice(Guid productId, long sequence = 1, int quantity = 12) =>
        new(productId, Guid.NewGuid(), quantity, sequence, new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));

    /// <summary>
    /// Polls rather than sleeping a fixed time. A mechanism that is merely SLOW and one that is broken look
    /// identical to a single sleep, and telling them apart is the entire point.
    /// </summary>
    private static async Task<StockLevelSet?> WaitForTranslation(IAlbaHost host, Guid productId, TimeSpan within)
    {
        var store = host.Services.GetRequiredService<IDocumentStore>();
        var deadline = DateTimeOffset.UtcNow + within;

        while (DateTimeOffset.UtcNow < deadline)
        {
            await using var session = store.QuerySession();
            var events = await session.Events.FetchStreamAsync(
                TranslateStockNoticeState.StreamKey(productId));
            var set = events.Select(x => x.Data).OfType<StockLevelSet>().FirstOrDefault();
            if (set is not null) return set;

            await Task.Delay(100);
        }

        return null;
    }

    /// <summary>
    /// A: WEBHOOK. The warehouse posts to us. Cheapest thing that works, and what most integrations are.
    ///
    /// The POST is the arrival — for this mechanism, the caller calling IS the mechanism, so simulating it
    /// faithfully means making the request. What the test does not do is anything else: no ingest, no trigger, no
    /// command. Everything after the 202 is the system's own doing.
    /// </summary>
    [Fact]
    public async Task AWebhookCallLandsAndIsTranslated()
    {
        var productId = Guid.NewGuid();
        await using var host = await HostFor("webhook");

        var notice = Notice(productId);
        await host.Scenario(x =>
        {
            x.Post.Json(notice).ToUrl("/feed/stock-notices");
            x.StatusCodeShouldBe(202);
        });

        var set = await WaitForTranslation(host, productId, TimeSpan.FromSeconds(15));

        set.ShouldNotBeNull();
        set.OnHand.ShouldBe(notice.Quantity);       // their quantity, our onHand
        set.NoticeId.ShouldBe(notice.NoticeId);
    }

    /// <summary>
    /// A, the other half: the warehouse posting the SAME notice twice must not produce two events. A black box
    /// that re-sends on reconnect makes this ordinary rather than exceptional, and a webhook has no transport
    /// dedupe to fall back on — nothing assigns an envelope id, so Wolverine's inbox never sees the repeat. The
    /// domain guard in the ingest handler is the only thing standing there.
    /// </summary>
    [Fact]
    public async Task AWebhookCallDeliveredTwiceLandsOnce()
    {
        var productId = Guid.NewGuid();
        await using var host = await HostFor("webhook");

        var notice = Notice(productId);
        for (var i = 0; i < 2; i++)
            await host.Scenario(x =>
            {
                x.Post.Json(notice).ToUrl("/feed/stock-notices");
                x.StatusCodeShouldBe(202);
            });

        (await WaitForTranslation(host, productId, TimeSpan.FromSeconds(15))).ShouldNotBeNull();

        var store = host.Services.GetRequiredService<IDocumentStore>();
        await using var session = store.QuerySession();
        var events = (await session.Events.FetchStreamAsync(TranslateStockNoticeState.StreamKey(productId)))
            .Select(x => x.Data).ToArray();

        // ONE event, and it is ours. The stream holds no StockNoticed at all — not one, not two — because the
        // warehouse's event is never appended. So this asserts the dedupe AND the non-persistence at once.
        events.Length.ShouldBe(1);
        events.OfType<StockLevelSet>().Count().ShouldBe(1);
    }

    /// <summary>
    /// B: EXTERNAL TABLE. The warehouse INSERTs a row into a table in our database and Wolverine polls it,
    /// durably, into its transactional inbox.
    ///
    /// <c>SendMessageThroughExternalTable</c> is Wolverine's own testing helper for exactly this — it writes the
    /// row the upstream system would write. It appears in no documentation page; found in the NuGet package's XML
    /// docs, described there as "Testing helper to publish a message to an externally controlled message table".
    /// Without it this mechanism would have to be tested by hand-writing SQL against a table whose column
    /// conventions are Wolverine's, which is a test of my SQL rather than of the mechanism.
    ///
    /// This is the mechanism that needs no cooperation from the far side beyond an INSERT, and the only one that
    /// is durable without us writing any durability code.
    /// </summary>
    [Fact]
    public async Task ARowTheWarehouseInsertsLandsAndIsTranslated()
    {
        var productId = Guid.NewGuid();
        await using var host = await HostFor("table");

        var notice = Notice(productId);
        await host.SendMessageThroughExternalTable(
            $"{StockFeedLanding.InboundSchema}.{StockFeedLanding.InboundTable}", notice, CancellationToken.None);

        // Longer than the webhook's: a poll has an interval, and the point of measuring is that this is the
        // price of the durability, not a defect.
        var set = await WaitForTranslation(host, productId, TimeSpan.FromSeconds(30));

        set.ShouldNotBeNull();
        set.OnHand.ShouldBe(notice.Quantity);
        set.NoticeId.ShouldBe(notice.NoticeId);
    }

    /// <summary>
    /// C: POLL. We call them, on a clock, remembering where we got to. The only option when the far side pushes
    /// nothing at all.
    ///
    /// The test publishes into the stub warehouse and then does nothing. Note what that means: unlike A and B,
    /// nothing has been handed to our process — the notice exists only on the far side, and the app has to go and
    /// ask. That is the mechanism's distinctive property in both directions: it can recover anything the far side
    /// still holds, and it cannot know about anything the far side has forgotten.
    /// </summary>
    [Fact]
    public async Task ANoticeSittingOnTheFarSideIsFetchedAndTranslated()
    {
        var productId = Guid.NewGuid();
        Environment.SetEnvironmentVariable("FEED_POLL_SECONDS", "1");
        try
        {
            await using var host = await HostFor("poll");

            var warehouse = (InMemoryWarehouseFeed)host.Services.GetRequiredService<IWarehouseFeed>();
            var notice = Notice(productId, sequence: DateTimeOffset.UtcNow.Ticks);
            warehouse.Publish(notice);

            var set = await WaitForTranslation(host, productId, TimeSpan.FromSeconds(30));

            set.ShouldNotBeNull();
            set.OnHand.ShouldBe(notice.Quantity);
        }
        finally
        {
            Environment.SetEnvironmentVariable("FEED_POLL_SECONDS", null);
        }
    }

    /// <summary>
    /// THE CONTROL, and without it none of the four above means anything.
    ///
    /// A host with no landing mechanism must translate nothing, because the only alternative explanation for the
    /// tests above — "something else in the host happens to ingest notices" — has to be ruled out. It also asserts
    /// the asymmetry the webhook has and the other two do not: the route still EXISTS with no mechanism chosen,
    /// because Wolverine.HTTP discovers it whatever configuration says, so not choosing a webhook can only be
    /// expressed by the webhook refusing.
    /// </summary>
    [Fact]
    public async Task WithNoMechanismNothingEverLands()
    {
        var productId = Guid.NewGuid();
        await using var host = await HostFor("none");

        await host.Scenario(x =>
        {
            x.Post.Json(Notice(productId)).ToUrl("/feed/stock-notices");
            x.StatusCodeShouldBe(503);
        });

        var warehouse = (InMemoryWarehouseFeed)host.Services.GetRequiredService<IWarehouseFeed>();
        warehouse.Publish(Notice(productId, sequence: 2));

        (await WaitForTranslation(host, productId, TimeSpan.FromSeconds(5))).ShouldBeNull();
    }
}
