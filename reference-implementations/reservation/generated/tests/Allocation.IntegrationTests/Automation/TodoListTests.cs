// Hand-written. THE ONE TEST FILE THAT ASSERTS ON A TODO VIEW ON PURPOSE — see the class comment.
#nullable enable

using Microsoft.Extensions.DependencyInjection;
using Marten;
using Allocation.Contracts;
using Allocation.Slices.Allocation;
using Allocation.Views;
using Shouldly;
using Wolverine;
using Xunit;

namespace Allocation.IntegrationTests.Automation;

/// <summary>
/// THIS FILE EXISTS BECAUSE A MUTATION WENT UNCAUGHT, and the model had already asked the question.
///
/// `model.mjs validate` emits `derived-on-todo-view` for both of this system's todo lists, and it asks
/// exactly the right thing: *"would getting the fold wrong change which events appear, and would a GWT
/// catch that? If not, the missing scenario is an event one."* Measured rather than assumed — break
/// `SlotsToIssue.Apply(GrantIssued)` so a successful grant never ticks its row off, and **all 26 tests
/// still pass**.
///
/// And the note's own suggested remedy does not apply here, which is the interesting part. The fold being
/// wrong does NOT change which events appear: the row stays Pending, every later wakeup re-issues
/// IssueGrant, and `AlreadyIssued` refuses each one. The event stream is byte-identical. What actually
/// happens is a permanent, unbounded leak of wasted work — a call to the executor's decider on every
/// wakeup, for every grant ever issued, for ever.
///
/// So there IS no event-level scenario for it, and the honest answer is a test that asserts on the
/// machinery and says so. That is what these are. They are deliberately NOT in Slices/: a slice's contract
/// is its events, and nothing here is part of it.
/// </summary>
public sealed class TodoListTests(AppFixture fixture) : IntegrationContext(fixture)
{
    private static string SlotStream(int n) => ReserveSlotState.StreamKey(SeedData.PoolId, n);
    private static string GrantStream(Guid g) => IssueGrantState.StreamKey(g.ToString());

    private async Task RunIssuer()
    {
        using var scope = Host.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<IMessageBus>().InvokeAsync(new RunIssueGrant());
    }

    private async Task RunReleaser()
    {
        using var scope = Host.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<IMessageBus>().InvokeAsync(new RunReleaseSlot());
    }

    private async Task<T?> Row<T>(Guid grantId) where T : class
    {
        await using var session = Store.QuerySession();
        return await session.LoadAsync<T>(grantId);
    }

    /// <summary>
    /// A SUCCESSFUL EXECUTION TAKES ITS ROW OFF THE LIST. Without this the issuer works every grant it has
    /// ever issued on every wakeup, and nothing else in the suite notices.
    /// </summary>
    [Fact]
    public async Task An_issued_grant_is_off_the_issue_list()
    {
        await Given(SlotStream(1),
            new SlotReserved(SeedData.PoolId, 1, SeedData.AcceptedGrant, SeedData.SeededAt));

        (await Row<SlotsToIssue>(SeedData.AcceptedGrant))!.Status.ShouldBe(WorkStatus.Pending);

        await RunIssuer();

        (await Row<SlotsToIssue>(SeedData.AcceptedGrant))!.Status.ShouldBe(WorkStatus.Done);
    }

    /// <summary>
    /// A REFUSAL ALSO TAKES ITS ROW OFF THE ISSUE LIST — and puts one on the RELEASE list. Leaving it
    /// pending would make the issuer retry a refusal for ever, which is the exact loop a todo list exists
    /// to prevent, and it is the one direction the previous test cannot see.
    /// </summary>
    [Fact]
    public async Task A_refused_grant_moves_from_the_issue_list_to_the_release_list()
    {
        await Given(SlotStream(1),
            new SlotReserved(SeedData.PoolId, 1, SeedData.RefusedGrant, SeedData.SeededAt));

        await RunIssuer();

        (await Row<SlotsToIssue>(SeedData.RefusedGrant))!.Status.ShouldBe(WorkStatus.Done);

        var toRelease = await Row<SlotsToRelease>(SeedData.RefusedGrant);
        toRelease.ShouldNotBeNull();
        toRelease!.Status.ShouldBe(WorkStatus.Pending);
        toRelease.SlotNumber.ShouldBe(1);
        toRelease.Reason.ShouldBe(StandInGrantExecutor.RefusalReason);

        await RunReleaser();

        (await Row<SlotsToRelease>(SeedData.RefusedGrant))!.Status.ShouldBe(WorkStatus.Done);
    }

    /// <summary>
    /// IDEMPOTENT BY CONSTRUCTION, which ARCHITECTURE.md claims under `replay-safety` and nothing else
    /// makes executable. Running the whole cycle a second time changes no event and issues no command:
    /// both lists are empty, so the triggers have nothing to work.
    ///
    /// The load-bearing assertion is the EVENT COUNT, not the row status — a second run that re-issued and
    /// was refused by AlreadyIssued would leave the same statuses behind, and that is precisely the wasted
    /// work this is guarding against.
    /// </summary>
    [Fact]
    public async Task Running_both_triggers_again_does_nothing_at_all()
    {
        await Given(SlotStream(1),
            new SlotReserved(SeedData.PoolId, 1, SeedData.RefusedGrant, SeedData.SeededAt));

        await RunIssuer();
        await RunReleaser();

        var grantAfterFirst = (await EventsFor(GrantStream(SeedData.RefusedGrant))).Length;
        var slotAfterFirst = (await EventsFor(SlotStream(1))).Length;

        await RunIssuer();
        await RunReleaser();
        await RunIssuer();

        (await EventsFor(GrantStream(SeedData.RefusedGrant))).Length.ShouldBe(grantAfterFirst);
        (await EventsFor(SlotStream(1))).Length.ShouldBe(slotAfterFirst);

        await using var session = Store.QuerySession();
        (await session.Query<SlotsToIssue>().CountAsync(r => r.Status == WorkStatus.Pending)).ShouldBe(0);
        (await session.Query<SlotsToRelease>().CountAsync(r => r.Status == WorkStatus.Pending)).ShouldBe(0);
    }
}
