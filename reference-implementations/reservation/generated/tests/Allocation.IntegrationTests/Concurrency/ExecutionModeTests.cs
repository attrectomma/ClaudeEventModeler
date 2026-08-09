// Hand-written. Not generated from the model, and it must not be: the model says nothing about what wakes
// an automation, and the whole subject of this file is what wakes one.
#nullable enable

using Alba;
using JasperFx.CommandLine;
using Marten;
using Microsoft.Extensions.DependencyInjection;
using Allocation.Automation;
using Allocation.Contracts;
using Allocation.Slices.Allocation;
using Shouldly;
using Microsoft.AspNetCore.Hosting;
using Testcontainers.PostgreSql;
using Wolverine;
using Xunit;

namespace Allocation.IntegrationTests.Concurrency;

/// <summary>
/// THE OTHER HALF OF CH. 36, and the only place in this project where the book's most quotable sentence
/// about the pattern is put to the test:
///
///   > "Although it is modeled as Event, Read Model and Processor — the whole cycle of reservation and
///   >  execution can be done within one single web-request."
///
/// Every test in Slices/ drives IssueGrant itself, which is correct — that is the production path — and
/// says nothing about whether anything ever SENDS it. Each test here boots its OWN host with one mode on,
/// posts a reservation through the ordinary endpoint, and waits. NOBODY INVOKES THE TRIGGER. If a grant
/// appears, the mode woke it.
///
/// <c>CONTROL_with_no_mechanism_nothing_is_ever_executed</c> is why the other four mean anything: without
/// it, "in-request works" could just as well be "something else in the host happens to run the trigger".
///
/// [Collection("integration")] SERIALISES THESE WITH THE SHARED-HOST TESTS ON PURPOSE. The chosen mode is
/// static — the Configure hooks are static methods called from Program.cs, which is emit, so a mechanism
/// has nowhere per-host to live. Run in parallel, one host's Choose() lands between the shared host
/// resolving its own and registering its projections, and the shared host silently builds its views with
/// the wrong lifecycle. Measured in reference-implementations/automation/; a real project never meets it,
/// because it picks one mode and deletes the rest.
/// </summary>
[Collection("integration")]
public sealed class ExecutionModeTests : IAsyncLifetime
{
    // The image goes in the CONSTRUCTOR: the parameterless PostgreSqlBuilder() is obsolete (CS0618).
    private readonly PostgreSqlContainer _postgres =
        new PostgreSqlBuilder("postgres:16-alpine").WithDatabase("allocation_modes").Build();

    public Task InitializeAsync() => _postgres.StartAsync();
    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    private async Task<IAlbaHost> HostFor(string mode, bool todoViewAsync = false)
    {
        JasperFxEnvironment.AutoStartHost = true;
        return await AlbaHost.For<Program>(builder =>
        {
            builder.UseEnvironment("Testing");
            builder.ConfigureServices(services =>
            {
                services.RunWolverineInSoloMode();
                services.DisableAllExternalWolverineTransports();
            });
            builder.UseSetting("ConnectionStrings:Marten", _postgres.GetConnectionString());
            builder.UseSetting(IssueGrantWakeup.Setting, mode);
            builder.UseSetting(IssueGrantWakeup.TodoViewAsyncSetting, todoViewAsync ? "true" : "false");
        });
    }

    /// <summary>
    /// Every test mints its own pool. The generated Program.cs hard-codes DatabaseSchemaName, so hosts
    /// cannot be given separate schemas and rows accumulate across tests — the same limit the automation
    /// folder documents, worked around the same way.
    /// </summary>
    private static async Task<(Guid poolId, ReserveSlotEndpoint.Reserved reserved)> OpenAndReserve(
        IAlbaHost host, Guid grantId, int capacity = 3)
    {
        var poolId = Guid.NewGuid();

        await host.Scenario(x =>
        {
            x.Post.Json(new OpenPool(poolId, capacity)).ToUrl(OpenPoolEndpoint.Route);
            x.StatusCodeShouldBe(200);
        });

        var result = await host.Scenario(x =>
        {
            x.Post.Json(new ReserveSlot(poolId, grantId)).ToUrl($"/pools/{poolId}/reservations");
            x.StatusCodeShouldBe(200);
        });

        return (poolId, (await result.ReadAsJsonAsync<ReserveSlotEndpoint.Reserved>())!);
    }

    private static async Task<object[]> GrantEvents(IAlbaHost host, Guid grantId)
    {
        var store = host.Services.GetRequiredService<IDocumentStore>();
        await using var session = store.QuerySession();
        var raw = await session.Events.FetchStreamAsync(IssueGrantState.StreamKey(grantId.ToString()));
        return raw.Select(e => e.Data).ToArray();
    }

    private static async Task<object[]> SlotEvents(IAlbaHost host, Guid poolId, int slot)
    {
        var store = host.Services.GetRequiredService<IDocumentStore>();
        await using var session = store.QuerySession();
        var raw = await session.Events.FetchStreamAsync(ReserveSlotState.StreamKey(poolId, slot));
        return raw.Select(e => e.Data).ToArray();
    }

    private static async Task<T?> WaitFor<T>(Func<Task<object[]>> read, TimeSpan within) where T : class
    {
        var deadline = DateTimeOffset.UtcNow + within;
        while (DateTimeOffset.UtcNow < deadline)
        {
            var found = (await read()).OfType<T>().FirstOrDefault();
            if (found is not null) return found;
            await Task.Delay(100);
        }
        return null;
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // IN-REQUEST — the book's own sentence
    // ─────────────────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// NO WAITING AT ALL. The assertion runs the instant the reservation response returns, so if this
    /// passes, the execution happened inside the request. No daemon, no subscription, no clock.
    /// </summary>
    [Fact]
    public async Task InRequest_the_grant_is_issued_before_the_response_returns()
    {
        await using var host = await HostFor("in-request");
        var grantId = Guid.NewGuid();

        var (_, reserved) = await OpenAndReserve(host, grantId);

        var events = await GrantEvents(host, grantId);
        events.ShouldHaveSingleItem().ShouldBeOfType<GrantIssued>().SlotNumber.ShouldBe(reserved.SlotNumber);
    }

    /// <summary>
    /// THE COMPENSATING PATH, END TO END, with no gap. Reserve, the work refuses, the refusal is recorded,
    /// and the unit is back in the pool — all before the caller has an answer.
    ///
    /// TWO COMMITS, NOT ONE, and that is the distinction the whole pattern rests on. A single transaction
    /// spanning reserve and execute would make the reservation pointless: if the two can be atomic there is
    /// nothing to reserve AGAINST. So this runs them in order and compensates, which is why all three
    /// events exist on disk afterwards rather than none.
    /// </summary>
    [Fact]
    public async Task InRequest_a_refused_execution_gives_the_unit_back_in_the_same_request()
    {
        await using var host = await HostFor("in-request");

        var (poolId, reserved) = await OpenAndReserve(host, SeedData.RefusedGrant);

        (await GrantEvents(host, SeedData.RefusedGrant))
            .ShouldHaveSingleItem().ShouldBeOfType<GrantRefused>();

        var slot = await SlotEvents(host, poolId, reserved.SlotNumber);
        slot.Length.ShouldBe(2);
        slot[0].ShouldBeOfType<SlotReserved>();
        slot[1].ShouldBeOfType<SlotReleased>().Reason.ShouldBe(StandInGrantExecutor.RefusalReason);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // OUT OF REQUEST — the drawn shape
    // ─────────────────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// The reservation returns as soon as it commits and the execution happens later, woken by a Marten
    /// subscription reading the durable event stream. Nobody invoked anything.
    /// </summary>
    [Fact]
    public async Task Subscription_the_grant_is_issued_without_anybody_asking()
    {
        await using var host = await HostFor("subscription");
        var grantId = Guid.NewGuid();

        var (_, reserved) = await OpenAndReserve(host, grantId);

        var issued = await WaitFor<GrantIssued>(() => GrantEvents(host, grantId), TimeSpan.FromSeconds(20));
        issued.ShouldNotBeNull();
        issued!.SlotNumber.ShouldBe(reserved.SlotNumber);
    }

    /// <summary>
    /// THE FULL CHAIN OUT OF REQUEST, and it is the longest causal path in the folder: a reservation wakes
    /// the issuer, the issuer's refusal wakes the releaser, and the releaser gives the unit back. Two
    /// subscriptions, two todo lists, four events, and nothing in the request that started it.
    /// </summary>
    [Fact]
    public async Task Subscription_a_refused_execution_eventually_gives_the_unit_back()
    {
        await using var host = await HostFor("subscription");

        var (poolId, reserved) = await OpenAndReserve(host, SeedData.RefusedGrant);

        var released = await WaitFor<SlotReleased>(
            () => SlotEvents(host, poolId, reserved.SlotNumber), TimeSpan.FromSeconds(20));

        released.ShouldNotBeNull();
        released!.GrantId.ShouldBe(SeedData.RefusedGrant);
        (await GrantEvents(host, SeedData.RefusedGrant)).ShouldHaveSingleItem().ShouldBeOfType<GrantRefused>();
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // THE TWO CONTROLS
    // ─────────────────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// WITHOUT THIS THE FOUR ABOVE PROVE NOTHING. With no mode chosen the reservation still succeeds and
    /// the grant is never executed — so a slot sits held for ever with a clean log and a green suite.
    /// That is the shape of every "nothing ever wakes this" defect in the kit's history.
    /// </summary>
    [Fact]
    public async Task CONTROL_with_no_mechanism_nothing_is_ever_executed()
    {
        await using var host = await HostFor("false");
        var grantId = Guid.NewGuid();

        await OpenAndReserve(host, grantId);
        await Task.Delay(TimeSpan.FromSeconds(3));

        (await GrantEvents(host, grantId)).ShouldBeEmpty(
            "nothing chose a mechanism, so nothing may have executed the reservation");
    }

    /// <summary>
    /// THE REASON THE TODO VIEWS ARE INLINE, measured rather than argued — and it is deterministic rather
    /// than a race, which is what makes it worth having.
    ///
    /// Register them Async, as Marten's multi-stream guidance would, and run the in-request mode: the
    /// reservation commits, the request wakes the trigger, and the async daemon CANNOT have caught up
    /// inside that request — so the trigger reads an empty todo list, does nothing, and nothing ever wakes
    /// it again. The reservation is never executed and never compensated. A unit of a limited resource is
    /// gone, with a 200 response, a clean log and a green suite.
    ///
    /// This is Understanding EventSourcing ch. 32 exactly — "entries get lost if the processor was running
    /// before the model got updated" — and it is the kit's first executable demonstration of it. Flip
    /// ViewRegistrations back to Async and the four tests above start failing this way.
    /// </summary>
    [Fact]
    public async Task CONTROL_an_async_todo_view_silently_loses_the_work()
    {
        await using var host = await HostFor("in-request", todoViewAsync: true);
        var grantId = Guid.NewGuid();

        var (poolId, reserved) = await OpenAndReserve(host, grantId);

        // The reservation is real: the unit IS held.
        (await SlotEvents(host, poolId, reserved.SlotNumber))
            .ShouldHaveSingleItem().ShouldBeOfType<SlotReserved>();

        // The execution is not, and never will be. Waiting past the daemon's catch-up window changes
        // nothing, because nothing is left to wake the trigger a second time.
        await Task.Delay(TimeSpan.FromSeconds(5));

        (await GrantEvents(host, grantId)).ShouldBeEmpty(
            "the wakeup arrived before the Async todo view had the row, so the work was silently lost");
    }
}
