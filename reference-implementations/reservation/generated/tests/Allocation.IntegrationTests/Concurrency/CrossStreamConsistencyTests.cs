// Hand-written. Not generated from the model: nothing in an event model says whether a stream a command
// only READS may move under it.
#nullable enable

using Alba;
using JasperFx.CommandLine;
using JasperFx.Events;
using Marten;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Allocation.Automation;
using Allocation.Contracts;
using Allocation.Slices.Allocation;
using Shouldly;
using Testcontainers.PostgreSql;
using Wolverine;
using Wolverine.Marten;
using Xunit;

namespace Allocation.IntegrationTests.Concurrency;

/// <summary>
/// THE CROSS-STREAM READ, AND WHETHER IT IS ENFORCED. `issue-grant` appends to the Grant stream while only
/// READING the Slot stream, to confirm the unit is still held. Nothing about that read is protected by the
/// Grant stream's version — they are different streams and share no row.
///
/// `ARCHITECTURE.md` used to answer this with *"accept the window"*, reasoning that the only other writer to
/// the Slot stream is the compensation and it cannot run until this execution has refused. That is true of
/// the model and enforced by nothing, which is exactly the class of answer that is right until somebody adds
/// a slice. These two tests replace the reasoning with a measurement.
///
/// THE CONTROL IS THE UNGUARDED SHAPE, HAND-ROLLED. <c>AlwaysEnforceConsistency</c> is an attribute, so
/// "with and without" cannot be a runtime switch — and a second Wolverine handler was tried first and
/// abandoned: a handler declared in the TEST assembly is never discovered, because Wolverine scans the
/// application assembly, so the control silently did nothing and the test hung waiting for an executor
/// that was never called. Shipping an unguarded handler in production code to be able to test it would be
/// shipping the bug.
///
/// So the control reproduces what the code did BEFORE this conversion: two <c>FetchForWriting</c> calls, a
/// read of the second, and a save. That is the honest control for the hazard rather than for the attribute,
/// and it is the shape every hand-rolled decider in this kit used.
/// </summary>
[Collection("integration")]
public sealed class CrossStreamConsistencyTests : IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres =
        new PostgreSqlBuilder("postgres:16-alpine").WithDatabase("allocation_xstream").Build();

    public Task InitializeAsync() => _postgres.StartAsync();
    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    /// <summary>
    /// Blocks inside the WORK — which is the window that matters, because it sits after the middleware has
    /// fetched both streams and before it saves. No probe hook in production code was needed: the executor
    /// is already an injected seam, and a test that supplies its own is using the design rather than
    /// working around it.
    /// </summary>
    private sealed class GateExecutor : IGrantExecutor
    {
        public readonly TaskCompletionSource Reached = new();
        public readonly TaskCompletionSource Release = new();

        public async Task<GrantVerdict> Execute(Guid grantId, Guid poolId, int slotNumber, CancellationToken ct)
        {
            Reached.TrySetResult();
            await Release.Task;
            return GrantVerdict.Yes;
        }
    }

    private async Task<IAlbaHost> HostWith(GateExecutor executor, bool control)
    {
        JasperFxEnvironment.AutoStartHost = true;
        return await AlbaHost.For<Program>(builder =>
        {
            builder.UseEnvironment("Testing");
            builder.ConfigureServices(services =>
            {
                services.RunWolverineInSoloMode();
                services.DisableAllExternalWolverineTransports();
                // Last registration wins for GetRequiredService, so this replaces the stand-in.
                services.AddSingleton<IGrantExecutor>(executor);
            });
            builder.UseSetting("ConnectionStrings:Marten", _postgres.GetConnectionString());
            builder.UseSetting(IssueGrantWakeup.Setting, "false");

        });
    }

    /// <summary>
    /// Reserve a unit, start the execution, move the slot stream while the execution is in flight, then let
    /// it finish. Returns what the store holds for the grant afterwards.
    /// </summary>
    private async Task<object[]> RunWithTheSlotMovingUnderIt(bool control)
    {
        var executor = new GateExecutor();
        await using var host = await HostWith(executor, control);
        var store = host.Services.GetRequiredService<IDocumentStore>();

        var poolId = Guid.NewGuid();
        var grantId = Guid.NewGuid();

        await host.Scenario(x =>
        {
            x.Post.Json(new OpenPool(poolId, 3)).ToUrl(OpenPoolEndpoint.Route);
            x.StatusCodeShouldBe(200);
        });
        var reserved = await (await host.Scenario(x =>
        {
            x.Post.Json(new ReserveSlot(poolId, grantId)).ToUrl($"/pools/{poolId}/reservations");
            x.StatusCodeShouldBe(200);
        })).ReadAsJsonAsync<ReserveSlotEndpoint.Reserved>();

        var slotKey = ReserveSlotState.StreamKey(poolId, reserved!.SlotNumber);

        // THE INTERLEAVING, expressed the same way in both arms: somebody else releases the unit after the
        // decider has read it and before its transaction commits.
        async Task ReleaseTheSlot()
        {
            await using var session = store.LightweightSession();
            session.Events.Append(slotKey,
                new SlotReleased(poolId, reserved.SlotNumber, grantId, "released mid-flight", DateTimeOffset.UtcNow));
            await session.SaveChangesAsync();
        }

        if (control)
        {
            // THE UNGUARDED SHAPE, hand-rolled — two FetchForWriting calls, the second one only read.
            await using var session = store.LightweightSession();
            var grantStream = await session.Events.FetchForWriting<IssueGrantState>(
                IssueGrantState.StreamKey(grantId.ToString()));
            var slotState = await session.Events.FetchLatest<ReserveSlotState>(slotKey);

            slotState.ShouldNotBeNull();
            slotState!.Held.ShouldBeTrue("the control's precondition must hold, or it is not a control");

            await ReleaseTheSlot();          // ...and now the read is stale

            grantStream.AppendOne(new GrantIssued(grantId, poolId, reserved.SlotNumber, DateTimeOffset.UtcNow));
            await session.SaveChangesAsync();
        }
        else
        {
            var issuing = Task.Run(async () =>
            {
                using var scope = host.Services.CreateScope();
                var bus = scope.ServiceProvider.GetRequiredService<IMessageBus>();
                try
                {
                    await bus.InvokeAsync<SliceOutcome>(new IssueGrant(grantId, poolId, reserved.SlotNumber));
                    return "completed";
                }
                catch (Exception ex) { return ex.GetType().Name; }
            });

            await executor.Reached.Task.WaitAsync(TimeSpan.FromSeconds(30));
            await ReleaseTheSlot();
            executor.Release.SetResult();
            await issuing;
        }

        await using var query = store.QuerySession();
        var raw = await query.Events.FetchStreamAsync(IssueGrantState.StreamKey(grantId.ToString()));
        return raw.Select(e => e.Data).ToArray();
    }

    /// <summary>
    /// THE GUARD. Marten refuses the save because the stream the handler only READ has advanced —
    /// `EventStreamUnexpectedMaxEventIdException: expected 1 but was 2`. Wolverine's retry policy then
    /// re-runs it, the re-fetched slot is no longer held, and the ordinary SlotNotHeld rule refuses it.
    /// Either way no grant exists for a unit nobody holds.
    /// </summary>
    [Fact]
    public async Task a_grant_is_not_issued_against_a_slot_that_was_released_mid_flight()
    {
        (await RunWithTheSlotMovingUnderIt(control: false)).ShouldBeEmpty(
            "the slot was released while the execution was in flight, so the grant must not exist");
    }

    /// <summary>
    /// THE CONTROL, and it is green while asserting that the invariant BREAKS. Without
    /// AlwaysEnforceConsistency the identical interleaving commits: a grant exists against a unit that had
    /// already been handed back, and the pool can now be over-allocated by exactly one.
    ///
    /// If this ever starts failing, something else has begun protecting the read and the guarded test above
    /// no longer proves what it claims.
    /// </summary>
    [Fact]
    public async Task CONTROL_without_the_consistency_check_the_grant_is_issued_anyway()
    {
        (await RunWithTheSlotMovingUnderIt(control: true))
            .ShouldHaveSingleItem().ShouldBeOfType<GrantIssued>();
    }
}

